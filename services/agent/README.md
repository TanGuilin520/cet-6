# CET LangGraph runtime v1

An optional Python 3.11 sidecar for bounded, question-scoped tutoring and
suggest-only review. Main PDF/OCR, deterministic grading, immutable revision
publication and native reader remain unchanged.

## Run locally

Explicitly install optional dependencies once:

```bash
python3.11 -m venv .venv-agent
.venv-agent/bin/python -m pip install -r services/agent/requirements.txt
bash tools/start.sh
```

The managed launcher reads existing environment/project `.env`, starts a local
Agent when dependencies are installed, then the original main server. It shares
a launch-local random token unless configured, without editing `.env`, installing
packages, downloading models or calling an LLM. It reuses a ready same-token local
runtime, never takes over an occupied port, and stops only children it created.
`CET_MANAGED_AGENT=0` opts out; explicit `CET_AGENT_URL` is left operator-managed.

Manual sidecar mode does NOT automatically load project `.env`:

```bash
CET_AGENT_TOKEN='replace-with-a-long-random-token' \
CET_AGENT_CHECKPOINT_PATH="$PWD/data/agent/checkpoints.sqlite3" \
DEEPSEEK_API_KEY='your-optional-key' \
.venv-agent/bin/python -m services.agent.app --host 127.0.0.1 --port 8770
```

Configure the same `CET_AGENT_URL / CET_AGENT_TOKEN` for the main server, then use
`.venv-main/bin/python -m server` (manual main-only entry). Missing Key still
permits deterministic context retrieval and conservative responses. Health
checks do not call the provider or prove credentials/balance/teaching quality.

Docker remains optional:

```bash
docker-compose -f docker-compose.agent.yml up --build -d
```

It binds 8770 only on loopback, runs unprivileged, and persists checkpoints in a
volume. Shared token/loopback are not a public authentication/tenant scheme.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `CET_AGENT_HOST / CET_AGENT_PORT` | `127.0.0.1 / 8770` | Sidecar bind |
| `CET_AGENT_TOKEN` | empty in manual mode | Shared service authorization; required for persistent conversation requests and explicit memory clearing |
| `CET_AGENT_CHECKPOINT_PATH` | `/data/agent-checkpoints.sqlite3` | Writable SQLite checkpoint/memory path |
| `CET_AGENT_CHECKPOINT_MAX_THREADS` | `50` | Bound retained Runs/conversations, adjustable 1–10000 |
| `DEEPSEEK_API_KEY` | empty | Optional provider key |
| `CET_AGENT_DEEPSEEK_URL` | official HTTPS chat-completions | Validated model endpoint |
| `CET_AGENT_DEEPSEEK_MODEL` | `deepseek-v4-flash` | Overrides `DEEPSEEK_MODEL`; pro optional, retired aliases mapped |
| `CET_AGENT_DEEPSEEK_TIMEOUT_SECONDS` | `25` | Per-call timeout; dynamic total budget is also enforced |

Main transport timeout (`CET_AGENT_TIMEOUT_SECONDS`, default 40s) should exceed
the sidecar's bounded dynamic invocation (30s). Main direct general/selection
calls do not pass through LangGraph.

## Actual tool loop

`question` requests with usable model configuration execute:

```text
route_intent → model_decision → execute_context_tools → model_decision
                    └── final / stopped ──→ grounding_guard → finalize
```

Six context-only tools:
`get_current_question`, `get_answer_record`, `retrieve_evidence`,
`retrieve_methods`, `retrieve_personal_notes`, `compare_options`.

Tools read ONLY the bounded, revision-pinned context supplied by the main
server. They cannot shell, browse, fetch arbitrary URLs, scan local files, write
database/exam answers or publish revisions. The model can choose/order tools,
ask follow-ups or return a final Markdown reply. Evidence/summary is untrusted
data, not instructions. A next-step hint does not expose a full reference answer
through answer/evidence tools.

Maximum 4 decision rounds, 12 tool calls, 30 seconds and approximately 8,000
tokens; input estimates and provider usage are advisory protection, NOT a bill
ceiling. Each provider output is bounded. Invalid/duplicate calls, elapsed time,
budgets and cancellation stop the loop. No-key/mutation requests use the original
deterministic route. Upstream/protocol failure cannot silently trigger a second
model path in the main server.

## Endpoints and contracts

| Endpoint | Behaviour |
| --- | --- |
| `GET /healthz` | Authorized readiness only, never calls DeepSeek |
| `POST /v1/tutor` | Validated question-scoped tutor |
| `POST /v1/tutor/stream` | Same tutor with real node/tool progress and final result |
| `POST /v1/conversations/clear` | Explicit authenticated conversation/checkpoint clearing |
| `POST /v1/review/suggest` | Deterministic read-only proposals; never a review PATCH |

Health schema is `cet-agent-health/2`, service `cet-agent-runtime`. A 200 response
alone is insufficient: check `ready`, LangGraph/checkpoint readiness and
`deepseekConfigured` separately. `streaming / dynamicTools / memory` describe
capabilities; memory is not advertised without a shared token. Readiness imports
LangGraph lazily and requires writable persistent SQLite, not a silent in-memory
checkpointer. Credentials and raw upstream errors are never returned.

Tutor preserves `cet-agent-tutor/2` and accepts optional bounded
`requestId / conversationId`. Main context includes current question,
officialAnswer, exact/vector evidence, disclaimer/policy and optional authorized
learningContext/learningEvidence. Object fields/IDs/lengths are strictly checked.
Legacy schema compatibility remains in the main client.

The response retains reply, citations, safe trace, intent, generation and
adds optional execution/memory metadata:

```json
{
  "execution": {
    "mode": "dynamic_tools",
    "rounds": 2,
    "toolCalls": 3,
    "stopReason": "final",
    "budget": {"maxRounds": 4, "maxToolCalls": 12, "maxTokens": 8000, "maxSeconds": 30}
  },
  "memory": {
    "enabled": true,
    "conversationId": "opaque-client-id",
    "turns": 2,
    "summaryPresent": false,
    "scopeReset": false
  }
}
```

This snippet is NOT a full tutor response. `generation.used=true` means a
successful provider-generated reply; usage is reported only when available,
and unknown usage is not zero cost. No hidden chain-of-thought is exposed.

SSE carries safe progress and a terminal whole Markdown response, NOT provider
token-by-token generation. Cancellation is cooperative: subsequent tools/saving
can stop, but an already-sent model request may still complete and be billed.

## Memory and privacy

Stable conversations are independent from fresh per-Run graph checkpoints.
Memory identity pins exam/question/conversation; scope pins revision, current
question/answer, private consent and private body content. Changed scope removes
old memory/checkpoints before any history is reused. Persistent requests ignore
client history to prevent reintroducing revoked personal material.

Keep at most 6 recent turns, 2,000 characters per message, with an extractive
1,200-character older summary. No extra summarization model request is made;
summary is not authoritative evidence. Defaults retain at most 50 Runs and 50
conversations. Explicit clear deletes corresponding checkpoints, records a
bounded cancellation tombstone and prevents older queued/in-flight requests
from restoring cleared data. New browser conversation/revoked consent retains
pending-delete markers when server deletion cannot be confirmed.

This remains local single-user data, without account login, tenant isolation,
cloud synchronization or backup erasure.

## Retrieval and review boundaries

Actual hybrid search belongs to `server/retrieval.py`: exact ID priority,
BM25/hash baseline, optional offline local dense/RRF/reranker. This sidecar
retrieves only its approved evidence pack, not the full source database.
See [optional local embeddings](../embeddings/README.md). Private note vectors
are never persisted; current distribution includes no semantic model weights.

Review graph remains `suggest_only`, without model calls or writes. Only current
issue target and allowlisted question/answer fields can be proposed. User must
apply to the form, verify original PDF and publish through ETag/revision logic.
No LangGraph interrupt/resume approval API is claimed.

## Verification

```bash
env DEEPSEEK_API_KEY= CET_AGENT_URL= CET_EMBEDDING_URL= .venv-agent/bin/python -m unittest discover -s tests -v
.venv-agent/bin/python tools/run_agent_evals.py --cases evals/agent_v1_cases.jsonl --offline --min-pass-rate 1 --json
```

The 60 synthetic offline cases exercise real LangGraph without a paid key.
Mechanical source-text matches and answer markers are NOT semantic entailment,
teaching quality or real-model evaluation. See [eval methodology](../../evals/README.md)
and [Chinese architecture](../../docs/agent-architecture.md).

Official framework reference: [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)
and [persistence](https://docs.langchain.com/oss/python/langgraph/persistence).
