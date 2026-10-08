"""Offline regression cases for real LangGraph tool loops and pinned memory."""

from __future__ import annotations

from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request

from services.agent import app as agent
from services.agent import runtime_tools
from server import agent_client
from server.agent_client import AgentClient, AgentProtocolError, AgentUnavailable
from tests.test_agent_runtime import tutor_request, HandlerHarness


def wire(name, arguments=None, call_id="call_1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments or {})}}


def call(name, arguments=None, call_id="call_1"):
    return runtime_tools.validate_call(wire(name, arguments, call_id))


def outcome(*calls, reply="", tokens=100):
    return agent.ToolRoundOutcome(reply=reply, calls=tuple(calls), attempted=True,
                                  usage={"promptTokens": tokens - 20, "completionTokens": 20, "totalTokens": tokens})


class ScriptedClient(agent.DeepSeekClient):
    def __init__(self, script):
        super().__init__(env={"DEEPSEEK_API_KEY": "offline-test-placeholder"})
        self.script = list(script)
        self.requests = []

    def tool_round(self, messages, *, timeout_seconds, max_tokens=1200):
        self.requests.append({"messages": deepcopy(messages), "timeout": timeout_seconds, "max_tokens": max_tokens})
        item = self.script.pop(0)
        return item() if callable(item) else item


class FakeResponse:
    def __init__(self, body, content_type="application/json"):
        self.body = BytesIO(body)
        self.headers = {"Content-Type": content_type}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, maximum):
        return self.body.read(maximum)

    def readline(self, maximum):
        return self.body.readline(maximum)


class DynamicRuntimeTests(unittest.TestCase):
    def run_agent(self, script, raw=None, callback=None, cancel=None):
        client = ScriptedClient(script)
        with TemporaryDirectory() as directory:
            runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=client)
            self.assertTrue(runtime.ready, runtime.detail)
            response = runtime.invoke_tutor(agent.validate_tutor_request(raw or tutor_request()), callback, cancel)
            runtime.close()
        return response, client

    def test_model_chooses_tools_and_observes_results_before_reply(self):
        events = []
        response, client = self.run_agent([
            outcome(call("get_current_question"), call("get_answer_record", call_id="call_2")),
            outcome(reply="上传答案资料表明 C 正确，A 不符合原文。", tokens=200)
        ], callback=events.append)
        self.assertEqual([tool["name"] for tool in response["tools"]], ["get_current_question", "get_answer_record"])
        tool_messages = [message for message in client.requests[1]["messages"] if message["role"] == "tool"]
        self.assertEqual(json.loads(tool_messages[1]["content"])["data"]["answer"], "C")
        self.assertTrue(response["grounding"]["officialEvidenceFound"])
        self.assertEqual(response["generation"]["usage"]["totalTokens"], 300)
        self.assertEqual(response["execution"]["rounds"], 2)
        self.assertEqual(response["execution"]["toolCalls"], 2)
        self.assertEqual(response["execution"]["stopReason"], "final")
        self.assertIn("execute_context_tools", response["trace"]["nodes"])
        for event in events:
            self.assertLessEqual(set(event), {"type", "node", "round", "tool"})
            self.assertNotIn("C 正确", json.dumps(event, ensure_ascii=False))

    def test_no_tool_does_not_claim_unused_official_evidence(self):
        response, client = self.run_agent([outcome(reply="请先说明你对选项的疑惑。")])
        self.assertEqual(response["tools"], [])
        self.assertEqual(response["citations"], [])
        self.assertFalse(response["grounding"]["officialEvidenceFound"])
        self.assertIn("没有找到官方解析", response["reply"])
        self.assertNotIn("The passage supports C", json.dumps(client.requests[0]["messages"]))

    def test_exact_evidence_tool_retrieves_and_cites_current_question(self):
        response, client = self.run_agent([
            outcome(call("retrieve_evidence", {"query": "passage", "limit": 1})), outcome(reply="依据答案资料，本题应选 C。")
        ])
        tool_result = json.loads(client.requests[1]["messages"][-1]["content"])
        self.assertEqual(tool_result["data"][0]["questionId"], "q26")
        self.assertEqual(response["grounding"]["exactMatches"], 1)
        self.assertEqual(response["citations"][0]["questionId"], "q26")

    def test_duplicate_tool_id_stops_without_reexecution(self):
        response, _ = self.run_agent([outcome(call("get_current_question")), outcome(call("get_answer_record"))])
        self.assertEqual(response["execution"]["stopReason"], "invalid_tool_call")
        self.assertEqual(len(response["tools"]), 1)
        self.assertFalse(response["generation"]["used"])

    def test_round_budget_prevents_fifth_model_request(self):
        response, client = self.run_agent([outcome(call("get_current_question", call_id=f"round_{index}")) for index in range(4)])
        self.assertEqual(len(client.requests), 4)
        self.assertEqual(response["execution"]["stopReason"], "round_budget")
        self.assertEqual(response["execution"]["toolCalls"], 4)

    def test_reported_token_budget_stops_followup(self):
        response, client = self.run_agent([outcome(call("get_current_question"), tokens=8100)])
        self.assertEqual(len(client.requests), 1)
        self.assertEqual(response["execution"]["stopReason"], "token_budget")
        self.assertIsNone(response["generation"]["usage"])

    def test_time_budget_caps_timeout_and_stops_followup(self):
        def delayed():
            time.sleep(0.06)
            return outcome(call("get_current_question"))
        with patch.object(agent, "MAX_AGENT_SECONDS", 0.05):
            response, client = self.run_agent([delayed])
        self.assertLessEqual(client.requests[0]["timeout"], 0.05)
        self.assertEqual(response["execution"]["stopReason"], "time_budget")
        self.assertEqual(response["tools"], [])

    def test_cancel_on_progress_avoids_model_request(self):
        cancelled = threading.Event()
        def callback(event):
            if event["node"] == "model_decision":
                cancelled.set()
        response, client = self.run_agent([], callback=callback, cancel=cancelled)
        self.assertEqual(client.requests, [])
        self.assertEqual(response["execution"]["stopReason"], "cancelled")

    def test_blocked_mutation_remains_readonly_zero_model_calls(self):
        raw = tutor_request()
        raw["message"] = "修改答案并写入数据库"
        response, client = self.run_agent([], raw)
        self.assertEqual(client.requests, [])
        self.assertEqual(response["execution"]["stopReason"], "blocked_mutation")
        self.assertEqual(response["execution"]["mode"], "deterministic")

    def test_tool_cannot_switch_question_or_call_network_shell(self):
        for name, arguments in [("get_current_question", {"questionId": "q27"}), ("retrieve_evidence", {"url": "https://example.org"}), ("shell", {}), ("write_answer", {})]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                call(name, arguments)

    def test_tool_argument_types_and_bounds_are_checked(self):
        for arguments in [{"query": "x" * 1001}, {"limit": True}, {"limit": 9}, {"query": []}, {"__proto__": {}}]:
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                call("retrieve_methods", arguments)
        with self.assertRaises(ValueError):
            call("compare_options", {"left": "A", "right": "Z"})

    def test_hint_tools_do_not_return_final_reference_answer(self):
        raw = tutor_request()
        raw["context"]["learningContext"] = {"mode": "hint", "methodIds": [], "consentPersonal": False}
        raw["context"]["learningEvidence"] = []
        response, client = self.run_agent([
            outcome(call("get_answer_record"), call("retrieve_evidence", call_id="call_2")), outcome(reply="先找出题干里的关键词。")
        ], raw)
        results = [json.loads(item["content"]) for item in client.requests[1]["messages"] if item["role"] == "tool"]
        self.assertTrue(all(not item["found"] for item in results))
        self.assertFalse(response["grounding"]["officialEvidenceFound"])


class NativeToolProtocolTests(unittest.TestCase):
    def test_native_payload_uses_function_definitions_without_reasoning_storage(self):
        client = agent.DeepSeekClient(env={"DEEPSEEK_API_KEY": "offline-test-placeholder"})
        body = {"choices": [{"finish_reason": "tool_calls", "message": {"tool_calls": [wire("get_current_question")], "reasoning_content": "never persist this"}}]}
        with patch.object(agent, "urlopen", return_value=FakeResponse(json.dumps(body).encode())) as request:
            result = client.tool_round([{"role": "user", "content": "读题"}], timeout_seconds=5)
        sent = json.loads(request.call_args.args[0].data)
        self.assertEqual(sent["thinking"], {"type": "disabled"})
        self.assertEqual({tool["function"]["name"] for tool in sent["tools"]}, runtime_tools.TOOL_NAMES)
        self.assertEqual(result.calls[0]["name"], "get_current_question")
        self.assertNotIn("reasoning_content", result.calls[0])
        self.assertEqual(request.call_args.kwargs["timeout"], 5)

    def test_disallowed_malformed_and_duplicate_calls_are_rejected_before_execution(self):
        for calls in [[wire("shell")], [wire("get_current_question", {"questionId": "q27"})], [wire("get_current_question"), wire("get_answer_record")]]:
            client = agent.DeepSeekClient(env={"DEEPSEEK_API_KEY": "offline-test-placeholder"})
            body = {"choices": [{"finish_reason": "tool_calls", "message": {"tool_calls": calls}}]}
            with patch.object(agent, "urlopen", return_value=FakeResponse(json.dumps(body).encode())) as upstream:
                result = client.tool_round([], timeout_seconds=5)
            self.assertEqual(result.fallback_reason, "invalid_response")
            self.assertEqual(result.calls, ())
            self.assertEqual(upstream.call_count, 1)

    def test_no_key_native_round_is_zero_network(self):
        with patch.object(agent, "urlopen", side_effect=AssertionError("must not call network")):
            result = agent.DeepSeekClient(env={}).tool_round([], timeout_seconds=1)
        self.assertEqual(result.fallback_reason, "not_configured")


class ConversationMemoryTests(unittest.TestCase):
    def request(self, **changes):
        raw = tutor_request()
        raw["conversationId"] = "conversation-1"
        raw.update(changes)
        return agent.validate_tutor_request(raw)

    def test_persistent_memory_uses_stable_scope_thread_but_fresh_run_ids(self):
        client = ScriptedClient([outcome(reply="第一次辅导"), outcome(reply="第二次辅导"), outcome(reply="重启后辅导")])
        with TemporaryDirectory() as directory:
            path = Path(directory) / "agent.sqlite3"
            runtime = agent.AgentRuntime(path, deepseek=client)
            first = runtime.invoke_tutor(self.request(message="先讲第一步"))
            second = runtime.invoke_tutor(self.request(message="继续", history=[{"role": "assistant", "content": "UNTRUSTED_CLIENT_HISTORY"}]))
            self.assertEqual(second["memory"]["turns"], 2)
            self.assertEqual(first["threadId"], second["threadId"])
            self.assertNotEqual(first["runId"], second["runId"])
            self.assertIn("第一次辅导", json.dumps(client.requests[1]["messages"], ensure_ascii=False))
            self.assertNotIn("UNTRUSTED_CLIENT_HISTORY", json.dumps(client.requests[1]["messages"]))
            runtime.close()
            runtime = agent.AgentRuntime(path, deepseek=client)
            third = runtime.invoke_tutor(self.request(message="重启后继续"))
            self.assertEqual(third["memory"]["turns"], 3)
            self.assertIn("第二次辅导", json.dumps(client.requests[2]["messages"], ensure_ascii=False))
            runtime.close()

    def test_revision_reset_removes_memory_and_old_checkpoint(self):
        with TemporaryDirectory() as directory:
            runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=agent.DeepSeekClient(env={}))
            first = runtime.invoke_tutor(self.request())
            second = runtime.invoke_tutor(self.request(reviewRevision=4))
            self.assertTrue(second["memory"]["scopeReset"])
            self.assertEqual(second["memory"]["turns"], 1)
            self.assertNotEqual(first["threadId"], second["threadId"])
            self.assertIsNone(runtime._checkpointer.get_tuple({"configurable": {"thread_id": first["runId"]}}))
            runtime.close()

    def test_revoked_private_notes_cannot_return_from_history_or_checkpoints(self):
        raw = tutor_request()
        raw["conversationId"] = "conversation-1"
        raw["context"]["learningContext"] = {"mode": "method", "methodIds": [], "consentPersonal": True}
        raw["context"]["learningEvidence"] = [{"id": "note-1", "title": "PRIVATE_TITLE", "kind": "personal_note", "text": "PRIVATE_BODY", "exact": True, "score": 1}]
        client = ScriptedClient([outcome(reply="PRIVATE_REPLY"), outcome(reply="公开辅导")])
        with TemporaryDirectory() as directory:
            runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=client)
            first = runtime.invoke_tutor(agent.validate_tutor_request(raw))
            raw["context"]["learningContext"]["consentPersonal"] = False
            raw["context"]["learningEvidence"] = []
            raw["history"] = [{"role": "assistant", "content": "PRIVATE_REPLY"}]
            second = runtime.invoke_tutor(agent.validate_tutor_request(raw))
            self.assertTrue(second["memory"]["scopeReset"])
            self.assertNotIn("PRIVATE", json.dumps(client.requests[1]["messages"]))
            self.assertIsNone(runtime._checkpointer.get_tuple({"configurable": {"thread_id": first["runId"]}}))
            runtime.close()

    def test_private_note_content_change_with_same_id_resets_scope(self):
        raw = tutor_request()
        raw["conversationId"] = "conversation-1"
        raw["context"]["learningContext"] = {"mode": "method", "methodIds": [], "consentPersonal": True}
        raw["context"]["learningEvidence"] = [{"id": "note-1", "title": "笔记", "kind": "personal_note", "text": "旧内容", "exact": True, "score": 1}]
        with TemporaryDirectory() as directory:
            runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=agent.DeepSeekClient(env={}))
            runtime.invoke_tutor(agent.validate_tutor_request(raw))
            raw["context"]["learningEvidence"][0]["text"] = "修改后的内容"
            response = runtime.invoke_tutor(agent.validate_tutor_request(raw))
            self.assertTrue(response["memory"]["scopeReset"])
            runtime.close()

    def test_question_and_conversation_isolation_and_clear_exact_scope(self):
        with TemporaryDirectory() as directory:
            runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=agent.DeepSeekClient(env={}))
            first = runtime.invoke_tutor(self.request())
            other = runtime.invoke_tutor(self.request(conversationId="conversation-2"))
            response = runtime.clear_conversation({"examId": first["examId"], "questionId": "q26", "conversationId": "conversation-1"})
            self.assertTrue(response["cleared"])
            self.assertIsNone(runtime._checkpointer.get_tuple({"configurable": {"thread_id": first["runId"]}}))
            self.assertIsNotNone(runtime._checkpointer.get_tuple({"configurable": {"thread_id": other["runId"]}}))
            replay = runtime.invoke_tutor(self.request())
            self.assertEqual(replay["memory"]["turns"], 1)
            runtime.close()

    def test_memory_turns_bounded_with_extractive_summary(self):
        with TemporaryDirectory() as directory:
            runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=agent.DeepSeekClient(env={}))
            for index in range(8):
                response = runtime.invoke_tutor(self.request(message=f"问题{index}"))
            self.assertEqual(response["memory"]["turns"], 6)
            self.assertTrue(response["memory"]["summaryPresent"])
            stored = runtime._connection.execute("SELECT turns,summary FROM cet_agent_memory").fetchone()
            self.assertEqual(len(json.loads(stored[0])), 12)
            self.assertLessEqual(len(stored[1]), 1200)
            runtime.close()

    def test_cancelled_run_never_appends_memory(self):
        cancelled = threading.Event()
        def callback(event):
            if event["node"] == "model_decision":
                cancelled.set()
        with TemporaryDirectory() as directory:
            runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=ScriptedClient([]))
            response = runtime.invoke_tutor(self.request(), callback, cancelled)
            self.assertEqual(response["execution"]["stopReason"], "cancelled")
            self.assertEqual(runtime._connection.execute("SELECT count(*) FROM cet_agent_memory").fetchone()[0], 0)
            self.assertEqual(response["memory"]["turns"], 0)
            runtime.close()

    def test_clear_endpoint_requires_authentication_and_exact_payload(self):
        body = json.dumps({"examId": "exam-1", "questionId": "q26", "conversationId": "conversation-1"}).encode()
        with TemporaryDirectory() as directory:
            runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=agent.DeepSeekClient(env={}))
            application = agent.AgentApplication(token="local-test-token", runtime=runtime)
            with patch.object(agent, "APPLICATION", application):
                denied = HandlerHarness("/v1/conversations/clear", {"Content-Type": "application/json", "Content-Length": str(len(body))}, body)
                denied.do_POST()
                self.assertEqual(denied.response_status, 401)
                allowed = HandlerHarness("/v1/conversations/clear", {"Content-Type": "application/json", "Content-Length": str(len(body)), "Authorization": "Bearer local-test-token"}, body)
                allowed.do_POST()
                self.assertEqual(allowed.response_status, 200)
            with self.assertRaises(agent.RequestError):
                runtime.clear_conversation({"examId": "exam-1", "questionId": "q26", "conversationId": "../invalid", "extra": True})
            runtime.close()

    def test_tokenless_http_tutors_reject_persistent_memory_before_execution(self):
        raw = {**tutor_request(), "conversationId": "conversation-1"}
        body = json.dumps(raw).encode()
        with TemporaryDirectory() as directory:
            runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=agent.DeepSeekClient(env={}))
            application = agent.AgentApplication(token="", runtime=runtime)
            for path in ("/v1/tutor", "/v1/tutor/stream"):
                with self.subTest(path=path), patch.object(agent, "APPLICATION", application):
                    handler = HandlerHarness(path, {"Content-Type": "application/json", "Content-Length": str(len(body))}, body)
                    handler.do_POST()
                    self.assertEqual(handler.response_status, 401)
                    self.assertEqual(handler.document()["error"]["code"], "unauthorized")
            self.assertEqual(runtime._connection.execute("SELECT count(*) FROM cet_agent_memory").fetchone()[0], 0)
            self.assertEqual(runtime._connection.execute("SELECT count(*) FROM cet_agent_memory_runs").fetchone()[0], 0)
            with self.assertRaises(agent.MemoryAuthorizationRequired):
                application.process("/v1/tutor", raw)
            # Existing tokenless stateless tutoring still works normally.
            response = application.process("/v1/tutor", tutor_request())
            self.assertEqual(response["status"], "completed")
            self.assertFalse(response["memory"]["enabled"])
            runtime.close()

    def test_queued_request_started_before_clear_cannot_resurrect_memory(self):
        class ObservedLock:
            def __init__(self):
                self.lock = threading.RLock()
                self.waiting = threading.Event()
            def acquire(self, timeout=-1):
                if threading.current_thread().name == "queued-old-tutor":
                    self.waiting.set()
                return self.lock.acquire(timeout=timeout)
            def release(self):
                self.lock.release()
            def __enter__(self):
                self.acquire()
                return self
            def __exit__(self, *args):
                self.release()
        with TemporaryDirectory() as directory:
            client = ScriptedClient([])
            runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=client)
            self.assertTrue(runtime.ready)
            lock = ObservedLock()
            runtime._invoke_lock = lock
            result = {}
            def invoke_queued():
                result.update(runtime.invoke_tutor(self.request()))
            with lock:
                thread = threading.Thread(target=invoke_queued, name="queued-old-tutor")
                thread.start()
                self.assertTrue(lock.waiting.wait(2))
                # Same-thread RLock clear wins while old request is queued.
                runtime.clear_conversation({"examId": self.request()["examId"], "questionId": "q26", "conversationId": "conversation-1"})
            thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(result["execution"]["stopReason"], "cancelled")
            self.assertEqual(client.requests, [])
            self.assertEqual(runtime._connection.execute("SELECT count(*) FROM cet_agent_memory").fetchone()[0], 0)
            self.assertEqual(runtime._connection.execute("SELECT count(*) FROM cet_agent_memory_runs").fetchone()[0], 0)
            # Unchanged public protocol is still accepted by the main adapter.
            with patch.object(AgentClient, "_request", return_value=result):
                checked = AgentClient("http://127.0.0.1:8770").tutor({**tutor_request(), "conversationId": "conversation-1"})
            self.assertTrue(checked["memory"]["scopeReset"])
            client.script = [outcome(reply="删除后新对话")]
            fresh = runtime.invoke_tutor(self.request())
            self.assertEqual(fresh["execution"]["stopReason"], "final")
            self.assertEqual(fresh["memory"]["turns"], 1)
            runtime.close()

    def test_clear_marker_survives_restart_but_fresh_started_request_is_allowed(self):
        with TemporaryDirectory() as directory:
            path = Path(directory) / "agent.sqlite3"
            runtime = agent.AgentRuntime(path, deepseek=agent.DeepSeekClient(env={}))
            self.assertTrue(runtime.ready)
            request = self.request()
            owner, _ = agent.memory_identity(request)
            started_ns = time.time_ns()
            runtime.clear_conversation({"examId": request["examId"], "questionId": request["questionId"], "conversationId": request["conversationId"]})
            runtime.close()
            runtime = agent.AgentRuntime(path, deepseek=agent.DeepSeekClient(env={}))
            self.assertTrue(runtime.ready)
            self.assertTrue(runtime._memory.cleared_after(owner, started_ns))
            self.assertFalse(runtime._memory.cleared_after(owner, time.time_ns()))
            runtime.close()

    def test_clear_at_memory_save_boundary_cancels_save_and_removes_checkpoint(self):
        with TemporaryDirectory() as directory:
            runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=ScriptedClient([outcome(reply="正常辅导")]))
            request = self.request()
            def callback(event):
                if event["node"] == "memory_save":
                    runtime.clear_conversation({"examId": request["examId"], "questionId": request["questionId"], "conversationId": request["conversationId"]})
            response = runtime.invoke_tutor(request, callback)
            self.assertEqual(response["execution"]["stopReason"], "cancelled")
            self.assertFalse(response["generation"]["used"])
            self.assertEqual(response["memory"]["turns"], 0)
            self.assertTrue(response["memory"]["scopeReset"])
            self.assertEqual(runtime._connection.execute("SELECT count(*) FROM cet_agent_memory").fetchone()[0], 0)
            self.assertIsNone(runtime._checkpointer.get_tuple({"configurable": {"thread_id": response["runId"]}}))
            runtime.close()

    def test_transient_model_failures_and_budgets_do_not_pollute_memory(self):
        scripts = [[agent.ToolRoundOutcome(attempted=True, fallback_reason="upstream_timeout")],
                   [outcome(call("get_current_question"), tokens=8100)]]
        for script in scripts:
            with self.subTest(script=script), TemporaryDirectory() as directory:
                runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=ScriptedClient(script))
                response = runtime.invoke_tutor(self.request())
                self.assertEqual(response["memory"]["turns"], 0)
                self.assertEqual(runtime._connection.execute("SELECT count(*) FROM cet_agent_memory").fetchone()[0], 0)
                runtime.close()

    def test_failed_run_private_checkpoint_is_discarded_before_fresh_context(self):
        raw = tutor_request()
        raw["conversationId"] = "conversation-1"
        raw["context"]["learningContext"] = {"mode": "method", "methodIds": [], "consentPersonal": True}
        raw["context"]["learningEvidence"] = [{"id": "note-1", "title": "私有笔记", "kind": "personal_note", "text": "PRIVATE_BODY", "exact": True, "score": 1}]
        client = ScriptedClient([agent.ToolRoundOutcome(attempted=True, fallback_reason="upstream_timeout"), outcome(reply="重新辅导")])
        with TemporaryDirectory() as directory:
            runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=client)
            failed = runtime.invoke_tutor(agent.validate_tutor_request(raw))
            self.assertEqual(failed["memory"]["turns"], 0)
            self.assertIsNotNone(runtime._checkpointer.get_tuple({"configurable": {"thread_id": failed["runId"]}}))
            raw["context"]["learningContext"]["consentPersonal"] = False
            raw["context"]["learningEvidence"] = []
            fresh = runtime.invoke_tutor(agent.validate_tutor_request(raw))
            self.assertTrue(fresh["memory"]["scopeReset"])
            self.assertIsNone(runtime._checkpointer.get_tuple({"configurable": {"thread_id": failed["runId"]}}))
            runtime.close()


class StreamClientTests(unittest.TestCase):
    def test_stream_progress_and_final_use_same_strict_response_validation(self):
        with TemporaryDirectory() as directory:
            runtime = agent.AgentRuntime(Path(directory) / "agent.sqlite3", deepseek=agent.DeepSeekClient(env={}))
            response = runtime.invoke_tutor(agent.validate_tutor_request(tutor_request()))
            runtime.close()
        frames = [{"type": "metadata", "schemaVersion": "cet-agent-stream/1"}, {"type": "progress", "node": "retrieve_grounded_evidence"}, {"type": "result", "result": response}]
        encoded = b"".join(f"event: {item['type']}\ndata: {json.dumps(item)}\n\n".encode() for item in frames)
        events = []
        with patch("server.agent_client.urlopen", return_value=FakeResponse(encoded, "text/event-stream")) as upstream:
            checked = AgentClient("http://127.0.0.1:8770").tutor_stream(tutor_request(), events.append)
        self.assertEqual(upstream.call_count, 1)
        self.assertEqual(checked["execution"]["stopReason"], "not_configured")
        self.assertEqual(events, [frames[1]])

    def test_unsafe_progress_and_bad_final_are_rejected_without_retry(self):
        for event in [{"type": "progress", "node": "shell", "command": "rm"}, {"type": "result", "result": {"reply": "unsafe"}}]:
            encoded = f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode()
            with patch("server.agent_client.urlopen", return_value=FakeResponse(encoded, "text/event-stream")) as upstream, self.assertRaises(AgentProtocolError):
                AgentClient("http://127.0.0.1:8770").tutor_stream(tutor_request())
            self.assertEqual(upstream.call_count, 1)

    def test_stream_cancel_before_read_closes_without_retry(self):
        cancelled = threading.Event()
        cancelled.set()
        with patch("server.agent_client.urlopen", return_value=FakeResponse(b"", "text/event-stream")) as upstream, self.assertRaises(AgentUnavailable):
            AgentClient("http://127.0.0.1:8770").tutor_stream(tutor_request(), None, cancelled)
        self.assertEqual(upstream.call_count, 1)


class TransportSecurityTests(unittest.TestCase):
    def test_loopback_ignores_proxy_environment_for_agent_and_model(self):
        request = Request("http://127.0.0.1:8770/healthz", headers={"Authorization": "Bearer local-test-token"})
        for module in (agent_client, agent):
            with self.subTest(module=module.__name__), patch.object(module, "build_opener") as builder:
                module.urlopen(request, timeout=1)
                self.assertEqual(builder.call_args.args[0].proxies, {})
                builder.return_value.open.assert_called_once_with(request, timeout=1)

    def test_redirect_is_rejected_before_any_credential_forwarding(self):
        request = Request("http://127.0.0.1:8770/healthz", headers={"Authorization": "Bearer local-test-token"})
        for handler in (agent_client._NoCredentialRedirect(), agent._NoModelCredentialRedirect()):
            with self.subTest(handler=type(handler).__name__), self.assertRaises(HTTPError):
                handler.redirect_request(request, None, 302, "Found", {}, "https://untrusted.example.org/")
