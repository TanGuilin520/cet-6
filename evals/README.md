# Agent Evals

`agent_cases.jsonl` contains synthetic, copyright-safe golden cases for the
LangGraph sidecar. The suite checks deterministic behavior around intent
routing, exact-answer grounding, read-only policy, citations, and review
proposal safety. It is deliberately separate from unit tests so the same
cases can compare prompt, model, and retrieval changes.

Validate the fixture without running a sidecar:

```bash
python3 tools/run_agent_evals.py --validate-only
```

Run the suite against a configured local runtime:

```bash
CET_AGENT_URL=http://127.0.0.1:8770 \
CET_AGENT_TOKEN='与sidecar相同的Token' \
python3 tools/run_agent_evals.py
```

Use `--json` to produce a machine-readable report suitable for CI. A failed
case exits with status 1; an invalid fixture or invocation exits with status
2. The report includes pass rate and P50/P95 latency. It does not print API
keys or hidden model reasoning.
