from __future__ import annotations

import hashlib
import io
import json
import os
import threading
import unittest
from http import HTTPStatus
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock
from urllib.parse import urlparse

import server.platform as platform_module
from server.agent_client import (
    AgentClient,
    AgentProtocolError,
    AgentUnavailable,
)
from server.platform import PlatformAPI, PlatformService, _atomic_json
from services.agent.app import validate_review_request, validate_tutor_request


EXAM_ID = "exam-20260821-abcdef123456"


def tutor_response(**changes):
    document = {
        "schemaVersion": "cet-agent-tutor/1",
        "runId": "run-123",
        "threadId": "thread-123",
        "status": "completed",
        "examId": EXAM_ID,
        "questionId": "q1",
        "reviewRevision": 4,
        "reply": "Evidence-grounded reply.",
        "intent": "explain_answer",
        "tools": [{"name": "get_question", "status": "completed"}],
        "citations": [{
            "source": "official_answer",
            "questionId": "q1",
            "page": 2,
            "excerpt": "1. A",
        }],
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
        "trace": {"nodes": ["load_context", "answer"], "durationMs": 12},
    }
    document.update(changes)
    return document


def review_response(**changes):
    document = {
        "schemaVersion": "cet-agent-review-suggestion/1",
        "runId": "run-review",
        "threadId": "thread-review",
        "status": "completed",
        "policy": "suggest_only",
        "examId": EXAM_ID,
        "reviewRevision": 4,
        "issueId": "question-review:q1",
        "proposals": [{
            "op": "replace",
            "entity": "question",
            "questionId": "q1",
            "field": "stem",
            "value": "Corrected stem",
            "confidence": 0.91,
            "evidenceSources": ["paper-page-1"],
        }],
        "rationale": "The coordinate evidence supports this correction.",
        "evidence": [{
            "source": "paper-page-1",
            "questionId": "q1",
            "page": 1,
            "excerpt": "Corrected stem",
        }],
        "cautions": ["Human approval is required."],
        "trace": {"nodes": ["review"], "durationMs": 8},
    }
    document.update(changes)
    return document


class FakeResponse:
    def __init__(self, document, content_type="application/json; charset=utf-8") -> None:
        self.document = document
        self.headers = {"Content-Type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, maximum):
        return json.dumps(self.document).encode("utf-8")


class AgentClientTests(unittest.TestCase):
    def tutor_payload(self):
        return {
            "examId": EXAM_ID,
            "questionId": "q1",
            "reviewRevision": 4,
            "message": "Why A?",
            "userAnswer": "B",
            "history": [{"role": "user", "content": "Earlier question"}],
            "context": {"question": {"questionId": "q1"}},
        }

    def test_tutor_sends_bearer_token_timeout_and_exact_body(self) -> None:
        captured = {}

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["headers"] = dict(request.header_items())
            captured["body"] = json.loads(request.data.decode("utf-8"))
            captured["timeout"] = timeout
            return FakeResponse(tutor_response())

        client = AgentClient(
            endpoint="http://127.0.0.1:8790",
            token="agent-secret",
            timeout_seconds=7.5,
        )
        with mock.patch("server.agent_client.urlopen", side_effect=fake_urlopen):
            response = client.tutor(self.tutor_payload())

        self.assertEqual(captured["url"], "http://127.0.0.1:8790/v1/tutor")
        self.assertEqual(captured["headers"]["Authorization"], "Bearer agent-secret")
        self.assertEqual(captured["headers"]["Content-type"], "application/json")
        self.assertEqual(captured["timeout"], 7.5)
        self.assertEqual(captured["body"], self.tutor_payload())
        self.assertEqual(response["questionId"], "q1")
        self.assertEqual(response["citations"][0]["page"], 2)

    def test_tutor_rejects_unknown_fields_and_revision_mismatch(self) -> None:
        client = AgentClient(endpoint="http://127.0.0.1:8790")
        with mock.patch(
            "server.agent_client.urlopen",
            return_value=FakeResponse(tutor_response(reviewRevision=5)),
        ):
            with self.assertRaisesRegex(AgentProtocolError, "revision"):
                client.tutor(self.tutor_payload())

        invalid = tutor_response(unexpected="not allowed")
        with mock.patch("server.agent_client.urlopen", return_value=FakeResponse(invalid)):
            with self.assertRaisesRegex(AgentProtocolError, "schema"):
                client.tutor(self.tutor_payload())

    def test_transport_timeout_is_reported_as_optional_runtime_unavailable(self) -> None:
        client = AgentClient(endpoint="http://127.0.0.1:8790", timeout_seconds=0.5)
        with mock.patch("server.agent_client.urlopen", side_effect=TimeoutError):
            with self.assertRaises(AgentUnavailable):
                client.tutor(self.tutor_payload())

    def test_health_schema_and_readiness_are_strict(self) -> None:
        healthy = {
            "schemaVersion": "cet-agent-health/1",
            "service": "cet-agent-runtime",
            "status": "ok",
            "ready": True,
            "engine": "langgraph",
            "pythonVersion": "3.11.9",
            "langgraphImportReady": True,
            "checkpointReady": True,
            "deepseekConfigured": True,
            "detail": "ready",
        }
        client = AgentClient(endpoint="http://127.0.0.1:8790", token="health-secret")
        captured = {}

        def fake_urlopen(request, timeout):
            captured["authorization"] = request.get_header("Authorization")
            captured["timeout"] = timeout
            return FakeResponse(healthy)

        with mock.patch("server.agent_client.urlopen", side_effect=fake_urlopen):
            result = client.health(timeout_seconds=1.25)
        self.assertTrue(result["ready"])
        self.assertEqual(captured, {"authorization": "Bearer health-secret", "timeout": 1.25})

        inconsistent = {**healthy, "ready": False}
        with mock.patch("server.agent_client.urlopen", return_value=FakeResponse(inconsistent)):
            with self.assertRaisesRegex(AgentProtocolError, "inconsistent"):
                client.health()

    def test_review_proposals_are_distinct_from_write_operations_and_target_pinned(self) -> None:
        payload = {
            "examId": EXAM_ID,
            "reviewRevision": 4,
            "issue": {
                "issueId": "question-review:q1",
                "kind": "question_review",
                "targetId": "q1",
                "message": "Check the stem",
                "severity": "manualReview",
                "page": 1,
            },
            "context": {},
        }
        client = AgentClient(endpoint="http://127.0.0.1:8790")
        with mock.patch(
            "server.agent_client.urlopen",
            return_value=FakeResponse(review_response()),
        ):
            response = client.suggest_review(payload)
        self.assertEqual(response["proposals"][0]["op"], "replace")
        self.assertNotIn("operations", response)

        wrong_target = review_response()
        wrong_target["proposals"][0]["questionId"] = "q2"
        with mock.patch(
            "server.agent_client.urlopen",
            return_value=FakeResponse(wrong_target),
        ):
            with self.assertRaisesRegex(AgentProtocolError, "proposals"):
                client.suggest_review(payload)

        unsafe_field = review_response()
        unsafe_field["proposals"][0]["field"] = "confidence"
        with mock.patch(
            "server.agent_client.urlopen",
            return_value=FakeResponse(unsafe_field),
        ):
            with self.assertRaisesRegex(AgentProtocolError, "proposals"):
                client.suggest_review(payload)


class PlatformAgentIntegrationTests(unittest.TestCase):
    def assistant_service(self):
        service = object.__new__(PlatformService)
        service._lock = threading.RLock()
        question = {
            "questionId": "q1",
            "number": 1,
            "type": "single_choice",
            "stem": "Choose one.",
            "options": [{"label": label, "text": label} for label in "ABCD"],
        }
        answer = {
            "questionId": "q1",
            "answer": "A",
            "explanation": "The uploaded answer page says A.",
            "source": "answer_pdf",
        }
        service._current_review_snapshot = mock.Mock(return_value=(Path("/unused"), 4, {}))
        service._snapshot_documents = mock.Mock(return_value=(
            {"questions": [question]},
            {"answers": [answer]},
        ))
        service._retrieve = mock.Mock(return_value=([{
            "questionId": "q1",
            "kind": "official_answer",
            "content": "q1 answer A",
        }], []))
        return service

    def test_capabilities_exposes_sanitized_agent_health(self) -> None:
        class PaddleDisabled:
            configured = False

        class HealthyAgent:
            configured = True

            def health(self, timeout_seconds=1.5):
                return {
                    "ready": True,
                    "engine": "langgraph",
                    "pythonVersion": "3.11.9",
                    "langgraphImportReady": True,
                    "checkpointReady": True,
                    "deepseekConfigured": False,
                    "detail": "ready",
                }

        service = object.__new__(PlatformService)
        with mock.patch("server.platform.shutil.which", return_value=None), \
             mock.patch("server.platform.PaddleOCRClient.from_environment", return_value=PaddleDisabled()), \
             mock.patch("server.platform.AgentClient.from_environment", return_value=HealthyAgent()):
            capabilities = service.capabilities()
        self.assertEqual(capabilities["agent"], {
            "configured": True,
            "reachable": True,
            "ready": True,
            "engine": "langgraph",
            "pythonVersion": "3.11.9",
            "langgraphImportReady": True,
            "checkpointReady": True,
            "deepseekConfigured": False,
            "message": "Agent runtime 可用",
        })

    def test_assistant_falls_back_when_agent_times_out_or_echoes_wrong_revision(self) -> None:
        service = self.assistant_service()

        class UnavailableClient:
            configured = True

            def tutor(self, payload):
                raise AgentUnavailable("timeout")

        with mock.patch("server.platform.AgentClient.from_environment", return_value=UnavailableClient()), \
             mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}):
            fallback = service.assistant(EXAM_ID, {"questionId": "q1", "message": "Why?"})
        self.assertNotIn("agent", fallback)
        self.assertIn("正确答案是 A", fallback["reply"])

        class StaleClient:
            configured = True

            def tutor(self, payload):
                return {**tutor_response(), "reviewRevision": 3}

        with mock.patch("server.platform.AgentClient.from_environment", return_value=StaleClient()), \
             mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}):
            stale_fallback = service.assistant(EXAM_ID, {"questionId": "q1", "message": "Why?"})
        self.assertNotIn("agent", stale_fallback)
        self.assertIn("正确答案是 A", stale_fallback["reply"])

    def test_successful_agent_keeps_legacy_envelope_and_adds_audit_metadata(self) -> None:
        service = self.assistant_service()

        class ReadyClient:
            configured = True

            def tutor(self, payload):
                self.payload = payload
                return tutor_response()

        client = ReadyClient()
        with mock.patch("server.platform.AgentClient.from_environment", return_value=client), \
             mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}):
            response = service.assistant(EXAM_ID, {
                "questionId": "q1",
                "message": "Why?",
                "reviewRevision": 4,
            })
        self.assertEqual(response["examId"], EXAM_ID)
        self.assertEqual(response["questionId"], "q1")
        self.assertEqual(response["revision"], 4)
        self.assertEqual(response["reply"], "Evidence-grounded reply.")
        self.assertEqual(response["agent"]["runId"], "run-123")
        self.assertEqual(response["citations"][0]["source"], "official_answer")
        self.assertEqual(client.payload["context"]["evidence"]["exact"][0]["questionId"], "q1")
        self.assertEqual(validate_tutor_request(client.payload)["reviewRevision"], 4)

    def test_review_suggestion_is_revision_pinned_and_does_not_write_exam_files(self) -> None:
        with TemporaryDirectory() as temporary:
            exams = Path(temporary) / "exams"
            directory = exams / EXAM_ID
            directory.mkdir(parents=True)
            question = {
                "questionId": "q1",
                "number": 1,
                "type": "single_choice",
                "page": 1,
                "bbox": {"x": 10, "y": 20, "width": 300, "height": 80},
                "stem": "Needs review",
                "options": [{"label": label, "text": label} for label in "ABCD"],
                "confidence": 0.7,
                "reviewStatus": "manualReview",
                "reviewRequired": True,
            }
            documents = {
                "status.json": {"status": "ready", "updatedAt": "2026-08-21T00:00:00Z"},
                "questions.json": {"questions": [question], "unresolved": []},
                "answers.json": {"answers": [], "conflicts": []},
                "manifest.json": {
                    "pages": [{
                        "number": 1,
                        "width": 600,
                        "height": 840,
                        "textSource": "pdf_text",
                        "words": [{"text": "Needs", "x": 10, "y": 20, "width": 50, "height": 10}],
                    }],
                },
            }
            for name, document in documents.items():
                _atomic_json(directory / name, document)

            before = {
                path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                for path in directory.glob("*.json")
            }

            class SuggestionClient:
                configured = True

                def suggest_review(self, payload):
                    self.payload = payload
                    return {
                        "schemaVersion": "cet-agent-review-suggestion/1",
                        "runId": "run-review",
                        "threadId": "thread-review",
                        "status": "completed",
                        "policy": "suggest_only",
                        "examId": EXAM_ID,
                        "reviewRevision": 0,
                        "issueId": "question-review:q1",
                        "proposals": [],
                        "rationale": "Insufficient evidence; ask the reviewer.",
                        "evidence": [],
                        "cautions": ["Do not guess."],
                        "trace": {"nodes": ["review"], "durationMs": 1},
                    }

            client = SuggestionClient()
            with mock.patch.object(platform_module, "EXAMS_DIR", exams), \
                 mock.patch("server.platform.AgentClient.from_environment", return_value=client):
                service = PlatformService()
                response = service.agent_review_suggestion(EXAM_ID, {
                    "issueId": "question-review:q1",
                    "reviewRevision": 0,
                })
                service._executor.shutdown(wait=True)

            after = {
                path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                for path in directory.glob("*.json")
            }
            self.assertEqual(before, after)
            self.assertEqual(response["policy"], "suggest_only")
            self.assertEqual(set(client.payload), {"examId", "reviewRevision", "issue", "context"})
            self.assertEqual(client.payload["issue"]["targetId"], "q1")
            self.assertEqual(client.payload["context"]["policy"], "suggest_only_human_approval_required")
            self.assertEqual(validate_review_request(client.payload)["issue"]["issueId"], "question-review:q1")

    def test_review_suggestion_route_requires_loopback_and_same_origin_body(self) -> None:
        raw = json.dumps({
            "issueId": "question-review:q1",
            "reviewRevision": 4,
        }).encode("utf-8")

        class Handler:
            def __init__(self, address):
                self.client_address = (address, 12345)
                self.headers = {
                    "Host": "127.0.0.1:4173",
                    "Content-Type": "application/json",
                    "Content-Length": str(len(raw)),
                }
                self.rfile = io.BytesIO(raw)
                self.responses = []

            def _request_is_same_origin(self):
                return True

            def _json_response(self, status, document, include_body=True, extra_headers=None):
                self.responses.append((status, document, extra_headers or {}))

            def _json_error(self, status, message):
                self.responses.append((status, {"error": message}, {}))

        class Service:
            def __init__(self):
                self.payload = None

            def agent_review_suggestion(self, exam_id, payload):
                self.payload = (exam_id, payload)
                return {
                    "examId": exam_id,
                    "reviewRevision": 4,
                    "policy": "suggest_only",
                }

        api = object.__new__(PlatformAPI)
        api.service = Service()
        route = urlparse(f"/api/exams/{EXAM_ID}/agent/review-suggestions")

        remote = Handler("192.0.2.10")
        self.assertTrue(api.handle_post(remote, route))
        self.assertEqual(remote.responses[0][0], HTTPStatus.FORBIDDEN)
        self.assertIsNone(api.service.payload)

        local = Handler("127.0.0.1")
        self.assertTrue(api.handle_post(local, route))
        self.assertEqual(local.responses[0][0], HTTPStatus.OK)
        self.assertEqual(local.responses[0][2]["ETag"], '"review-r4"')
        self.assertEqual(api.service.payload, (EXAM_ID, {
            "issueId": "question-review:q1",
            "reviewRevision": 4,
        }))


if __name__ == "__main__":
    unittest.main()
