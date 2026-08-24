from __future__ import annotations

from io import BytesIO
import json
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from services.agent import app as agent_app
from services.agent.app import (
    AgentApplication,
    AgentHandler,
    AgentRuntime,
    RequestError,
    _fallback_tutor_reply,
    _guard_review,
    classify_intent,
    propose_review_proposals,
    rank_evidence,
    validate_review_request,
    validate_tutor_request,
)


def tutor_request():
    return {
        "examId": "exam-20250821-012345abcdef",
        "questionId": "q26",
        "reviewRevision": 3,
        "message": "为什么不能选 A？",
        "userAnswer": "A",
        "history": [{"role": "user", "content": "请结合答案资料"}],
        "context": {
            "question": {
                "questionId": "q26",
                "number": 26,
                "type": "single_choice",
                "stem": "Which statement is supported?",
                "options": [
                    {"label": "A", "text": "Distractor"},
                    {"label": "C", "text": "Supported"},
                ],
                "bbox": {"x": 10, "y": 20, "width": 300, "height": 100},
            },
            "officialAnswer": {
                "questionId": "q26",
                "answer": "C",
                "explanation": "The passage supports C.",
                "source": "answer_pdf",
            },
            "evidence": {
                "exact": [
                    {
                        "questionId": "q26",
                        "kind": "official_explanation",
                        "content": "26. C. The passage supports C.",
                    }
                ],
                "vector": [
                    {
                        "questionId": "q27",
                        "kind": "explanation",
                        "content": "A high scoring but different question.",
                        "score": 0.99,
                    }
                ],
            },
            "officialExplanationFound": True,
            "disclaimer": "",
            "policy": "question_id_exact_then_vector_context",
        },
    }


def review_request():
    return {
        "examId": "exam-20250821-012345abcdef",
        "reviewRevision": 3,
        "issue": {
            "issueId": "answer-review:q26",
            "kind": "answer_review",
            "targetId": "q26",
            "message": "答案绑定需要人工复核",
            "severity": "manualReview",
            "page": 5,
        },
        "context": {
            "question": {"questionId": "q26", "stem": "Which statement is supported?"},
            "answer": {
                "questionId": "q26",
                "answer": "C",
                "parserConfidence": 0.84,
                "reviewRequired": True,
            },
            "nearbyQuestions": [{"questionId": "q25", "stem": "Previous"}],
            "answerConflicts": [],
            "page": {"number": 5, "width": 595, "height": 842, "words": []},
            "evidence": {
                "exact": [
                    {"questionId": "q26", "kind": "official_answer", "content": "26. C"}
                ],
                "vector": [],
            },
            "policy": "suggest_only_human_approval_required",
        },
    }


class AgentContractTests(unittest.TestCase):
    def test_tutor_request_is_normalized_and_preserves_bounded_platform_fields(self):
        result = validate_tutor_request(tutor_request())

        self.assertEqual(result["questionId"], "q26")
        self.assertEqual(result["context"]["question"]["bbox"]["width"], 300)
        self.assertEqual(
            result["context"]["evidence"]["exact"][0]["source"],
            "rag:exact:official_explanation",
        )

    def test_tutor_request_rejects_unknown_fields_and_cross_question_context(self):
        extra = tutor_request()
        extra["prompt"] = "bypass"
        with self.assertRaisesRegex(RequestError, "unsupported fields"):
            validate_tutor_request(extra)

        mismatched = tutor_request()
        mismatched["context"]["officialAnswer"]["questionId"] = "q27"
        with self.assertRaisesRegex(RequestError, "does not match"):
            validate_tutor_request(mismatched)

    def test_evidence_score_must_be_finite_and_policy_is_fixed(self):
        invalid_score = tutor_request()
        invalid_score["context"]["evidence"]["vector"][0]["score"] = float("nan")
        with self.assertRaisesRegex(RequestError, "between 0 and 1"):
            validate_tutor_request(invalid_score)

        invalid_policy = tutor_request()
        invalid_policy["context"]["policy"] = "vector_first"
        with self.assertRaisesRegex(RequestError, "policy is invalid"):
            validate_tutor_request(invalid_policy)

    def test_intent_router_cannot_authorize_mutations(self):
        self.assertEqual(classify_intent("请修改答案并发布修改"), "unsupported_mutation")
        self.assertEqual(classify_intent("Why is option A wrong?"), "option_explanation")

    def test_question_id_evidence_ranks_ahead_of_high_vector_score(self):
        evidence = [
            {
                "source": "rag:vector:background",
                "questionId": "q27",
                "kind": "background",
                "text": "why option A",
                "score": 1.0,
            },
            {
                "source": "rag:exact:official_answer",
                "questionId": "q26",
                "kind": "official_answer",
                "text": "26 C",
            },
        ]
        ranked = rank_evidence(evidence, "q26", "why option A")
        self.assertEqual(ranked[0]["questionId"], "q26")

    def test_fallback_refuses_to_guess_without_an_answer(self):
        request = validate_tutor_request(tutor_request())
        request["context"]["officialAnswer"] = None
        reply = _fallback_tutor_reply(
            {"request": request, "intent": "answer_explanation"}
        )
        self.assertIn("为避免猜测", reply)
        self.assertNotIn("正确答案是", reply)

    def test_review_request_produces_only_a_form_proposal(self):
        request = validate_review_request(review_request())
        citations = [
            {
                "source": "rag:exact:official_answer",
                "questionId": "q26",
                "excerpt": "26. C",
            }
        ]
        proposals, rationale, cautions = propose_review_proposals(request, citations)

        self.assertEqual(
            proposals,
            [
                {
                    "op": "replace",
                    "entity": "answer",
                    "questionId": "q26",
                    "field": "answer",
                    "value": "C",
                    "confidence": 0.84,
                    "evidenceSources": ["rag:exact:official_answer"],
                }
            ],
        )
        self.assertIn("待人工确认", rationale)
        self.assertIn("尚未写入", cautions[0])

    def test_review_policy_guard_removes_cross_question_or_unknown_fields(self):
        state = {
            "request": validate_review_request(review_request()),
            "proposals": [
                {
                    "op": "replace",
                    "entity": "answer",
                    "questionId": "q27",
                    "field": "answer",
                    "value": "A",
                    "confidence": 1.0,
                    "evidenceSources": ["untrusted"],
                },
                {
                    "op": "replace",
                    "entity": "question",
                    "questionId": "q26",
                    "field": "script",
                    "value": "bad",
                    "confidence": 1.0,
                    "evidenceSources": ["untrusted"],
                },
            ],
            "cautions": [],
            "trace_nodes": [],
        }
        guarded = _guard_review(state)
        self.assertEqual(guarded["proposals"], [])
        self.assertIn("安全门", guarded["cautions"][0])

    def test_checkpoint_retention_keeps_only_the_newest_threads(self):
        class Checkpointer:
            def __init__(self):
                self.deleted = []

            def delete_thread(self, thread_id):
                self.deleted.append(thread_id)

        with TemporaryDirectory() as temporary:
            runtime = AgentRuntime(checkpoint_path=Path(temporary) / "checkpoints.sqlite3")
            runtime.max_checkpoint_threads = 2
            runtime._connection = sqlite3.connect(":memory:")
            runtime._connection.execute(
                "CREATE TABLE cet_agent_threads ("
                "thread_id TEXT PRIMARY KEY, created_at_ns INTEGER NOT NULL)"
            )
            runtime._checkpointer = Checkpointer()
            with patch.object(agent_app.time, "time_ns", side_effect=[1, 2, 3]):
                runtime._retain_checkpoint_thread("thread-1")
                runtime._retain_checkpoint_thread("thread-2")
                runtime._retain_checkpoint_thread("thread-3")
            remaining = runtime._connection.execute(
                "SELECT thread_id FROM cet_agent_threads ORDER BY created_at_ns"
            ).fetchall()
            runtime._connection.close()

        self.assertEqual(remaining, [("thread-2",), ("thread-3",)])
        self.assertEqual(runtime._checkpointer.deleted, ["thread-1"])

    def test_invalid_checkpoint_retention_configuration_is_not_ready(self):
        with TemporaryDirectory() as temporary, patch.dict(
            agent_app.os.environ,
            {"CET_AGENT_CHECKPOINT_MAX_THREADS": "unbounded"},
        ):
            runtime = AgentRuntime(checkpoint_path=Path(temporary) / "checkpoints.sqlite3")
            with patch.object(agent_app.sys, "version_info", (3, 11, 9)):
                runtime.initialize()

        self.assertFalse(runtime.ready)
        self.assertIn("CET_AGENT_CHECKPOINT_MAX_THREADS", runtime.detail)


class FakeRuntime:
    def __init__(self, ready=True):
        self.ready = ready
        self.detail = "test runtime ready" if ready else "test runtime unavailable"
        self.langgraph_import_ready = ready
        self.checkpoint_ready = ready
        self.deepseek = SimpleNamespace(configured=False)

    def invoke_tutor(self, request):
        return {
            "schemaVersion": "cet-agent-tutor/1",
            "runId": "run-test",
            "threadId": "run-test",
            "status": "completed",
            "examId": request["examId"],
            "questionId": request["questionId"],
            "reviewRevision": request["reviewRevision"],
            "reply": "test",
            "intent": "option_explanation",
            "tools": [],
            "citations": [],
            "grounding": {
                "status": "official",
                "officialEvidenceFound": True,
                "disclaimerRequired": False,
                "officialExplanationFound": True,
                "exactMatches": 1,
                "vectorMatches": 0,
                "disclaimer": "",
                "retrievalOrder": ["question_id_exact", "deterministic_vector_supplement"],
            },
            "trace": {"nodes": ["test"], "durationMs": 1},
        }

    def invoke_review(self, request):
        raise AssertionError("not used")


class HandlerHarness(AgentHandler):
    """Exercise the real handler contract without opening a sandbox socket."""

    def __init__(self, path, headers=None, body=b""):
        self.path = path
        self.headers = dict(headers or {})
        self.rfile = BytesIO(body)
        self.wfile = BytesIO()
        self.response_status = None
        self.response_headers = {}

    def send_response(self, code, message=None):
        self.response_status = code

    def send_header(self, keyword, value):
        self.response_headers[keyword] = value

    def end_headers(self):
        return

    def log_message(self, format, *args):
        return

    def log_error(self, format, *args):
        return

    def document(self):
        return json.loads(self.wfile.getvalue().decode("utf-8"))


def call_handler(application, method, path, body=b"", headers=None):
    request_headers = dict(headers or {})
    if method == "POST" and "Content-Length" not in request_headers:
        request_headers["Content-Length"] = str(len(body))
    handler = HandlerHarness(path, request_headers, body)
    with patch.object(agent_app, "APPLICATION", application):
        if method == "GET":
            handler.do_GET()
        else:
            handler.do_POST()
    return handler


class AgentHTTPTests(unittest.TestCase):
    def test_health_requires_optional_bearer_and_has_readiness_fields(self):
        application = AgentApplication(token="health-secret", runtime=FakeRuntime())
        unauthorized = call_handler(application, "GET", "/healthz")
        self.assertEqual(unauthorized.response_status, 401)

        response = call_handler(
            application,
            "GET",
            "/healthz",
            headers={"Authorization": "Bearer health-secret"},
        )
        document = response.document()

        self.assertEqual(response.response_status, 200)
        self.assertEqual(document["schemaVersion"], agent_app.HEALTH_SCHEMA)
        self.assertTrue(document["ready"])
        self.assertTrue(document["checkpointReady"])

    def test_tutor_http_endpoint_validates_then_dispatches(self):
        application = AgentApplication(runtime=FakeRuntime())
        body = json.dumps(tutor_request(), ensure_ascii=False).encode("utf-8")
        response = call_handler(
            application,
            "POST",
            "/v1/tutor",
            body=body,
            headers={"Content-Type": "application/json"},
        )
        document = response.document()

        self.assertEqual(response.response_status, 200)
        self.assertEqual(document["schemaVersion"], "cet-agent-tutor/1")
        self.assertEqual(document["questionId"], "q26")

    def test_handler_rejects_unknown_input_and_oversized_content_length(self):
        application = AgentApplication(runtime=FakeRuntime())
        invalid = tutor_request()
        invalid["tools"] = ["shell"]
        body = json.dumps(invalid).encode("utf-8")
        invalid_response = call_handler(
            application,
            "POST",
            "/v1/tutor",
            body=body,
            headers={"Content-Type": "application/json"},
        )
        invalid_document = invalid_response.document()
        self.assertEqual(invalid_response.response_status, 400)
        self.assertEqual(invalid_document["error"]["code"], "invalid_request")

        oversized = call_handler(
            application,
            "POST",
            "/v1/tutor",
            body=b"{}",
            headers={
                "Content-Type": "application/json",
                "Content-Length": str(agent_app.MAX_REQUEST_BYTES + 1),
            },
        )
        self.assertEqual(oversized.response_status, 413)

    def test_pre_311_interpreter_reports_not_ready_without_importing_langgraph(self):
        with TemporaryDirectory() as temporary:
            runtime = AgentRuntime(checkpoint_path=Path(temporary) / "checkpoints.sqlite3")
            application = AgentApplication(runtime=runtime)
            with patch.object(agent_app.sys, "version_info", (3, 8, 10)):
                document = application.health_document()

        self.assertEqual(document["status"], "not_ready")
        self.assertFalse(document["ready"])
        self.assertFalse(document["langgraphImportReady"])
        self.assertFalse(document["checkpointReady"])


class LangGraphRuntimeSmokeTests(unittest.TestCase):
    """Compile and invoke the real graphs when LangGraph is installed.

    CI installs services/agent/requirements.txt on Python 3.11 and runs this
    class explicitly.  Without LangGraph the whole class is skipped so the
    plain stdlib test run stays dependency-free.
    """

    def langgraph_available(self):
        try:
            import langgraph.graph  # noqa: F401
            import langgraph.checkpoint.sqlite  # noqa: F401
        except ImportError:
            self.skipTest("LangGraph is not installed in this environment")

    def test_real_tutor_graph_compiles_and_invokes_with_deterministic_fallback(self):
        self.langgraph_available()
        with TemporaryDirectory() as temporary:
            runtime = AgentRuntime(checkpoint_path=Path(temporary) / "checkpoints.sqlite3")
            self.assertTrue(runtime.ready, runtime.detail)
            document = runtime.invoke_tutor(validate_tutor_request(tutor_request()))

        self.assertEqual(document["status"], "completed")
        self.assertEqual(
            document["trace"]["nodes"],
            [
                "route_intent",
                "read_context_tools",
                "retrieve_grounded_evidence",
                "draft_grounded_reply",
                "grounding_guard",
                "finalize_tutor",
            ],
        )
        self.assertIn("C", document["reply"])

    def test_real_review_graph_compiles_and_stays_suggest_only(self):
        self.langgraph_available()
        with TemporaryDirectory() as temporary:
            runtime = AgentRuntime(checkpoint_path=Path(temporary) / "checkpoints.sqlite3")
            self.assertTrue(runtime.ready, runtime.detail)
            document = runtime.invoke_review(validate_review_request(review_request()))

        self.assertEqual(document["policy"], "suggest_only")
        self.assertNotIn("generation", document)
        self.assertEqual(
            document["trace"]["nodes"],
            [
                "load_review_issue",
                "retrieve_review_evidence",
                "build_suggest_only_proposal",
                "suggestion_policy_guard",
                "finalize_review_suggestion",
            ],
        )


if __name__ == "__main__":
    unittest.main()
