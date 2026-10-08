from __future__ import annotations

import unittest
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory

from tests.test_agent_evals import agent_evals, PROJECT_ROOT
from services.agent.app import validate_tutor_request, validate_review_request


class AgentV1EvalTests(unittest.TestCase):
    def test_sixty_cases_have_unique_ids_and_strict_validated_context(self):
        cases = agent_evals.load_cases(PROJECT_ROOT / "evals" / "agent_v1_cases.jsonl")
        self.assertEqual(len(cases), 60)
        self.assertEqual(len({case["caseId"] for case in cases}), 60)
        for case in cases:
            if case["endpoint"] == "/v1/tutor":
                validate_tutor_request(case["request"])
            else:
                validate_review_request(case["request"])

    def test_unverifiable_citation_is_detected_not_claimed_faithful(self):
        case = agent_evals.load_cases(PROJECT_ROOT / "evals" / "agent_v1_cases.jsonl")[0]
        response = {"citations": [{"excerpt": "invented evidence"}], "generation": {"usage": None}}
        metrics = agent_evals.response_metrics(case, response)
        self.assertEqual(metrics["citationCount"], 1)
        self.assertEqual(metrics["sourceMatched"], 0)
        self.assertIsNone(metrics["tokenUsage"])

    def test_personal_method_title_prefix_is_a_valid_source_excerpt(self):
        case = {"request": {"context": {"learningEvidence": [{"title": "随着", "text": "先确定主谓结构"}]}}, "expect": {}}
        response = {"citations": [{"excerpt": "随着：先确定主谓结构"}], "generation": {"usage": {"totalTokens": 20}}}
        metrics = agent_evals.response_metrics(case, response)
        self.assertEqual(metrics["sourceMatched"], 1)
        self.assertEqual(metrics["tokenUsage"]["totalTokens"], 20)

    def test_offline_eval_cannot_inherit_a_real_key_or_call_upstream(self):
        with TemporaryDirectory() as temporary, patch.dict("os.environ", {"DEEPSEEK_API_KEY": "must-not-be-used"}), \
             patch("services.agent.app.urlopen", side_effect=AssertionError("offline eval must be zero network")):
            runtime = agent_evals.offline_runtime(Path(temporary) / "checkpoints.sqlite3")
            try:
                self.assertFalse(runtime.deepseek.key_present)
                case = agent_evals.load_cases(PROJECT_ROOT / "evals" / "agent_v1_cases.jsonl")[0]
                response, _elapsed = agent_evals.offline_case(runtime, case)
                self.assertFalse(response["generation"]["attempted"])
                self.assertEqual(agent_evals.evaluate_response(case, response), [])
            finally:
                runtime.close()


if __name__ == "__main__":
    unittest.main()
