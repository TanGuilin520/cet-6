from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = PROJECT_ROOT / "tools" / "run_agent_evals.py"
SPEC = importlib.util.spec_from_file_location("cet_agent_evals", SCRIPT_PATH)
assert SPEC and SPEC.loader
agent_evals = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(agent_evals)


class AgentEvalHarnessTests(unittest.TestCase):
    def test_origin_keeps_only_the_http_origin(self) -> None:
        self.assertEqual(
            agent_evals._origin("http://127.0.0.1:8770/"),
            "http://127.0.0.1:8770",
        )

    def test_golden_cases_are_unique_and_cover_safety_paths(self) -> None:
        cases = agent_evals.load_cases(PROJECT_ROOT / "evals" / "agent_cases.jsonl")
        ids = {case["caseId"] for case in cases}

        self.assertEqual(len(ids), len(cases))
        self.assertGreaterEqual(len(cases), 5)
        self.assertTrue(any(case["expect"].get("intent") == "unsupported_mutation" for case in cases))
        self.assertTrue(any(case["expect"].get("disclaimerRequired") is True for case in cases))
        self.assertTrue(any(case["expect"].get("proposalCount") == 0 for case in cases))
        self.assertEqual({case["endpoint"] for case in cases}, {
            "/v1/tutor", "/v1/review/suggest",
        })

    def test_evaluator_rejects_missing_grounding_and_unsafe_review_operation(self) -> None:
        cases = agent_evals.load_cases(PROJECT_ROOT / "evals" / "agent_cases.jsonl")
        tutor_case = next(case for case in cases if case["endpoint"] == "/v1/tutor")
        tutor_failures = agent_evals.evaluate_response(tutor_case, {
            "schemaVersion": "cet-agent-tutor/1",
            "status": "completed",
            "examId": tutor_case["request"]["examId"],
            "questionId": tutor_case["request"]["questionId"],
            "reviewRevision": tutor_case["request"]["reviewRevision"],
            "intent": tutor_case["expect"]["intent"],
            "reply": "unsupported",
            "tools": [],
            "citations": [],
            "grounding": {},
            "trace": {"nodes": [], "durationMs": 1},
        })
        self.assertTrue(tutor_failures)

        review_case = next(
            case for case in cases
            if case["endpoint"] == "/v1/review/suggest" and case["expect"]["proposalCount"] == 1
        )
        review_failures = agent_evals.evaluate_response(review_case, {
            "schemaVersion": "cet-agent-review-suggestion/1",
            "status": "completed",
            "policy": "suggest_only",
            "examId": review_case["request"]["examId"],
            "reviewRevision": review_case["request"]["reviewRevision"],
            "proposals": [{"op": "delete", "entity": "answer", "field": "answer"}],
            "rationale": "unsafe",
            "trace": {"nodes": review_case["expect"]["requiredNodes"], "durationMs": 1},
        })
        self.assertIn("review returned a non-replace proposal", review_failures)


if __name__ == "__main__":
    unittest.main()
