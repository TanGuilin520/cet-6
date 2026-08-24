"""Mocked DeepSeek integration tests: agent runtime, transport, and platform.

Every external call is mocked; no test in this module touches the network.
"""

from __future__ import annotations

import io
import json
import os
import unittest
import urllib.error
from unittest import mock
from contextlib import redirect_stderr
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import mock_open, patch

import server.platform as platform_module
from server.agent_client import AgentClient, AgentProtocolError, AgentUnavailable
from server.platform import PlatformService, deterministic_generation, resolve_deepseek_model
from services.agent import app as agent_app
from services.agent.app import (
    DeepSeekClient,
    ModelOutcome,
    _draft_tutor,
    _fallback_tutor_reply,
    _guard_tutor,
    _retrieve_tutor_evidence,
    validate_tutor_request,
)


ENV_KEY = {"DEEPSEEK_API_KEY": "test-key-not-real", "CET_AGENT_DEEPSEEK_URL": "https://api.deepseek.com/chat/completions"}


def tutor_request():
    return {
        "examId": "exam-20250821-012345abcdef",
        "questionId": "q26",
        "reviewRevision": 3,
        "message": "为什么不能选 A？",
        "userAnswer": "A",
        "history": [],
        "requestId": "reader-7",
        "context": {
            "question": {
                "questionId": "q26",
                "number": 26,
                "type": "single_choice",
                "stem": "Which statement is supported?",
                "options": [{"label": "A", "text": "Distractor"}, {"label": "C", "text": "Supported"}],
            },
            "officialAnswer": {
                "questionId": "q26",
                "answer": "C",
                "explanation": "The passage supports C.",
                "source": "answer_pdf",
            },
            "evidence": {
                "exact": [{"questionId": "q26", "kind": "official_explanation", "content": "26. C. The passage supports C."}],
                "vector": [],
            },
            "officialExplanationFound": True,
            "disclaimer": "",
            "policy": "question_id_exact_then_vector_context",
        },
    }


class FakeResponse:
    def __init__(self, payload: bytes = b"", content_type: str = "application/json", headers=None):
        self._payload = payload
        self.headers = headers if headers is not None else {"Content-Type": content_type}

    def read(self, limit: int) -> bytes:
        return self._payload[:limit]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def raiser(exception):
    def handler(*args, **kwargs):
        raise exception
    return handler


def deepseek_body(reply: str = "好的，答案是 C。", usage=None) -> bytes:
    document = {
        "choices": [{"message": {"content": json.dumps({"reply": reply}, ensure_ascii=False)}}],
    }
    if usage is not None:
        document["usage"] = usage
    return json.dumps(document).encode("utf-8")


def http_error(code: int, retry_after: str | None = None) -> urllib.error.HTTPError:
    headers = {"Retry-After": retry_after} if retry_after is not None else {}
    return urllib.error.HTTPError("https://api.deepseek.com", code, "err", headers, io.BytesIO(b"upstream secret body"))


def client_with_env(**extra) -> DeepSeekClient:
    return DeepSeekClient(env={**ENV_KEY, **extra})


class DeepSeekClientTests(unittest.TestCase):
    def run_complete(self, client: DeepSeekClient, urlopen_side_effect):
        with patch.object(agent_app, "urlopen", side_effect=urlopen_side_effect) as opened:
            outcome = client.complete("system prompt", [{"role": "user", "content": "hi"}])
        return outcome, opened

    def test_default_model_is_v4_flash_and_request_contract_is_bounded(self):
        client = DeepSeekClient(env=dict(ENV_KEY))
        captured = {}

        def handler(request, timeout=None, **kwargs):
            captured["url"] = request.full_url
            captured["auth"] = request.headers.get("Authorization")
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse(deepseek_body())

        outcome, opened = self.run_complete(client, handler)
        self.assertTrue(outcome.used)
        self.assertEqual(captured["url"], "https://api.deepseek.com/chat/completions")
        self.assertTrue(captured["auth"].startswith("Bearer "))
        self.assertNotIn(ENV_KEY["DEEPSEEK_API_KEY"], repr(captured["payload"]))
        self.assertEqual(captured["payload"]["model"], "deepseek-v4-flash")
        self.assertEqual(captured["payload"]["response_format"], {"type": "json_object"})
        self.assertEqual(opened.call_count, 1)

    def test_configured_pro_model_is_used(self):
        with patch.dict(os.environ, {"CET_AGENT_DEEPSEEK_MODEL": "deepseek-v4-pro"}):
            client = DeepSeekClient(env={**os.environ, **ENV_KEY})
        captured_model = []

        def handler(request, timeout=None, **kwargs):
            captured_model.append(json.loads(request.data.decode("utf-8"))["model"])
            return FakeResponse(deepseek_body())

        outcome, _ = self.run_complete(client, handler)
        self.assertEqual(captured_model, ["deepseek-v4-pro"])
        self.assertTrue(outcome.used)

    def test_legacy_model_names_map_with_notice_and_no_secret(self):
        cases = {"deepseek-chat": "deepseek-v4-flash", "deepseek-reasoner": "deepseek-v4-pro"}
        for legacy, expected in cases.items():
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                client = DeepSeekClient(env={**ENV_KEY, "CET_AGENT_DEEPSEEK_MODEL": legacy})
            self.assertEqual(client.model, expected)
            self.assertIn(expected, stderr.getvalue())
            self.assertNotIn(ENV_KEY["DEEPSEEK_API_KEY"], stderr.getvalue())

    def test_unsupported_model_is_a_configuration_error(self):
        client = DeepSeekClient(env={**ENV_KEY, "CET_AGENT_DEEPSEEK_MODEL": "gpt-9-turbo"})
        self.assertFalse(client.configured)
        self.assertIn("deepseek-v4-flash or deepseek-v4-pro", client.configuration_error)
        outcome, opened = self.run_complete(client, lambda *a: (_ for _ in ()).throw(AssertionError("no network")))
        self.assertFalse(outcome.used)
        self.assertEqual(opened.call_count, 0)

    def test_key_without_valid_url_is_not_configured(self):
        client = DeepSeekClient(env={"DEEPSEEK_API_KEY": "k", "CET_AGENT_DEEPSEEK_URL": "http://api.example.com/x"})
        self.assertFalse(client.configured)

    def test_insecure_loopback_flag_allows_local_mock_endpoint_only(self):
        allowed = DeepSeekClient(env={
            "DEEPSEEK_API_KEY": "k",
            "CET_AGENT_DEEPSEEK_URL": "http://127.0.0.1:9443/v1",
            agent_app.ALLOW_INSECURE_LOOPBACK_ENV: "1",
        })
        self.assertTrue(allowed.configured)
        rejected = DeepSeekClient(env={"DEEPSEEK_API_KEY": "k", "CET_AGENT_DEEPSEEK_URL": "http://127.0.0.1:9443/v1"})
        self.assertFalse(rejected.configured)
        external = DeepSeekClient(env={
            "DEEPSEEK_API_KEY": "k",
            "CET_AGENT_DEEPSEEK_URL": "http://evil.example.com/v1",
            agent_app.ALLOW_INSECURE_LOOPBACK_ENV: "1",
        })
        self.assertFalse(external.configured)

    def test_successful_reply_parses_usage(self):
        usage = {"prompt_tokens": 120, "completion_tokens": 30, "total_tokens": 150}
        client = client_with_env()
        outcome, _ = self.run_complete(client, lambda *a, **k: FakeResponse(deepseek_body(usage=usage)))
        self.assertTrue(outcome.used)
        self.assertEqual(outcome.usage, {"promptTokens": 120, "completionTokens": 30, "totalTokens": 150})
        generation = outcome.generation(client.model)
        self.assertEqual(generation["provider"], "deepseek")
        self.assertIsNone(generation["fallbackReason"])

    def test_empty_or_non_string_reply_is_invalid_response(self):
        empty = json.dumps({"choices": [{"message": {"content": ""}}]}).encode()
        outcome, _ = self.run_complete(client_with_env(), lambda *a, **k: FakeResponse(empty))
        self.assertFalse(outcome.used)
        self.assertEqual(outcome.fallback_reason, "invalid_response")

    def test_corrupt_outer_json_is_invalid_response(self):
        outcome, _ = self.run_complete(client_with_env(), lambda *a, **k: FakeResponse(b"{not-json"))
        self.assertEqual(outcome.fallback_reason, "invalid_response")

    def test_wrong_media_type_is_invalid_response(self):
        outcome, _ = self.run_complete(
            client_with_env(), lambda *a, **k: FakeResponse(deepseek_body(), content_type="text/html")
        )
        self.assertEqual(outcome.fallback_reason, "invalid_response")

    def test_oversized_response_is_invalid_response(self):
        huge = deepseek_body() + b" " * (agent_app.MAX_MODEL_RESPONSE_BYTES + 10)
        outcome, _ = self.run_complete(client_with_env(), lambda *a, **k: FakeResponse(huge))
        self.assertEqual(outcome.fallback_reason, "invalid_response")

    def test_auth_error_does_not_retry(self):
        outcome, opened = self.run_complete(client_with_env(), raiser(http_error(401)))
        self.assertEqual(outcome.fallback_reason, "upstream_auth_error")
        self.assertEqual(opened.call_count, 1)

    def test_rate_limit_retries_once_then_reports(self):
        outcome, opened = self.run_complete(
            client_with_env(), raiser(http_error(429, retry_after="0"))
        )
        self.assertEqual(outcome.fallback_reason, "upstream_rate_limited")
        self.assertEqual(opened.call_count, 2)

    def test_server_errors_are_reported_after_single_retry(self):
        for code in (500, 502, 503):
            outcome, opened = self.run_complete(client_with_env(), raiser(http_error(code)))
            self.assertEqual(outcome.fallback_reason, "upstream_server_error")
            self.assertLessEqual(opened.call_count, agent_app.MAX_MODEL_ATTEMPTS)

    def test_network_error_maps_to_server_error_without_leaking_body(self):
        client = client_with_env()
        outcome, _ = self.run_complete(client, raiser(__import__("urllib").error.URLError("boom secret")))
        self.assertEqual(outcome.fallback_reason, "upstream_server_error")
        self.assertNotIn("secret", str(outcome.generation(client.model)))

    def test_timeout_never_repeats_the_unknown_result(self):
        outcome, opened = self.run_complete(client_with_env(), raiser(TimeoutError()))
        self.assertEqual(outcome.fallback_reason, "upstream_timeout")
        self.assertEqual(opened.call_count, 1, "unknown-outcome timeouts must not be re-billed")

    def test_missing_key_is_not_configured_and_never_hits_network(self):
        client = DeepSeekClient(env={"DEEPSEEK_API_KEY": ""})
        outcome, opened = self.run_complete(client, lambda *a: (_ for _ in ()).throw(AssertionError("no network")))
        self.assertEqual(outcome.fallback_reason, "not_configured")
        self.assertFalse(outcome.attempted)
        self.assertEqual(opened.call_count, 0)


class DraftNodeTests(unittest.TestCase):
    def base_state(self):
        request = validate_tutor_request(tutor_request())
        state = {
            "request": request,
            "intent": "answer_explanation",
            "citations": [{"source": "rag:exact:official_explanation", "questionId": "q26", "excerpt": "26. C"}],
            "grounding": {
                "status": "official",
                "disclaimerRequired": False,
                "disclaimer": "",
                "officialEvidenceFound": True,
            },
            "trace_nodes": ["route_intent"],
        }
        return state, request

    def test_mutation_intent_blocks_the_model_call(self):
        state, request = self.base_state()
        state["intent"] = "unsupported_mutation"
        calls = []
        client = SimpleNamespace(
            configured=True,
            key_present=True,
            configuration_error="",
            model="deepseek-v4-flash",
            complete=lambda system, messages: calls.append(system) or ModelOutcome(reply="x", used=True, attempted=True),
        )
        result = _draft_tutor(state, client)
        self.assertEqual(calls, [])
        self.assertEqual(result["generation"]["fallbackReason"], "blocked_mutation")
        self.assertFalse(result["generation"]["used"])
        self.assertIn("只有读取权限", result["reply"])

    def test_missing_official_explanation_forces_disclaimer_over_model_reply(self):
        state, request = self.base_state()
        state["request"] = dict(request)
        state["request"]["context"] = dict(request["context"])
        state["request"]["context"]["officialExplanationFound"] = False
        state["grounding"] = {
            "status": "context_only",
            "disclaimerRequired": True,
            "disclaimer": "答案资料中没有找到官方解析，以下为 AI 辅助分析。",
            "officialEvidenceFound": False,
        }
        client = SimpleNamespace(
            configured=True,
            key_present=True,
            configuration_error="",
            model="deepseek-v4-flash",
            complete=lambda system, messages: ModelOutcome(reply="模型认为 A 不对。", used=True, attempted=True),
        )
        drafted = _draft_tutor(state, client)
        guarded = _guard_tutor({**state, **drafted})
        self.assertTrue(drafted["generation"]["used"])
        self.assertIn("答案资料中没有找到官方解析", guarded["reply"])

    def test_model_cannot_override_server_citations(self):
        state, request = self.base_state()
        malicious = json.dumps({
            "reply": "好的。",
            "citations": [{"source": "model-fabricated", "questionId": "q99", "excerpt": "fake"}],
        })
        client = SimpleNamespace(
            configured=True,
            key_present=True,
            configuration_error="",
            model="deepseek-v4-flash",
            complete=lambda system, messages: ModelOutcome(reply=malicious, used=True, attempted=True),
        )
        retrieved = _retrieve_tutor_evidence(state)
        merged = {**state, **retrieved}
        server_citations = [dict(item) for item in merged["citations"]]
        drafted = _draft_tutor(merged, client)
        self.assertIsNone(drafted.get("citations"), "draft must never emit citations")
        self.assertEqual(merged["citations"], server_citations)
        # Fabricated citation text may survive only as quoted reply content;
        # it must never appear as structured metadata.
        self.assertNotIn("model-fabricated", json.dumps(drafted["generation"]))
        self.assertNotIn("citations", json.loads(json.dumps(drafted["generation"])))

    def test_transport_failure_generation_stays_sanitized(self):
        state, _ = self.base_state()
        def explode(system, messages):
            raise AssertionError("should not be called")
        client = SimpleNamespace(
            configured=False,
            key_present=False,
            configuration_error="",
            model="",
            complete=explode,
        )
        result = _draft_tutor(state, client)
        self.assertEqual(result["generation"], {
            "provider": "deterministic",
            "model": None,
            "attempted": False,
            "used": False,
            "fallbackReason": "not_configured",
            "usage": None,
        })


class AgentClientCompatTests(unittest.TestCase):
    def make_client(self, document):
        client = AgentClient(endpoint="http://127.0.0.1:8770")

        class SelfClient(AgentClient):
            pass

        with patch.object(AgentClient, "_request", lambda self, path, **kwargs: document):
            return client.tutor({
                "examId": "exam-20250821-012345abcdef",
                "questionId": "q26",
                "reviewRevision": 3,
                "message": "why",
                "userAnswer": "A",
                "history": [],
                "requestId": "reader-7",
                "context": {},
            })

    def base_document(self, schema="cet-agent-tutor/2"):
        return {
            "schemaVersion": schema,
            "runId": "run-1",
            "threadId": "run-1",
            "status": "completed",
            "examId": "exam-20250821-012345abcdef",
            "questionId": "q26",
            "reviewRevision": 3,
            "requestId": "reader-7",
            "reply": "reply text",
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
            "generation": {
                "provider": "deepseek",
                "model": "deepseek-v4-flash",
                "attempted": True,
                "used": True,
                "fallbackReason": None,
                "usage": {"promptTokens": 10, "completionTokens": 5, "totalTokens": 15},
            },
            "trace": {"nodes": ["route_intent"], "durationMs": 3},
        }

    def test_v2_document_passes_generation_through(self):
        result = self.make_client(self.base_document())
        self.assertEqual(result["schemaVersion"], "cet-agent-tutor/2")
        self.assertEqual(result["generation"]["usage"]["totalTokens"], 15)

    def test_v1_document_is_accepted_without_generation(self):
        document = self.base_document(schema="cet-agent-tutor/1")
        document.pop("generation")
        result = self.make_client(document)
        self.assertNotIn("generation", result)

    def test_generation_with_unknown_fallback_reason_is_rejected(self):
        document = self.base_document()
        document["generation"]["fallbackReason"] = "mystery"
        with self.assertRaisesRegex(AgentProtocolError, "generation"):
            self.make_client(document)

    def test_request_id_echo_mismatch_is_rejected(self):
        document = self.base_document()
        document["requestId"] = "different"
        with self.assertRaises(AgentProtocolError):
            self.make_client(document)


class PlatformAntiDoubleCallTests(unittest.TestCase):
    def assistant_service(self):
        service = object.__new__(PlatformService)
        service._lock = __import__('threading').RLock()
        question = {
            "questionId": "q1", "number": 1, "type": "single_choice", "page": 1,
            "stem": "Which?", "options": [{"label": label, "text": label} for label in "ABCD"],
        }
        answer = {"questionId": "q1", "answer": "A", "explanation": "The uploaded answer page says A.", "source": "answer_pdf"}
        service._current_review_snapshot = mock.Mock(return_value=(Path("/unused"), 4, {}))
        service._snapshot_documents = mock.Mock(return_value=({"questions": [question]}, {"answers": [answer]}))
        service._retrieve = mock.Mock(return_value=([{
            "questionId": "q1", "kind": "official_answer", "content": "q1 answer A",
        }], []))
        return service

    def test_agent_failure_never_triggers_a_second_direct_call(self):
        from server.agent_client import AgentUnavailable
        service = self.assistant_service()

        class UnavailableClient:
            configured = True

            def tutor(self, payload):
                raise AgentUnavailable("timeout")

        with patch("server.platform.AgentClient.from_environment", return_value=UnavailableClient()), \
             patch.dict(os.environ, {"DEEPSEEK_API_KEY": "some-real-key"}), \
             patch.object(platform_module.PlatformService, "_deepseek_assistant_reply") as direct:
            response = service.assistant("exam-20250821-012345abcdef", {"questionId": "q1", "message": "Why?"})
        direct.assert_not_called()
        self.assertNotIn("agent", response)
        self.assertIn("正确答案是 A", response["reply"])
        self.assertEqual(response["generation"]["fallbackReason"], "agent_transport_error")
        self.assertFalse(response["generation"]["used"])

    def test_agent_success_passthrough_generation(self):
        service = self.assistant_service()
        generation = {
            "provider": "deepseek", "model": "deepseek-v4-flash", "attempted": True,
            "used": True, "fallbackReason": None,
            "usage": {"promptTokens": 11, "completionTokens": 7, "totalTokens": 18},
        }

        class ReadyClient:
            configured = True

            def tutor(self, payload):
                self.payload = payload
                return {
                    "schemaVersion": "cet-agent-tutor/2",
                    "runId": "run-9", "threadId": "run-9", "status": "completed",
                    "examId": "exam-20250821-012345abcdef", "questionId": "q1",
                    "reviewRevision": 4, "requestId": payload["requestId"],
                    "reply": "Agent 回答。", "intent": "explain_answer", "tools": [],
                    "citations": [], "generation": generation,
                    "grounding": {
                        "status": "official", "officialEvidenceFound": True,
                        "disclaimerRequired": False, "officialExplanationFound": True,
                        "exactMatches": 1, "vectorMatches": 0, "disclaimer": "",
                        "retrievalOrder": ["question_id_exact", "deterministic_vector_supplement"],
                    },
                    "trace": {"nodes": ["route_intent"], "durationMs": 4},
                }

        client = ReadyClient()
        with patch("server.platform.AgentClient.from_environment", return_value=client), \
             patch.dict(os.environ, {"DEEPSEEK_API_KEY": "real-key"}), \
             patch.object(platform_module.PlatformService, "_deepseek_assistant_reply") as direct:
            response = service.assistant("exam-20250821-012345abcdef", {
                "questionId": "q1", "message": "Why?", "requestId": "reader-42",
            })
        direct.assert_not_called()
        self.assertEqual(response["generation"], generation)
        self.assertEqual(response["requestId"], "reader-42")
        self.assertEqual(client.payload["requestId"], "reader-42")

    def test_unconfigured_agent_keeps_legacy_direct_path(self):
        service = self.assistant_service()

        class NotConfigured:
            configured = False

        success_payload = json.dumps({
            "choices": [{"message": {"content": json.dumps({"reply": "直接回答"}, ensure_ascii=False)}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
        }).encode()

        with patch("server.platform.AgentClient.from_environment", return_value=NotConfigured()), \
             patch.dict(os.environ, {"DEEPSEEK_API_KEY": "real-key", "DEEPSEEK_MODEL": "deepseek-chat"}), \
             patch("server.platform.urlopen", return_value=FakeResponse(success_payload)) as opened:
            response = service.assistant("exam-20250821-012345abcdef", {"questionId": "q1", "message": "Why?"})
        self.assertEqual(opened.call_count, 1)
        sent = json.loads(opened.call_args[0][0].data.decode("utf-8"))
        self.assertEqual(sent["model"], "deepseek-v4-flash", "legacy name maps to the current default")
        self.assertEqual(sent["response_format"], {"type": "json_object"})
        self.assertTrue(response["generation"]["used"])
        self.assertEqual(response["generation"]["model"], "deepseek-v4-flash")
        self.assertIn("直接回答", response["reply"])

    def test_direct_path_rejects_raw_non_json_content(self):
        service = self.assistant_service()

        class NotConfigured:
            configured = False

        raw_payload = json.dumps({
            "choices": [{"message": {"content": "这是一段没有被 JSON 信封包裹的回答"}}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
        }).encode()

        with patch("server.platform.AgentClient.from_environment", return_value=NotConfigured()), \
             patch.dict(os.environ, {"DEEPSEEK_API_KEY": "real-key"}), \
             patch("server.platform.urlopen", return_value=FakeResponse(raw_payload)):
            response = service.assistant("exam-20250821-012345abcdef", {"questionId": "q1", "message": "Why?"})
        self.assertFalse(response["generation"]["used"])
        self.assertEqual(response["generation"]["fallbackReason"], "invalid_response")
        self.assertNotIn("没有被 JSON 信封包裹", response["reply"])

    def test_direct_failure_keeps_deterministic_answer_with_reason(self):
        service = self.assistant_service()

        class NotConfigured:
            configured = False

        with patch("server.platform.AgentClient.from_environment", return_value=NotConfigured()), \
             patch.dict(os.environ, {"DEEPSEEK_API_KEY": "real-key"}), \
             patch("server.platform.urlopen", side_effect=urllib.error.HTTPError("u", 500, "e", {}, io.BytesIO(b"x"))):
            response = service.assistant("exam-20250821-012345abcdef", {"questionId": "q1", "message": "Why?"})
        self.assertFalse(response["generation"]["used"])
        self.assertEqual(response["generation"]["fallbackReason"], "upstream_server_error")
        self.assertIn("正确答案是 A", response["reply"])

    def test_browser_request_id_is_threaded_and_sanitize_bad_input(self):
        service = self.assistant_service()
        seen = []

        class UnavailableClient:
            configured = True

            def tutor(self, payload):
                seen.append(payload["requestId"])
                raise AgentUnavailable("down")

        client = UnavailableClient()
        with patch("server.platform.AgentClient.from_environment", return_value=client), \
             patch.dict(os.environ, {"DEEPSEEK_API_KEY": "real-key"}):
            bad = service.assistant("exam-20250821-012345abcdef", {
                "questionId": "q1", "message": "Why?", "requestId": "../../evil id 空格",
            })
            self.assertNotEqual(bad["requestId"], "../../evil id 空格")
            self.assertEqual(len(seen), 1)
            self.assertTrue(platform_module.SAFE_REQUEST_ID.fullmatch(str(seen[0])))

            good = service.assistant("exam-20250821-012345abcdef", {
                "questionId": "q1", "message": "Why?", "requestId": "reader-9",
            })
            self.assertEqual(good["requestId"], "reader-9")
            self.assertEqual(seen[1], "reader-9")


class ReviewGraphNeverCallsModelTests(unittest.TestCase):
    def test_review_pipeline_functions_have_no_model_dependency(self):
        from services.agent.app import propose_review_proposals
        from services.agent.app import (
            _guard_review,
            _load_review_issue,
            _propose_review,
            _retrieve_review_evidence,
        )
        from tests.test_agent_runtime import review_request, validate_review_request

        def explode(*args, **kwargs):
            raise AssertionError("review graph must not touch DeepSeek")

        with patch.object(agent_app.DeepSeekClient, "complete", explode):
            state = {"request": validate_review_request(review_request()), "trace_nodes": [], "tools": []}
            state.update(_load_review_issue(state))
            state.update(_retrieve_review_evidence(state))
            proposals, rationale, cautions = propose_review_proposals(state["request"], state["citations"])
            state.update({"proposals": proposals, "rationale": rationale, "cautions": cautions})
            state.update(_guard_review(state))
        self.assertEqual(len(state["proposals"]), 1)
        self.assertEqual(state["proposals"][0]["value"], "C")

    def test_resolve_helper_maps_and_rejects(self):
        self.assertEqual(resolve_deepseek_model(None)[0], "deepseek-v4-flash")
        self.assertEqual(resolve_deepseek_model("deepseek-reasoner")[0], "deepseek-v4-pro")
        self.assertEqual(resolve_deepseek_model("claude-x")[0], "deepseek-v4-flash")


if __name__ == "__main__":
    unittest.main()
