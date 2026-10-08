from __future__ import annotations

from io import BytesIO
import json
import threading
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlparse

from server.chat_stream import serve_assistant_stream
from server.platform import PlatformAPI, PlatformError
from tests.test_ai_chat_scopes import assistant_service, NotConfiguredAgent


EXAM = "exam-20250821-012345abcdef"


class Handler:
    def __init__(self, payload=None):
        raw = json.dumps(payload or {}, ensure_ascii=False).encode()
        self.headers = {"Content-Type": "application/json", "Content-Length": str(len(raw)), "Host": "127.0.0.1:4173"}
        self.rfile = BytesIO(raw)
        self.wfile = BytesIO()
        self.client_address = ("127.0.0.1", 10000)
        self.status = None
        self.response_headers = {}
        self.json = None
        self.close_connection = False

    def send_response(self, status):
        self.status = int(status)

    def send_header(self, name, value):
        self.response_headers[name] = value

    def end_headers(self):
        pass

    def _request_is_same_origin(self):
        return True

    def _json_response(self, status, body, **_kwargs):
        self.status = int(status)
        self.json = body

    def _json_error(self, status, message):
        self._json_response(status, {"error": message})


def frames(handler):
    result = []
    for frame in handler.wfile.getvalue().decode().split("\n\n"):
        if frame.startswith("event:"):
            event, data = frame.split("\ndata: ", 1)
            result.append((event[7:], json.loads(data)))
    return result


class StreamTests(unittest.TestCase):
    def test_public_source_badge_follows_executed_evidence_not_available_pdf(self):
        captured = {}
        class Sidecar:
            configured = True
            token = "offline-token"
            def tutor(self, payload):
                captured.update(payload)
                return {"schemaVersion": "cet-agent-tutor/2", "examId": payload["examId"],
                        "questionId": payload["questionId"], "reviewRevision": payload["reviewRevision"],
                        "requestId": payload["requestId"], "runId": "run", "threadId": "thread",
                        "status": "completed", "reply": "请先说明你的疑问。", "tools": [], "citations": [],
                        "intent": "general_tutoring", "trace": {"nodes": [], "durationMs": 1},
                        "generation": {"used": True},
                        "grounding": {"officialExplanationFound": False, "exactMatches": 0, "vectorMatches": 0,
                                      "disclaimer": "答案资料中没有找到官方解析，以下为 AI 辅助分析。"}}
        with patch("server.platform.AgentClient.from_environment", return_value=Sidecar()):
            result = assistant_service().assistant(EXAM, {"questionId": "q1", "message": "请说明", "conversationId": "chat-123"})
        self.assertEqual(captured["conversationId"], "chat-123")
        self.assertFalse(result["grounding"]["officialExplanationFound"])
        self.assertEqual(result["grounding"]["exactMatches"], 0)

    def test_tokenless_runtime_does_not_receive_unclearable_conversation(self):
        captured = {}
        class Sidecar:
            configured = True
            token = ""
            def tutor(self, payload):
                captured.update(payload)
                return {"schemaVersion": "cet-agent-tutor/2", "examId": payload["examId"],
                        "questionId": payload["questionId"], "reviewRevision": payload["reviewRevision"],
                        "requestId": payload["requestId"], "runId": "run", "threadId": "thread",
                        "status": "completed", "reply": "本地聊天正常。", "tools": [], "citations": [],
                        "intent": "general_tutoring", "trace": {"nodes": [], "durationMs": 1},
                        "generation": {"used": True},
                        "grounding": {"officialExplanationFound": False, "exactMatches": 0, "vectorMatches": 0, "disclaimer": ""}}
        with patch("server.platform.AgentClient.from_environment", return_value=Sidecar()):
            assistant_service().assistant(EXAM, {"questionId": "q1", "message": "请说明", "conversationId": "chat-123"})
        self.assertNotIn("conversationId", captured)

    def test_progress_is_metadata_only_and_result_is_single_call(self):
        handler = Handler()
        calls = []

        def call(emit, cancelled):
            calls.append(1)
            emit({"type": "progress", "node": "retrieve_methods", "secret": "DO_NOT_SHOW", "round": 1})
            emit({"type": "progress", "node": "unsafe\nnode", "content": "DO_NOT_SHOW"})
            return {"reply": "中文回复", "generation": {"used": False}}

        serve_assistant_stream(handler, call)
        self.assertEqual(calls, [1])
        self.assertEqual(handler.status, 200)
        self.assertTrue(handler.close_connection)
        self.assertEqual(handler.response_headers["Content-Type"], "text/event-stream; charset=utf-8")
        events = frames(handler)
        self.assertEqual([kind for kind, _value in events], ["progress", "result"])
        self.assertNotIn("DO_NOT_SHOW", handler.wfile.getvalue().decode())
        self.assertEqual(events[-1][1]["reply"], "中文回复")

    def test_only_known_platform_errors_are_public(self):
        for error, expected in ((PlatformError("题号不存在", 404), "题号不存在"), (RuntimeError("SECRET_KEY"), "AI 请求未能完成")):
            handler = Handler()
            def call(_emit, _cancelled):
                raise error
            serve_assistant_stream(handler, call)
            event = frames(handler)[-1]
            self.assertEqual(event[0], "error")
            self.assertIn(expected, event[1]["message"])
            self.assertNotIn("SECRET_KEY", handler.wfile.getvalue().decode())

    def test_disconnect_sets_cancellation_without_retry(self):
        handler = Handler()
        class BrokenWriter(BytesIO):
            def write(self, _value):
                raise BrokenPipeError()
        handler.wfile = BrokenWriter()
        observed = []
        done = threading.Event()
        def call(emit, cancelled):
            emit({"type": "progress", "node": "draft_grounded_reply"})
            observed.append(cancelled.wait(2))
            done.set()
            return {"reply": "not sent"}
        serve_assistant_stream(handler, call)
        self.assertTrue(done.wait(2))
        self.assertEqual(observed, [True])

    def test_unknown_conversation_id_is_rejected_before_any_model(self):
        service = assistant_service()
        with patch("server.platform._deepseek_key") as key:
            with self.assertRaisesRegex(PlatformError, "conversationId"):
                service.assistant(EXAM, {"scope": "general", "message": "你好", "conversationId": "bad\nidentifier"})
        key.assert_not_called()

    def test_pre_cancelled_request_is_zero_model_and_no_answer_write(self):
        event = threading.Event()
        event.set()
        with patch("server.platform._deepseek_key") as key:
            with self.assertRaisesRegex(PlatformError, "停止"):
                assistant_service().assistant(EXAM, {"scope": "general", "message": "你好"}, _cancel_event=event)
        key.assert_not_called()

    def test_stream_route_invokes_same_assistant_once(self):
        handler = Handler({"scope": "general", "message": "你好", "conversationId": "chat-123"})
        api = object.__new__(PlatformAPI)
        api.service = Mock()
        api.service.assistant.return_value = {"reply": "normal response", "conversationId": "chat-123"}
        self.assertTrue(api.handle_post(handler, urlparse(f"/api/exams/{EXAM}/assistant/stream")))
        self.assertEqual(api.service.assistant.call_count, 1)
        self.assertEqual(frames(handler)[-1][1]["reply"], "normal response")

    def test_memory_clear_is_explicit_question_scope(self):
        service = assistant_service()
        client = Mock(configured=True)
        client.clear_conversation.return_value = {"cleared": True, "conversationId": "chat-123"}
        with patch("server.platform.AgentClient.from_environment", return_value=client):
            with self.assertRaises(PlatformError):
                service.clear_assistant_conversation(EXAM, {"scope": "general", "questionId": "q1", "conversationId": "chat-123"})
            response = service.clear_assistant_conversation(EXAM, {"scope": "question", "questionId": "q1", "conversationId": "chat-123"})
        self.assertTrue(response["cleared"])
        client.clear_conversation.assert_called_once_with({"examId": EXAM, "questionId": "q1", "conversationId": "chat-123"})

    def test_memory_clear_route_requires_loopback_and_same_origin(self):
        api = object.__new__(PlatformAPI)
        api.service = Mock()
        payload = {"scope": "question", "questionId": "q1", "conversationId": "chat-123"}
        handler = Handler(payload)
        handler.client_address = ("192.0.2.5", 20000)
        self.assertTrue(api.handle_post(handler, urlparse(f"/api/exams/{EXAM}/assistant/conversations/clear")))
        self.assertEqual(handler.status, 403)
        api.service.clear_assistant_conversation.assert_not_called()


if __name__ == "__main__":
    unittest.main()
