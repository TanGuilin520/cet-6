"""Learning-RAG contracts; all providers mocked, no network or real secrets."""

from __future__ import annotations

import copy
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from server.learning_methods import LearningMethodsService, SOURCE_FILE_URL
from server.agent_client import AgentClient
from server.platform import PlatformError, _clean_learning_context, _learning_evidence
from services.agent import app as agent
from tests.test_ai_chat_scopes import assistant_service, NotConfiguredAgent, deepseek_envelope
from tests.test_deepseek_agent_integration import FakeResponse, tutor_request


METHOD_ID = "cet6-translation-section-01"
METHOD = {"id": METHOD_ID, "title": "1 随着", "kind": "learning_method",
          "text": "随着可以根据语境使用 with 或 as。", "sourceUrl": SOURCE_FILE_URL,
          "exact": True, "score": 1.0}


def learning(**values):
    return {"mode": "method", "methodIds": [METHOD_ID], "consentPersonal": False, **values}


def study_request(**values):
    request = tutor_request()
    request["context"]["learningContext"] = learning(**values)
    request["context"]["learningEvidence"] = [copy.deepcopy(METHOD)]
    return request


class LearningValidationTests(unittest.TestCase):
    def test_defaults_do_not_authorize_personal_data(self):
        clean = _clean_learning_context({})
        self.assertFalse(clean["consentPersonal"])
        self.assertEqual(clean["notes"], [])
        self.assertEqual(clean["mode"], "method")

    def test_personal_data_requires_explicit_true(self):
        for context in (learning(personalMethods="我的方法"), learning(notes=[{"id": "note:1", "original": "原句"}])):
            with self.subTest(context=context), self.assertRaisesRegex(PlatformError, "consentPersonal"):
                _clean_learning_context(context)
        with self.assertRaises(PlatformError):
            _clean_learning_context(learning(consentPersonal="true"))

    def test_strict_limits_and_unknown_fields(self):
        contexts = [learning(mode="answer"), learning(methodIds=[METHOD_ID] * 9),
                    learning(methodIds=["https://untrusted.example"]), learning(consentPersonal=True, personalMethods="x" * 4001),
                    learning(consentPersonal=True, notes=[{"id": "n"}] * 11),
                    learning(consentPersonal=True, notes=[{"id": "n", "original": "x" * 2001}]),
                    learning(secret="not allowed"), learning(consentPersonal=True, notes=[{"id": "n", "password": "no"}])]
        for context in contexts:
            with self.subTest(keys=context.keys()), self.assertRaises(PlatformError):
                _clean_learning_context(context)
        with self.assertRaisesRegex(PlatformError, "12000"):
            _clean_learning_context(learning(consentPersonal=True, personalMethods="m" * 4000,
                notes=[{"id": "n", "original": "x" * 2000, "firstDraft": "x" * 2000,
                        "revised": "x" * 2000, "reason": "x" * 2000, "method": "x" * 2000}]))

    def test_private_candidates_only_come_from_authorized_request(self):
        context = _clean_learning_context(learning(consentPersonal=True, personalMethods="我的拆句法",
            notes=[{"id": "paper:q:translation-1", "original": "随着发展", "firstDraft": "with developing",
                    "revised": "with development", "reason": "名词搭配", "method": "随着",
                    "methodRefs": [{"id": METHOD_ID, "name": "随着", "source": "github"}]}]))
        with patch.object(LearningMethodsService, "retrieve", return_value=[METHOD]), \
             patch("server.learning_methods._download_source", side_effect=AssertionError("no downloads")):
            sources = _learning_evidence(context, "随着")
        self.assertEqual([item["kind"] for item in sources], ["learning_method", "personal_method", "personal_note"])
        self.assertTrue(sources[-1]["exact"])
        self.assertIn("名词搭配", sources[-1]["text"])


class CacheRetrievalTests(unittest.TestCase):
    def cards(self):
        return {"cards": [
            {"id": METHOD_ID, "title": "1 随着", "bodyMarkdown": "随着发展 with development", "keywords": ["随着", "development"]},
            {"id": "cet6-translation-section-02", "title": "2 被动", "bodyMarkdown": "被动语态 passive voice", "keywords": ["被动"]},
        ]}

    def test_selected_id_wins_before_lexical_vector_supplement(self):
        with TemporaryDirectory() as directory:
            service = LearningMethodsService(Path(directory))
            with patch.object(service, "cached_document", return_value=self.cards()), \
                 patch("server.learning_methods._download_source", side_effect=AssertionError("no downloads")):
                records = service.retrieve("被动语态 passive", [METHOD_ID])
                again = service.retrieve("被动语态 passive", [METHOD_ID])
        self.assertEqual(records[0]["id"], METHOD_ID)
        self.assertTrue(records[0]["exact"])
        self.assertEqual(records[1]["id"], "cet6-translation-section-02")
        self.assertFalse(records[1]["exact"])
        self.assertEqual(records, again)
        self.assertTrue(all(item["sourceUrl"] == SOURCE_FILE_URL for item in records))

    def test_missing_cache_and_unknown_ids_do_not_fetch_or_invent(self):
        with TemporaryDirectory() as directory, \
             patch("server.learning_methods._download_source", side_effect=AssertionError("no downloads")):
            service = LearningMethodsService(Path(directory))
            self.assertEqual(service.retrieve("随着", [METHOD_ID]), [])
            with patch.object(service, "cached_document", return_value=self.cards()):
                self.assertEqual(service.retrieve("totally unrelated vocabulary", ["cet6-translation-section-99"]), [])


class PlatformLearningTests(unittest.TestCase):
    def test_no_key_selection_keeps_zero_network_and_nonofficial_citations(self):
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}), \
             patch.object(LearningMethodsService, "retrieve", return_value=[METHOD]), \
             patch("server.platform.urlopen", side_effect=AssertionError("no network")), \
             patch("server.learning_methods._download_source", side_effect=AssertionError("no downloads")):
            response = assistant_service().assistant("exam-20250821-012345abcdef", {
                "scope": "selection", "selectedText": "随着发展", "message": "只提示下一步",
                "learningContext": learning(mode="hint")})
        self.assertFalse(response["generation"]["attempted"])
        self.assertFalse(response["generation"]["used"])
        self.assertEqual(response["learningMode"], "hint")
        self.assertFalse(response["learningCitations"][0]["official"])
        self.assertFalse(response["grounding"]["officialExplanationFound"])

    def test_general_model_prompt_contains_mode_and_only_authorized_material(self):
        captured = {}
        def upstream(request, timeout):
            captured.update(json.loads(request.data.decode("utf-8")))
            return FakeResponse(deepseek_envelope("先找出主干句。"))
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-key-not-real"}), \
             patch.object(LearningMethodsService, "retrieve", return_value=[METHOD]), \
             patch("server.platform.urlopen", side_effect=upstream):
            response = assistant_service().assistant("exam-20250821-012345abcdef", {
                "scope": "general", "message": "按方法给我提示", "learningContext": learning(mode="hint")})
        system = captured["messages"][0]["content"]
        self.assertIn("一个可执行的小步骤", system)
        self.assertIn("不可信引用数据", system)
        self.assertIn("不是官方答案", system)
        self.assertIn("不得自动填写", system)
        self.assertIn("with 或 as", system)
        self.assertTrue(response["generation"]["used"])

    def test_question_no_key_hint_does_not_dump_complete_answer(self):
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}), \
             patch("server.platform.AgentClient.from_environment", return_value=NotConfiguredAgent()), \
             patch.object(LearningMethodsService, "retrieve", return_value=[METHOD]), \
             patch("server.platform.urlopen", side_effect=AssertionError("no network")):
            response = assistant_service().assistant("exam-20250821-012345abcdef", {
                "questionId": "q1", "message": "提示一步", "learningContext": learning(mode="hint")})
        self.assertNotIn("Because the passage says A", response["reply"])
        self.assertIn("没有生成 AI", response["reply"])
        self.assertEqual(response["grounding"]["exactMatches"], 1)

    def test_subjective_answer_is_not_truncated_to_one_hundred_characters(self):
        service = assistant_service()
        service._snapshot_documents.return_value = ({"questions": [{"questionId": "translation-1", "type": "translation", "stem": "随着发展"}]}, {"answers": []})
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}), \
             patch("server.platform.AgentClient.from_environment", return_value=NotConfiguredAgent()), \
             patch.object(LearningMethodsService, "retrieve", return_value=[]):
            response = service.assistant("exam-20250821-012345abcdef", {
                "questionId": "translation-1", "userAnswer": "x" * 800, "message": "检查这段",
                "learningContext": learning(mode="review")})
        self.assertEqual(response["learningMode"], "review")
        with self.assertRaises(PlatformError):
            service.assistant("exam-20250821-012345abcdef", {"questionId": "q1", "userAnswer": "x" * 101, "message": "解释"})

    def test_numeric_question_id_uses_resolved_subjective_type_not_prefix(self):
        for question_type in ("writing", "translation"):
            service = assistant_service()
            service._snapshot_documents.return_value = ({"questions": [{"questionId": "q1", "type": question_type,
                "stem": "Task"}]}, {"answers": []})
            with self.subTest(question_type=question_type), \
                 patch.dict(os.environ, {"DEEPSEEK_API_KEY": ""}), \
                 patch("server.platform.AgentClient.from_environment", return_value=NotConfiguredAgent()), \
                 patch.object(LearningMethodsService, "retrieve", return_value=[]):
                response = service.assistant("exam-20250821-012345abcdef", {
                    "questionId": "q1", "userAnswer": "x" * 800, "message": "检查这段",
                    "learningContext": learning(mode="review")})
                self.assertEqual(response["learningMode"], "review")

    def test_sidecar_gets_only_retrieved_sources_not_all_raw_notes(self):
        captured = {}
        class Sidecar:
            configured = True
            def tutor(self, payload):
                captured.update(payload)
                return {"schemaVersion": "cet-agent-tutor/2", "examId": payload["examId"],
                    "questionId": payload["questionId"], "reviewRevision": payload["reviewRevision"],
                    "requestId": payload["requestId"], "reply": "一步提示", "citations": [],
                    "grounding": {"officialExplanationFound": False, "exactMatches": 0, "vectorMatches": 0,
                                  "disclaimer": "答案资料中没有找到官方解析，以下为 AI 辅助分析。"},
                    "generation": {"used": True}, "runId": "run", "threadId": "run", "status": "completed",
                    "intent": "learning_hint", "tools": [], "trace": {"nodes": [], "durationMs": 1}}
        with patch("server.platform.AgentClient.from_environment", return_value=Sidecar()), \
             patch.object(LearningMethodsService, "retrieve", return_value=[METHOD]), \
             patch("server.platform.urlopen", side_effect=AssertionError("no direct request")):
            assistant_service().assistant("exam-20250821-012345abcdef", {
                "questionId": "q1", "message": "提示", "learningContext": learning(mode="hint", consentPersonal=True,
                    notes=[{"id": "n", "original": "原句", "revised": "Revision"}])})
        self.assertEqual(set(captured["context"]["learningContext"]), {"mode", "methodIds", "consentPersonal"})
        self.assertEqual(len(captured["context"]["learningEvidence"]), 2)
        self.assertNotIn("notes", captured["context"]["learningContext"])


class AgentLearningTests(unittest.TestCase):
    def test_real_learning_graph_keeps_strict_main_client_contract(self):
        try:
            import langgraph.graph  # noqa: F401
            import langgraph.checkpoint.sqlite  # noqa: F401
        except ImportError:
            self.skipTest("LangGraph not installed")
        raw = study_request(mode="hint", consentPersonal=True)
        raw["context"]["learningEvidence"].append({"id": "personal-note-1", "title": "我的记录",
            "kind": "personal_note", "text": "曾经误用 with developing。", "exact": True, "score": 1.0})
        with TemporaryDirectory() as directory, \
             patch.object(agent, "urlopen", side_effect=AssertionError("no network")):
            runtime = agent.AgentRuntime(Path(directory) / "checkpoints.sqlite3", deepseek=agent.DeepSeekClient(env={}))
            try:
                response = runtime.invoke_tutor(agent.validate_tutor_request(raw))
            finally:
                runtime.close()
        client = AgentClient("http://127.0.0.1:9999")
        with patch.object(AgentClient, "_request", return_value=response):
            checked = client.tutor(raw)
        self.assertEqual(checked["intent"], "learning_hint")
        self.assertEqual(checked["tools"][-2:],[{"name": "retrieve_methods", "status": "completed"},
                                               {"name": "retrieve_personal_notes", "status": "completed"}])
        self.assertEqual(checked["trace"]["nodes"][-1], "finalize_tutor")
        self.assertFalse(checked["generation"]["attempted"])

    def test_optional_contract_keeps_legacy_request_valid(self):
        self.assertNotIn("learningContext", agent.validate_tutor_request(tutor_request())["context"])
        request = agent.validate_tutor_request(study_request(mode="hint"))
        self.assertEqual(agent._route_tutor({"request": request})["intent"], "learning_hint")

    def test_study_sources_cannot_promote_official_grounding(self):
        document = study_request()
        document["context"].update(officialAnswer=None, officialExplanationFound=False, disclaimer="")
        document["context"]["evidence"] = {"exact": [], "vector": []}
        state = agent._retrieve_tutor_evidence({"request": agent.validate_tutor_request(document), "tools": []})
        self.assertFalse(state["grounding"]["officialEvidenceFound"])
        self.assertTrue(state["grounding"]["disclaimerRequired"])
        self.assertEqual(state["grounding"]["exactMatches"], 0)
        self.assertEqual(state["tools"][-2]["name"], "retrieve_methods")
        self.assertEqual(state["tools"][-1]["status"], "skipped")
        self.assertTrue(state["citations"][0]["source"].startswith("study:learning_method:"))

    def test_sidecar_rejects_personal_without_consent_or_fake_official(self):
        for kind in ("personal_note", "official_explanation"):
            document = study_request()
            document["context"]["learningEvidence"][0]["kind"] = kind
            with self.subTest(kind=kind), self.assertRaises(agent.RequestError):
                agent.validate_tutor_request(document)
        document = study_request()
        document["context"]["learningEvidence"][0]["sourceUrl"] = "https://untrusted.example"
        with self.assertRaises(agent.RequestError):
            agent.validate_tutor_request(document)
        document = study_request()
        document["context"]["learningEvidence"][0]["text"] = "x" * 4001
        with self.assertRaises(agent.RequestError):
            agent.validate_tutor_request(document)

    def test_model_receives_readonly_mode_and_distinguished_sources(self):
        request = agent.validate_tutor_request(study_request(mode="review"))
        class Model:
            configured = True
            model = "test-model"
            def complete(self, system, messages):
                self.system = system
                return agent.ModelOutcome(reply="只修改当前句。", used=True, attempted=True)
        model = Model()
        state = {"request": request, "intent": "paragraph_review", "citations": []}
        output = agent._draft_tutor(state, model)
        self.assertIn("不要代写全文", model.system)
        self.assertIn("不是官方答案", model.system)
        self.assertIn("不得自动填写", model.system)
        self.assertIn(METHOD_ID, model.system)
        self.assertEqual(output["reply"], "只修改当前句。")

    def test_no_key_sidecar_study_fallback_has_no_fake_analysis(self):
        request = agent.validate_tutor_request(study_request(mode="hint"))
        with patch.object(agent, "urlopen", side_effect=AssertionError("no network")):
            output = agent._draft_tutor({"request": request, "intent": "learning_hint"}, agent.DeepSeekClient(env={}))
        self.assertFalse(output["generation"]["attempted"])
        self.assertIn("没有可用", output["reply"])
        self.assertNotIn("The passage supports C", output["reply"])


if __name__ == "__main__":
    unittest.main()
