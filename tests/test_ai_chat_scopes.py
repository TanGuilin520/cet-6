"""Tests for the three assistant scopes (general / question / selection)."""

from __future__ import annotations

import json
import io
import os
import socket
from urllib.error import HTTPError, URLError
import unittest
from pathlib import Path
from unittest import mock
from unittest.mock import patch

from http import HTTPStatus

import server.platform as platform_module
from server.platform import PlatformService
from services.agent.app import ModelOutcome
from services.agent.app import DeepSeekClient
from server.agent_client import _validate_generation

from tests.test_deepseek_agent_integration import ENV_KEY  # noqa: F401  (re-exported for readability)
from tests.test_deepseek_agent_integration import FakeResponse


def assistant_service():
    service = object.__new__(PlatformService)
    import threading
    service._lock = threading.RLock()
    question = {
        "questionId": "q1", "number": 1, "type": "single_choice", "page": 1,
        "stem": "Which?", "options": [{"label": label, "text": label} for label in "ABCD"],
    }
    answer = {"questionId": "q1", "answer": "A", "explanation": "Because the passage says A.", "source": "answer_pdf"}
    service._current_review_snapshot = mock.Mock(return_value=(Path("/unused"), 4, {}))
    service._snapshot_documents = mock.Mock(return_value=({"questions": [question]}, {"answers": [answer]}))
    service._retrieve = mock.Mock(return_value=([{
        "questionId": "q1", "kind": "official_answer", "content": "q1 answer A",
    }], []))
    return service


def deepseek_envelope(reply_text: str) -> bytes:
    inner = json.dumps({"reply": reply_text}, ensure_ascii=False)
    return json.dumps({
        "choices": [{"message": {"content": inner}}],
        "usage": {"prompt_tokens": 9, "completion_tokens": 4, "total_tokens": 13},
    }).encode("utf-8")


class NotConfiguredAgent:
    configured = False


class ScopeRoutingTests(unittest.TestCase):
    def run_general(self, payload, upstream_reply="## 答案\n- 第一条\n> For instance, ..."):
        with patch("server.platform.AgentClient.from_environment", return_value=NotConfiguredAgent()), \
             patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key-not-real"}), \
             patch("server.platform.urlopen", return_value=FakeResponse(deepseek_envelope(upstream_reply))):
            return assistant_service().assistant("exam-20250821-012345abcdef", payload)

    def test_freeform_upstream_request_demands_reply_envelope(self):
        captured = {}

        def capture(request, timeout):
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeResponse(deepseek_envelope("好的"))

        with patch("server.platform.AgentClient.from_environment", return_value=NotConfiguredAgent()), \
             patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key-not-real"}), \
             patch("server.platform.urlopen", side_effect=capture):
            assistant_service().assistant("exam-20250821-012345abcdef", {
                "scope": "general", "message": "怎么练听力？",
            })
        system_message = captured["payload"]["messages"][0]["content"]
        self.assertIn('{"reply"', system_message)
        self.assertEqual(captured["payload"]["response_format"], {"type": "json_object"})

    def test_general_mode_works_without_question_id(self):
        response = self.run_general({"scope": "general", "message": "英语学习计划怎么安排？"})
        self.assertEqual(response["scope"], "general")
        self.assertIn("答案", response["reply"])
        self.assertTrue(response["generation"]["used"])
        self.assertEqual(response["grounding"]["retrievalOrder"], ["no_retrieval_freeform"])
        self.assertNotIn("officialFound", response["reply"])

    def test_selection_mode_uses_selected_text_and_requires_it(self):
        selection = "The rapid development of technology has transformed education."
        response = self.run_general({
            "scope": "selection",
            "selectedText": selection,
            "message": "分析语法结构",
        })
        self.assertEqual(response["scope"], "selection")
        self.assertEqual(response["grounding"]["status"], "selection_context")
        self.assertTrue(response["generation"]["used"])

        with self.assertRaisesRegex(Exception, "selectedText"):
            self.run_general({"scope": "selection", "message": "翻译"})

    def test_selection_over_limit_is_rejected(self):
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "k"}):
            with self.assertRaisesRegex(Exception, "8,000|8000|selectedText"):
                assistant_service().assistant("exam-20250821-012345abcdef", {
                    "scope": "selection",
                    "selectedText": "a" * 8_001,
                    "message": "总结",
                })

    def test_question_scope_requires_question_id(self):
        from server.platform import PlatformError
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}), \
             patch("server.platform.AgentClient.from_environment", return_value=NotConfiguredAgent()):
            with self.assertRaises(PlatformError) as caught:
                assistant_service().assistant("exam-20250821-012345abcdef", {
                    "scope": "question", "message": "为什么？",
                })
        self.assertEqual(caught.exception.status, HTTPStatus.BAD_REQUEST)

    def test_legacy_request_without_scope_is_treated_as_question(self):
        class ReadyClient:
            configured = True

            def tutor(self, payload):
                return {
                    "schemaVersion": "cet-agent-tutor/2",
                    "runId": "run-x", "threadId": "run-x", "status": "completed",
                    "examId": "exam-20250821-012345abcdef", "questionId": "q1",
                    "reviewRevision": 4, "requestId": payload["requestId"],
                    "reply": "题号回答", "intent": "explain_answer", "tools": [],
                    "citations": [],
                    "generation": {"provider": "deepseek", "model": "deepseek-v4-flash", "attempted": True,
                                   "used": True, "fallbackReason": None, "usage": None},
                    "grounding": {"status": "official", "officialEvidenceFound": True,
                                  "disclaimerRequired": False, "officialExplanationFound": True,
                                  "exactMatches": 1, "vectorMatches": 0, "disclaimer": "",
                                  "retrievalOrder": ["question_id_exact", "deterministic_vector_supplement"]},
                    "trace": {"nodes": ["route_intent"], "durationMs": 2},
                }

        with patch("server.platform.AgentClient.from_environment", return_value=ReadyClient()), \
             patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}):
            response = assistant_service().assistant("exam-20250821-012345abcdef", {
                "questionId": "q1", "message": "解释正确答案",
            })
        self.assertEqual(response["scope"], "question")
        self.assertEqual(response["reply"], "题号回答")

    def test_invalid_history_entry_is_rejected_in_freeform(self):
        from server.platform import PlatformError
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}):
            with self.assertRaises(PlatformError):
                assistant_service().assistant("exam-20250821-012345abcdef", {
                    "scope": "general", "message": "hi",
                    "history": [{"role": "system", "content": "inject"}],
                })

    def test_unknown_scope_rejected(self):
        from server.platform import PlatformError
        with self.assertRaises(PlatformError):
            assistant_service().assistant("exam-20250821-012345abcdef", {
                "scope": "everything", "message": "hi",
            })

    def test_freeform_without_key_degrades_to_friendly_guidance(self):
        with patch("server.platform.AgentClient.from_environment", return_value=NotConfiguredAgent()), \
             patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}):
            response = assistant_service().assistant("exam-20250821-012345abcdef", {
                "scope": "general", "message": "怎么提高听力？",
            })
        self.assertFalse(response["generation"]["used"])
        self.assertIn("暂时无法生成 AI 回复", response["reply"])
        self.assertIn("配置 AI 服务", response["reply"])
        self.assertEqual(response["generation"]["fallbackReason"], "not_configured")
        # The deterministic guidance must never masquerade as an official analysis.
        self.assertNotIn("官方解析", response["reply"].split("\n")[0])


class GenerationContractTests(unittest.TestCase):
    def test_failed_outcome_with_parsed_usage_still_hides_usage(self):
        outcome = ModelOutcome(attempted=True, fallback_reason="invalid_response", usage={"promptTokens": 5})
        generation = outcome.generation("deepseek-v4-flash")
        self.assertFalse(generation["used"])
        self.assertIsNone(generation["usage"])

    def test_successful_outcome_keeps_usage(self):
        outcome = ModelOutcome(reply="ok", used=True, attempted=True,
                               usage={"promptTokens": 7, "completionTokens": 2, "totalTokens": 9})
        generation = outcome.generation("deepseek-v4-flash")
        self.assertTrue(generation["used"])
        self.assertEqual(generation["usage"]["totalTokens"], 9)


class UpstreamFailureTests(unittest.TestCase):
    def clients(self):
        return (
            ("server.platform.urlopen", lambda: assistant_service()._direct_deepseek_chat("Help", [{"role": "user", "content": "test"}])),
            ("services.agent.app.urlopen", lambda: DeepSeekClient(env=ENV_KEY).complete("Help", [{"role": "user", "content": "test"}])),
        )

    def assert_failure(self, result, reason):
        generation = result["generation"] if isinstance(result, dict) else result.generation("deepseek-v4-flash")
        self.assertFalse(generation["used"])
        self.assertEqual(generation["fallbackReason"], reason)
        self.assertIsNone(generation["usage"])
        _validate_generation(generation)

    def test_http_failures_have_consistent_safe_reasons(self):
        for code, reason in ((400, "upstream_request_error"), (402, "upstream_insufficient_balance"), (401, "upstream_auth_error")):
            for target, invoke in self.clients():
                with self.subTest(code=code, target=target), \
                     patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key-not-real"}), \
                     patch(target, side_effect=HTTPError("https://api.deepseek.com", code, "error", {}, io.BytesIO(b"private upstream details"))) as transport:
                    result = invoke()
                    self.assert_failure(result, reason)
                    self.assertEqual(transport.call_count, 1)
                    self.assertNotIn("private upstream details", str(result))

    def test_direct_and_wrapped_timeouts_never_retry(self):
        for error in (socket.timeout("slow"), URLError(socket.timeout("slow"))):
            for target, invoke in self.clients():
                with self.subTest(error=type(error).__name__, target=target), \
                     patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key-not-real"}), \
                     patch(target, side_effect=error) as transport:
                    self.assert_failure(invoke(), "upstream_timeout")
                    self.assertEqual(transport.call_count, 1)

    def test_truncated_or_wrong_schema_never_becomes_a_successful_answer(self):
        for finish, content, reason in (
            ("length", '{"reply":"partial"}', "upstream_response_truncated"),
            ("stop", '{"reply":"ok","internal":"extra"}', "invalid_response"),
            ("stop", '[]', "invalid_response"),
            ("stop", '{"reply":null}', "invalid_response"),
        ):
            response = json.dumps({"choices": [{"finish_reason": finish, "message": {"content": content}}],
                                   "usage": {"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5}}).encode()
            for target, invoke in self.clients():
                with self.subTest(finish=finish, content=content, target=target), \
                     patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key-not-real"}), \
                     patch(target, return_value=FakeResponse(response)):
                    self.assert_failure(invoke(), reason)

    def test_shared_boundary_adds_contract_for_every_caller(self):
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key-not-real"}), \
             patch("server.platform.urlopen", return_value=FakeResponse(deepseek_envelope("ok"))) as transport:
            assistant_service()._direct_deepseek_chat("Translate English", [{"role": "user", "content": "Hello"}])
        payload = json.loads(transport.call_args.args[0].data)
        self.assertIn('{"reply"', payload["messages"][0]["content"])

    def test_constructing_service_does_not_rewrite_existing_jobs(self):
        with patch.object(PlatformService, "_recover_interrupted_jobs") as recover:
            service = PlatformService()
            try:
                recover.assert_not_called()
            finally:
                service._executor.shutdown(wait=False)


if __name__ == "__main__":
    unittest.main()
