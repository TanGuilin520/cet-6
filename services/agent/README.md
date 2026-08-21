# CET LangGraph agent runtime

This optional Python 3.11 sidecar adds a bounded, auditable Agent workflow
without changing the existing Python 3.8 PDF reader server. It exposes two
graphs:

- `POST /v1/tutor`: route a question, read only the supplied question/answer
  context, retrieve question-ID evidence before vector supplements, draft a
  reply, and run a grounding guard.
- `POST /v1/review/suggest`: inspect one existing review issue and return only
  field-level `proposals`. It cannot apply a review patch or write exam data.

The runtime deliberately has no shell, filesystem, browser, arbitrary URL, or
database-write tool. Evidence is untrusted data and is available only through
the request body supplied by the main CET server. Deterministic OCR, grading,
revision publication, and ETag checks remain in the main application.

LangGraph is imported lazily. Importing `services.agent.app` under the current
Python 3.8 server is safe, but `/healthz` reports `not_ready` there. A ready
runtime requires Python 3.11+, LangGraph, and a writable SQLite checkpoint. It
does not silently fall back to an in-memory checkpointer.

Official references:

- <https://docs.langchain.com/oss/python/langgraph/overview>
- <https://docs.langchain.com/oss/python/langgraph/persistence>
- <https://docs.langchain.com/oss/python/langgraph/interrupts>

## Local run

From the repository root:

```bash
python3.11 -m venv .venv-agent
.venv-agent/bin/python -m pip install -r services/agent/requirements.txt
mkdir -p data/agent
CET_AGENT_CHECKPOINT_PATH="$PWD/data/agent/checkpoints.sqlite3" \
  .venv-agent/bin/python -m services.agent.app
```

The default endpoint is `http://127.0.0.1:8770`. Configure the main CET server
to use the same loopback endpoint. Keep the service on loopback unless a
Bearer token, firewall, and TLS termination are in place.

Supported environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CET_AGENT_HOST` | `127.0.0.1` | Bind address |
| `CET_AGENT_PORT` | `8770` | Bind port |
| `CET_AGENT_TOKEN` | empty | Optional shared Bearer token |
| `CET_AGENT_CHECKPOINT_PATH` | `/data/agent-checkpoints.sqlite3` | Required writable SQLite checkpoint |
| `CET_AGENT_CHECKPOINT_MAX_THREADS` | `50` | Retain only the newest graph runs, including failed runs (1–10000) |
| `DEEPSEEK_API_KEY` | empty | Optional grounded reply drafting |
| `CET_AGENT_DEEPSEEK_URL` | DeepSeek HTTPS chat-completions endpoint | Model endpoint |
| `CET_AGENT_DEEPSEEK_MODEL` | `deepseek-chat` | Model name |
| `CET_AGENT_DEEPSEEK_TIMEOUT_SECONDS` | `25` | Model timeout, bounded to 1–120 seconds |

Without `DEEPSEEK_API_KEY`, both graphs still run. Tutor replies fall back to a
conservative evidence summary and explicitly refuse to guess when official
material is absent. A failed model request also falls back instead of turning
untrusted context into an answer.

Completed graph states are checkpointed for recent-run inspection, but the
database is not an unlimited conversation archive. The runtime deletes graph
threads older than `CET_AGENT_CHECKPOINT_MAX_THREADS`; browser question history
and immutable review revisions remain owned by the main application.

## Docker

From the repository root, the hardened local Compose profile is the shortest
way to start the sidecar. It binds port 8770 only on loopback and persists the
SQLite checkpoint in a named volume:

```bash
docker-compose -f docker-compose.agent.yml up --build -d
```

The equivalent direct Docker commands are:

The Docker build context is this directory, not the repository root:

```bash
docker build -t cet-agent services/agent
docker run --rm -p 127.0.0.1:8770:8770 \
  -v cet-agent-checkpoints:/data \
  -e CET_AGENT_TOKEN=replace-with-a-long-random-value \
  -e DEEPSEEK_API_KEY \
  cet-agent
```

The image runs as an unprivileged user and keeps checkpoints in the mounted
`/data` volume. Do not put API keys into the image or commit them to Git.

## Health contract

`GET /healthz` always returns HTTP 200 after authorization. Consumers must
check `ready`, not only the HTTP status:

```json
{
  "schemaVersion": "cet-agent-health/1",
  "service": "cet-agent-runtime",
  "status": "ok",
  "ready": true,
  "engine": "langgraph",
  "pythonVersion": "3.11.9",
  "langgraphImportReady": true,
  "checkpointReady": true,
  "deepseekConfigured": false,
  "detail": "LangGraph and SQLite checkpoint are ready"
}
```

If Python, LangGraph, configuration, or the SQLite checkpoint is unavailable,
`status` is `not_ready`, `ready` is false, and inference endpoints return 503.

## Tutor contract

The top-level object and every evidence object use exact schemas. The `context`
is assembled by the trusted CET server from one pinned `reviewRevision`:

```json
{
  "examId": "exam-20250821-012345abcdef",
  "questionId": "q26",
  "reviewRevision": 3,
  "message": "为什么不能选 A？",
  "userAnswer": "A",
  "history": [],
  "context": {
    "question": {
      "questionId": "q26",
      "number": 26,
      "type": "single_choice",
      "stem": "Which statement is supported?",
      "options": [
        {"label": "A", "text": "..."},
        {"label": "C", "text": "..."}
      ]
    },
    "officialAnswer": {
      "questionId": "q26",
      "answer": "C",
      "explanation": "The passage states ...",
      "source": "answer_pdf"
    },
    "evidence": {
      "exact": [
        {"questionId": "q26", "kind": "official_explanation", "content": "26. C. The passage states ..."}
      ],
      "vector": []
    },
    "officialExplanationFound": true,
    "disclaimer": "",
    "policy": "question_id_exact_then_vector_context"
  }
}
```

The response includes a persisted `threadId`, safe node names rather than
hidden chain-of-thought, the read-only tools used, citations, and the existing
grounding fields:

```json
{
  "schemaVersion": "cet-agent-tutor/1",
  "runId": "b8e0...",
  "threadId": "b8e0...",
  "status": "completed",
  "examId": "exam-20250821-012345abcdef",
  "questionId": "q26",
  "reviewRevision": 3,
  "reply": "上传的答案资料记录为 C。...",
  "intent": "option_explanation",
  "tools": [{"name": "get_current_question", "status": "completed"}],
  "citations": [{"source": "rag:exact:official_explanation", "questionId": "q26", "excerpt": "26. C. The passage states ..."}],
  "grounding": {
    "status": "official",
    "officialEvidenceFound": true,
    "disclaimerRequired": false,
    "officialExplanationFound": true,
    "exactMatches": 1,
    "vectorMatches": 0,
    "disclaimer": "",
    "retrievalOrder": ["question_id_exact", "deterministic_vector_supplement"]
  },
  "trace": {
    "nodes": ["route_intent", "read_context_tools", "retrieve_grounded_evidence", "draft_grounded_reply", "grounding_guard", "finalize_tutor"],
    "durationMs": 8
  }
}
```

## Review-suggestion contract

The request is one server-created issue plus bounded review context:

```json
{
  "examId": "exam-20250821-012345abcdef",
  "reviewRevision": 3,
  "issue": {
    "issueId": "answer-review:q26",
    "kind": "answer_review",
    "targetId": "q26",
    "message": "答案绑定需要人工复核",
    "severity": "manualReview",
    "page": 5
  },
  "context": {
    "question": {"questionId": "q26", "stem": "..."},
    "answer": {"questionId": "q26", "answer": "C", "parserConfidence": 0.84},
    "nearbyQuestions": [],
    "answerConflicts": [],
    "page": null,
    "evidence": {
      "exact": [{"questionId": "q26", "kind": "official_answer", "content": "26. C"}],
      "vector": []
    },
    "policy": "suggest_only_human_approval_required"
  }
}
```

The response cannot be submitted to the existing review PATCH endpoint. It is
a separate proposal schema intended only to prefill the review form:

```json
{
  "schemaVersion": "cet-agent-review-suggestion/1",
  "runId": "78c4...",
  "threadId": "78c4...",
  "status": "completed",
  "policy": "suggest_only",
  "examId": "exam-20250821-012345abcdef",
  "reviewRevision": 3,
  "issueId": "answer-review:q26",
  "proposals": [
    {
      "op": "replace",
      "entity": "answer",
      "questionId": "q26",
      "field": "answer",
      "value": "C",
      "confidence": 0.84,
      "evidenceSources": ["rag:exact:official_answer"]
    }
  ],
  "rationale": "找到与问题题号一致的受限上下文证据，已生成一项待人工确认的替换建议。",
  "evidence": [{"source": "rag:exact:official_answer", "questionId": "q26", "excerpt": "26. C"}],
  "cautions": ["建议尚未写入；必须由人工复核工作台确认并通过当前 revision/ETag 发布。"],
  "trace": {
    "nodes": ["load_review_issue", "retrieve_review_evidence", "build_suggest_only_proposal", "suggestion_policy_guard", "finalize_review_suggestion"],
    "durationMs": 5
  }
}
```

Only the current `issue.targetId` can appear in a proposal. Allowed question
fields are `stem`, `type`, `page`, `bbox`, and `options`; allowed answer fields
are `answer` and `explanation`. The first version generates only conservative
`stem` or `answer` proposals. Empty `proposals` is the expected result when
evidence is insufficient.
