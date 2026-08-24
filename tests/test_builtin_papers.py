from __future__ import annotations

import io
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock
from urllib.parse import urlparse

import server.platform as platform_module

from server.platform import PlatformAPI, PlatformService, _atomic_json, _review_document_digest


PAPER_ID = "2021-06-01"
PAPER_SHA256 = "688e243765c218d42d2a5fc5b54adb34247e6b3549da0a86ad2a39623d03a670"
RUNTIME_EXAM_ID = "exam-20260824-abcdef123456"


class DisabledAgentClient:
    configured = False


class ContractHandler:
    def __init__(
        self,
        body: bytes = b"",
        *,
        same_origin: bool = True,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.headers = {
            "Host": "127.0.0.1:4173",
            "Origin": "http://127.0.0.1:4173",
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
            **(headers or {}),
        }
        self.rfile = io.BytesIO(body)
        self.wfile = io.BytesIO()
        self.responses: list[tuple[object, object, dict[str, str]]] = []
        self.file_status = None
        self.file_headers: dict[str, str] = {}
        self.same_origin = same_origin

    def _request_is_same_origin(self) -> bool:
        return self.same_origin

    def _json_response(self, status, document, include_body=True, extra_headers=None) -> None:
        self.responses.append((status, document, extra_headers or {}))

    def _json_error(self, status, message) -> None:
        self.responses.append((status, {"error": message}, {}))

    def send_response(self, status) -> None:
        self.file_status = status

    def send_header(self, name: str, value: str) -> None:
        self.file_headers[name] = value

    def end_headers(self) -> None:
        pass


class BuiltinPaperApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.exams = Path(self.temporary.name) / "exams"
        self.exams_patch = mock.patch.object(platform_module, "EXAMS_DIR", self.exams)
        self.exams_patch.start()
        self.service = PlatformService()
        self.api = object.__new__(PlatformAPI)
        self.api.service = self.service

    def tearDown(self) -> None:
        self.service._executor.shutdown(wait=True)
        self.exams_patch.stop()
        self.temporary.cleanup()

    @staticmethod
    def assistant_payload(revision: int = 0) -> bytes:
        return json.dumps(
            {
                "questionId": "q2",
                "message": "正确答案是什么？",
                "history": [],
                "reviewRevision": revision,
            }
        ).encode("utf-8")

    def create_runtime_bundle(self, *, revision: int = 3) -> Path:
        directory = self.exams / RUNTIME_EXAM_ID
        (directory / "input").mkdir(parents=True)
        questions = {
            "examId": RUNTIME_EXAM_ID,
            "questions": [
                {
                    "questionId": "q2",
                    "number": 2,
                    "type": "single_choice",
                    "page": 1,
                    "bbox": {"x": 10, "y": 20, "width": 200, "height": 60},
                    "stem": "Runtime question?",
                    "options": [
                        {"label": "A", "text": "Runtime A"},
                        {"label": "B", "text": "Runtime B"},
                    ],
                    "confidence": 0.99,
                },
                {
                    "questionId": "writing-1",
                    "number": "写作",
                    "type": "writing",
                    "page": 1,
                    "bbox": {"x": 10, "y": 100, "width": 400, "height": 100},
                    "stem": "Write an essay.",
                    "options": [],
                    "confidence": 0.99,
                },
            ],
            "structure": [],
            "unresolved": [],
            "reviewSummary": {"total": 2},
            "parser": {"engine": "test"},
        }
        answers = {
            "examId": RUNTIME_EXAM_ID,
            "answers": [
                {
                    "questionId": "q2",
                    "answer": "B",
                    "explanation": "Runtime explanation.",
                    "source": "answer_pdf",
                    "confidence": 0.99,
                }
            ],
            "conflicts": [],
            "reviewSummary": {"total": 1},
            "officialSource": True,
            "policy": "test",
        }
        metadata = {
            "examId": RUNTIME_EXAM_ID,
            "title": "A misleading title is not used for resolution",
            "paper": {"sha256": PAPER_SHA256.upper()},
            "answer": {"sha256": "a" * 64},
            "audio": {
                "storedName": "listening.mp3",
                "originalName": "listening.mp3",
                "contentType": "audio/mpeg",
            },
        }
        status = {
            "examId": RUNTIME_EXAM_ID,
            "status": "ready",
            "stage": "complete",
            "progress": 100,
            "updatedAt": "2026-08-24T12:00:00Z",
        }
        _atomic_json(directory / "metadata.json", metadata)
        _atomic_json(directory / "status.json", status)
        _atomic_json(
            directory / "manifest.json",
            {
                "id": RUNTIME_EXAM_ID,
                "title": "Runtime paper",
                "pageCount": 1,
                "source": f"/api/exams/{RUNTIME_EXAM_ID}/source",
                "audioUrl": "/stale-manifest-value-must-not-be-trusted",
                "pages": [{"number": 1, "width": 600, "height": 840, "words": []}],
            },
        )
        _atomic_json(directory / "questions.json", questions)
        _atomic_json(directory / "answers.json", answers)
        (directory / "input/listening.mp3").write_bytes(b"ID3test-audio")

        if revision:
            snapshot = directory / "review/revisions" / f"{revision:06d}"
            snapshot.mkdir(parents=True)
            _atomic_json(snapshot / "questions.json", questions)
            _atomic_json(snapshot / "answers.json", answers)
            _atomic_json(
                directory / "review/current.json",
                {
                    "schemaVersion": "cet-review-pointer/1",
                    "revision": revision,
                    "directory": f"{revision:06d}",
                    "questionsSha256": _review_document_digest(questions),
                    "answersSha256": _review_document_digest(answers),
                },
            )
        return directory

    def test_static_documents_have_stable_identity_revision_and_read_only_assistant(self) -> None:
        questions, question_revision = self.service.builtin_document_with_revision(PAPER_ID, "questions")
        answers, answer_revision = self.service.builtin_document_with_revision(PAPER_ID, "answers")

        self.assertEqual(questions["examId"], PAPER_ID)
        self.assertEqual(answers["examId"], PAPER_ID)
        self.assertGreater(len(questions["questions"]), 0)
        self.assertGreater(len(answers["answers"]), 0)
        self.assertEqual((question_revision, answer_revision), (0, 0))

        handler = ContractHandler()
        self.assertTrue(self.api.handle_get(handler, urlparse(f"/api/papers/{PAPER_ID}/questions")))
        self.assertEqual(handler.responses[0][0], platform_module.HTTPStatus.OK)
        self.assertEqual(handler.responses[0][2]["ETag"], '"review-r0"')

        with mock.patch("server.platform.AgentClient.from_environment", return_value=DisabledAgentClient()), \
             mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "", "CET_AGENT_URL": ""}), \
             mock.patch("server.platform._atomic_json") as atomic_json:
            response = self.service.builtin_assistant(
                PAPER_ID,
                json.loads(self.assistant_payload().decode("utf-8")),
            )
        atomic_json.assert_not_called()
        self.assertEqual(response["examId"], PAPER_ID)
        self.assertEqual(response["questionId"], "q2")
        self.assertEqual(response["revision"], 0)
        self.assertEqual(response["grounding"]["exactMatches"], 1)
        self.assertIn("本地答案资料", response["reply"])
        self.assertNotIn("你上传的答案资料", response["reply"])

    def test_static_manifest_explicitly_reports_no_audio_without_runtime_match(self) -> None:
        manifest = self.service.builtin_manifest(PAPER_ID)
        self.assertEqual(manifest["id"], PAPER_ID)
        self.assertIsNone(manifest["audioUrl"])

        handler = ContractHandler()
        self.assertTrue(self.api.handle_get(handler, urlparse(f"/api/papers/{PAPER_ID}/manifest")))
        self.assertEqual(handler.responses[0][0], platform_module.HTTPStatus.OK)
        self.assertEqual(handler.responses[0][1]["id"], PAPER_ID)
        self.assertIsNone(handler.responses[0][1]["audioUrl"])

    def test_ready_digest_match_delegates_documents_audio_assistant_and_list_capabilities(self) -> None:
        directory = self.create_runtime_bundle(revision=3)

        builtin_manifest = self.service.builtin_manifest(PAPER_ID)
        self.assertEqual(builtin_manifest["audioUrl"], f"/api/papers/{PAPER_ID}/audio")
        builtin_manifest_handler = ContractHandler()
        self.api.handle_get(
            builtin_manifest_handler,
            urlparse(f"/api/papers/{PAPER_ID}/manifest"),
        )
        self.assertEqual(builtin_manifest_handler.responses[0][0], platform_module.HTTPStatus.OK)
        self.assertEqual(
            builtin_manifest_handler.responses[0][1]["audioUrl"],
            f"/api/papers/{PAPER_ID}/audio",
        )

        uploaded_manifest, uploaded_revision = self.service.document_with_revision(
            RUNTIME_EXAM_ID,
            "manifest",
        )
        self.assertEqual(uploaded_revision, 0)
        self.assertEqual(uploaded_manifest["audioUrl"], f"/api/exams/{RUNTIME_EXAM_ID}/audio")

        questions, revision = self.service.builtin_document_with_revision(PAPER_ID, "questions")
        self.assertEqual(revision, 3)
        self.assertEqual(questions["examId"], PAPER_ID)
        self.assertEqual(questions["questions"][0]["stem"], "Runtime question?")

        versioned = ContractHandler(headers={"If-Match": '"review-r3"'})
        self.api.handle_get(versioned, urlparse(f"/api/papers/{PAPER_ID}/answers"))
        self.assertEqual(versioned.responses[0][0], platform_module.HTTPStatus.OK)
        self.assertEqual(versioned.responses[0][2]["ETag"], '"review-r3"')

        audio = ContractHandler()
        self.api.handle_get(audio, urlparse(f"/api/papers/{PAPER_ID}/audio"))
        self.assertEqual(audio.file_status, platform_module.HTTPStatus.OK)
        self.assertEqual(audio.file_headers["Content-Type"], "audio/mpeg")
        self.assertEqual(audio.wfile.getvalue(), b"ID3test-audio")

        with mock.patch("server.platform.AgentClient.from_environment", return_value=DisabledAgentClient()), \
             mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "", "CET_AGENT_URL": ""}):
            response = self.service.builtin_assistant(
                PAPER_ID,
                json.loads(self.assistant_payload(3).decode("utf-8")),
            )
        self.assertEqual(response["examId"], PAPER_ID)
        self.assertEqual(response["revision"], 3)
        self.assertIn("Runtime explanation", response["reply"])

        listed = self.service.list_exams()["exams"]
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["paperSha256"], PAPER_SHA256)
        self.assertEqual(listed[0]["questionCount"], 2)
        self.assertEqual(listed[0]["answerCount"], 1)
        self.assertTrue(listed[0]["hasAnswer"])
        self.assertTrue(listed[0]["hasAudio"])

        (directory / "input/listening.mp3").unlink()
        self.assertFalse(self.service.list_exams()["exams"][0]["hasAudio"])
        self.assertIsNone(self.service.builtin_manifest(PAPER_ID)["audioUrl"])
        uploaded_without_audio, uploaded_revision = self.service.document_with_revision(
            RUNTIME_EXAM_ID,
            "manifest",
        )
        self.assertEqual(uploaded_revision, 0)
        self.assertIsNone(uploaded_without_audio["audioUrl"])

    def test_list_capabilities_do_not_trust_uploaded_answer_flag_or_invalid_digest(self) -> None:
        directory = self.exams / "exam-20260824-111111111111"
        directory.mkdir(parents=True)
        _atomic_json(directory / "status.json", {"status": "ready"})
        _atomic_json(
            directory / "metadata.json",
            {"paper": {"sha256": "not-a-digest"}, "answer": {"sha256": "a" * 64}, "audio": {}},
        )
        _atomic_json(directory / "questions.json", {"questions": [{"questionId": "q1"}]})
        _atomic_json(directory / "answers.json", {"answers": []})

        listed = self.service.list_exams()["exams"][0]
        self.assertIsNone(listed["paperSha256"])
        self.assertEqual(listed["questionCount"], 1)
        self.assertEqual(listed["answerCount"], 0)
        self.assertFalse(listed["hasAnswer"])
        self.assertFalse(listed["hasAudio"])

    def test_static_audio_is_404_and_stale_static_etag_is_412(self) -> None:
        audio = ContractHandler()
        self.api.handle_get(audio, urlparse(f"/api/papers/{PAPER_ID}/audio"))
        self.assertEqual(audio.responses[0][0], platform_module.HTTPStatus.NOT_FOUND)

        stale = ContractHandler(headers={"If-Match": '"review-r1"'})
        self.api.handle_get(stale, urlparse(f"/api/papers/{PAPER_ID}/answers"))
        self.assertEqual(stale.responses[0][0], platform_module.HTTPStatus.PRECONDITION_FAILED)

    def test_post_requires_same_origin_and_route_surface_is_allowlisted(self) -> None:
        body = self.assistant_payload()
        cross_origin = ContractHandler(body, same_origin=False)
        handled = self.api.handle_post(cross_origin, urlparse(f"/api/papers/{PAPER_ID}/assistant"))
        self.assertTrue(handled)
        self.assertEqual(cross_origin.responses[0][0], platform_module.HTTPStatus.FORBIDDEN)

        cases = [
            (f"/api/papers/{PAPER_ID}/questions?revision=0", platform_module.HTTPStatus.BAD_REQUEST),
            ("/api/papers/2021-12-01/questions", platform_module.HTTPStatus.NOT_FOUND),
            ("/api/papers/2021-12-01/manifest", platform_module.HTTPStatus.NOT_FOUND),
            (f"/api/papers/{PAPER_ID}/source", platform_module.HTTPStatus.NOT_FOUND),
            ("/api/papers/../questions", platform_module.HTTPStatus.NOT_FOUND),
            ("/api/papers/%2e%2e/questions", platform_module.HTTPStatus.NOT_FOUND),
        ]
        for url, expected in cases:
            with self.subTest(url=url):
                handler = ContractHandler()
                self.assertTrue(self.api.handle_get(handler, urlparse(url)))
                self.assertEqual(handler.responses[0][0], expected)

    def test_same_origin_assistant_route_uses_static_contract(self) -> None:
        body = self.assistant_payload()
        handler = ContractHandler(body)
        with mock.patch("server.platform.AgentClient.from_environment", return_value=DisabledAgentClient()), \
             mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "", "CET_AGENT_URL": ""}):
            handled = self.api.handle_post(handler, urlparse(f"/api/papers/{PAPER_ID}/assistant"))
        self.assertTrue(handled)
        self.assertEqual(handler.responses[0][0], platform_module.HTTPStatus.OK)
        self.assertEqual(handler.responses[0][1]["examId"], PAPER_ID)
        self.assertEqual(handler.responses[0][1]["questionId"], "q2")


if __name__ == "__main__":
    unittest.main()
