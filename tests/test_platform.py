from __future__ import annotations

import io
import json
import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import mock
from urllib.parse import urlparse

import server.platform as platform_module

from server.platform import (
    PlatformService,
    PlatformAPI,
    PlatformError,
    _atomic_json,
    _build_index,
    _extract_answers,
    _extract_document,
    _extract_questions,
    _merge_detached_question_stems,
    _parse_review_etag,
    _render_page_images,
    _review_status,
    _unresolved_question_gaps,
    _validate_audio_field,
    _validate_pdf_field,
)


PROJECT_ROOT = Path(__file__).resolve().parent.parent
REFERENCE_PAPER = PROJECT_ROOT / "data/reference/2021-06/papers/2021.06四级真题第1套.pdf"
REFERENCE_ANSWERS = PROJECT_ROOT / "data/reference/2021-06/answers/2021.06英语四级答案解析第1套.pdf"


def line(page: int, number: int, text: str, x: float, y: float, width: float = 160) -> dict[str, object]:
    return {
        "page": page,
        "line": number,
        "text": text,
        "bbox": {"x": x, "y": y, "width": width, "height": 12},
        "words": [],
    }


def page_from_lines(items: list[dict[str, object]], width: float = 600, height: float = 840) -> dict[str, object]:
    words: list[dict[str, object]] = []
    for item in items:
        box = item["bbox"]
        words.append(
            {
                "id": len(words),
                "line": item["line"],
                "text": item["text"],
                "x": box["x"],
                "y": box["y"],
                "width": box["width"],
                "height": box["height"],
            }
        )
    return {"number": 1, "width": width, "height": height, "words": words}


class PlatformUnitTests(unittest.TestCase):
    def test_confidence_thresholds_match_product_contract(self) -> None:
        self.assertEqual(_review_status(0.95), "reliable")
        self.assertEqual(_review_status(0.80), "suggestedReview")
        self.assertEqual(_review_status(0.79), "manualReview")

    def test_number_only_question_is_merged_with_same_row_stem(self) -> None:
        source = [
            line(6, 0, "40.", 40, 50, 15),
            line(6, 1, "The statement printed beside the number.", 64, 50, 280),
            line(6, 2, "41. A different question.", 40, 72, 300),
        ]
        merged = _merge_detached_question_stems(source)
        self.assertEqual([item["text"] for item in merged], [
            "40. The statement printed beside the number.",
            "41. A different question.",
        ])

    def test_two_column_answer_order_does_not_shift_labels(self) -> None:
        # The second answer is above q4 in geometric y because the booklet
        # continues from the bottom of the left column to the right column.
        answer_page = page_from_lines(
            [
                line(1, 0, "3. First question?", 30, 40, 180),
                line(1, 1, "A) official explanation", 30, 60, 190),
                line(1, 2, "4. Second question?", 30, 100, 180),
                line(1, 3, "D) official explanation", 320, 60, 190),
            ]
        )
        questions = [
            {"questionId": "q3", "number": 3, "options": [{"label": value} for value in "ABCD"]},
            {"questionId": "q4", "number": 4, "options": [{"label": value} for value in "ABCD"]},
        ]
        answers, issues = _extract_answers([answer_page], "pdf_text", questions)
        mapping = {item["questionId"]: item["answer"] for item in answers}
        self.assertEqual(mapping, {"q3": "A", "q4": "D"})
        self.assertEqual(issues, [])

    def test_answer_outside_parsed_options_is_never_graded(self) -> None:
        answer_page = page_from_lines(
            [line(1, 0, "48. Question?", 30, 40, 180), line(1, 1, "M) unrelated marker", 30, 60, 180)]
        )
        questions = [
            {"questionId": "q48", "number": 48, "options": [{"label": value} for value in "ABCD"]}
        ]
        answers, issues = _extract_answers([answer_page], "pdf_text", questions)
        self.assertEqual(answers, [])
        self.assertEqual(issues[0]["questionId"], "q48")

    def test_internal_number_gaps_are_reported_without_fake_questions(self) -> None:
        gaps = _unresolved_question_gaps([{"number": 25}, {"number": 28}])
        self.assertEqual([item["number"] for item in gaps], [26, 27])
        self.assertTrue(all(item["reviewStatus"] == "manualReview" for item in gaps))

    def test_upload_signatures_are_checked(self) -> None:
        valid_pdf = SimpleNamespace(filename="paper.pdf", file=io.BytesIO(b"%PDF-1.6\n" + b"x" * 64))
        self.assertGreater(_validate_pdf_field(valid_pdf, "试卷 PDF")[0], 32)
        invalid_pdf = SimpleNamespace(filename="paper.pdf", file=io.BytesIO(b"not a pdf" * 8))
        with self.assertRaises(PlatformError):
            _validate_pdf_field(invalid_pdf, "试卷 PDF")
        wav = SimpleNamespace(filename="audio.wav", file=io.BytesIO(b"RIFF" + b"\0" * 4 + b"WAVE" + b"\0" * 32))
        self.assertEqual(_validate_audio_field(wav)[2], "audio/wav")

    def test_capabilities_requires_a_ready_ocr_pipeline(self) -> None:
        class FakeClient:
            configured = True

            def __init__(self, ready: bool) -> None:
                self.ready = ready

            def health(self, timeout_seconds=1.5):
                return {
                    "ready": self.ready,
                    "requestedLanguage": "en",
                    "languageReady": self.ready,
                    "allowedRootReady": self.ready,
                    "runtimeImportReady": self.ready,
                    "modelLoaded": False,
                }

        installed = lambda command: f"/usr/bin/{command}" if command in {"pdftotext", "pdftoppm"} else None
        service = object.__new__(PlatformService)
        with mock.patch("server.platform.shutil.which", side_effect=installed), \
             mock.patch("server.platform.PaddleOCRClient.from_environment", return_value=FakeClient(False)):
            unavailable = service.capabilities()
        with mock.patch("server.platform.shutil.which", side_effect=installed), \
             mock.patch("server.platform.PaddleOCRClient.from_environment", return_value=FakeClient(True)):
            available = service.capabilities()

        self.assertFalse(unavailable["pdf"]["scanned"])
        self.assertFalse(unavailable["ocr"]["paddleocr"]["ready"])
        self.assertTrue(available["pdf"]["scanned"])
        self.assertEqual(available["ocr"]["preferred"], "paddleocr")

    def test_page_images_are_rendered_in_one_poppler_process(self) -> None:
        pages = [
            {"number": number, "width": 600, "height": 840, "words": []}
            for number in range(1, 4)
        ]

        def fake_run(command, timeout, message):
            prefix = Path(command[-1])
            for number in range(1, 4):
                (prefix.parent / f"{prefix.name}-{number}.jpg").write_bytes(b"x" * 300)

        with TemporaryDirectory() as temporary, \
             mock.patch("server.platform.shutil.which", return_value="/usr/bin/pdftoppm"), \
             mock.patch("server.platform._run", side_effect=fake_run) as run:
            destination = Path(temporary) / "pages"
            _render_page_images(Path(temporary) / "paper.pdf", pages, destination)
            rendered = sorted(path.name for path in destination.iterdir())

        self.assertEqual(run.call_count, 1)
        self.assertEqual(rendered, [
            "page-1.jpg", "page-2.jpg", "page-3.jpg",
        ])


class ReviewApiUnitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.exams = Path(self.temporary.name) / "exams"
        self.exams_patch = mock.patch.object(platform_module, "EXAMS_DIR", self.exams)
        self.exams_patch.start()
        self.service = PlatformService()
        self.exam_id = "exam-20260821-abcdef123456"
        self.directory = self.exams / self.exam_id
        self.directory.mkdir(parents=True)
        _atomic_json(
            self.directory / "status.json",
            {
                "examId": self.exam_id,
                "status": "ready",
                "stage": "complete",
                "progress": 100,
                "message": "ready",
                "createdAt": "2026-08-21T00:00:00Z",
                "updatedAt": "2026-08-21T00:00:00Z",
            },
        )
        _atomic_json(
            self.directory / "manifest.json",
            {
                "id": self.exam_id,
                "pageCount": 1,
                "pages": [{"number": 1, "width": 600, "height": 840, "words": []}],
            },
        )
        self.question_one = {
            "questionId": "q1",
            "number": 1,
            "type": "single_choice",
            "page": 1,
            "bbox": {"x": 40, "y": 100, "width": 500, "height": 100},
            "stem": "Original question one?",
            "options": [{"label": label, "text": f"Option {label}"} for label in "ABCD"],
            "confidence": 0.76,
            "reviewStatus": "manualReview",
            "reviewRequired": True,
            "source": "paper_pdf",
        }
        self.question_three = {
            **self.question_one,
            "questionId": "q3",
            "number": 3,
            "stem": "Original question three?",
            "bbox": {"x": 40, "y": 300, "width": 500, "height": 100},
            "confidence": 0.97,
            "reviewStatus": "reliable",
            "reviewRequired": False,
        }
        _atomic_json(
            self.directory / "questions.json",
            {
                "examId": self.exam_id,
                "questions": [self.question_one, self.question_three],
                "structure": [],
                "unresolved": platform_module._unresolved_question_gaps([self.question_one, self.question_three]),
                "reviewSummary": platform_module._review_summary([self.question_one, self.question_three]),
                "parser": {"engine": "coordinate_heuristics_v1"},
            },
        )
        answer = {
            "questionId": "q1",
            "answer": "A",
            "explanation": "Original answer.",
            "confidence": 0.98,
            "source": "answer_pdf",
            "reviewStatus": "reliable",
            "reviewRequired": False,
        }
        _atomic_json(
            self.directory / "answers.json",
            {
                "examId": self.exam_id,
                "answers": [answer],
                "conflicts": [],
                "reviewSummary": platform_module._review_summary([answer]),
                "officialSource": True,
            },
        )
        _build_index(self.directory / "rag.sqlite3", [answer], [])

    def tearDown(self) -> None:
        self.service._executor.shutdown(wait=True)
        self.exams_patch.stop()
        self.temporary.cleanup()

    @staticmethod
    def question_two() -> dict[str, object]:
        return {
            "questionId": "q2",
            "number": 2,
            "type": "single_choice",
            "page": 1,
            "bbox": {"x": 40, "y": 205, "width": 500, "height": 90},
            "stem": "Human reviewed question two?",
            "options": [{"label": label, "text": f"Reviewed option {label}"} for label in "ABCD"],
        }

    def review_patch(self, operations: list[dict[str, object]], revision: int = 0) -> dict[str, object]:
        return self.service.apply_review_patch(
            self.exam_id,
            {
                "schemaVersion": "cet-review/1",
                "baseRevision": revision,
                "reason": "Compared the paper and answer PDF",
                "operations": operations,
            },
            revision,
        )

    def test_review_get_reports_legacy_revision_and_derived_issues(self) -> None:
        review = self.service.review(self.exam_id)
        self.assertEqual(review["revision"], 0)
        self.assertEqual(review["etag"], '"review-r0"')
        self.assertEqual(review["state"], "needs_review")
        issue_ids = {item["issueId"] for item in review["issues"]}
        self.assertIn("missing-question:q2", issue_ids)
        self.assertIn("question-review:q1", issue_ids)

    def test_patch_publishes_coherent_snapshot_audit_and_rag(self) -> None:
        response = self.review_patch(
            [
                {"op": "upsertQuestion", "question": self.question_two()},
                {
                    "op": "upsertAnswer",
                    "answer": {"questionId": "q2", "answer": "C", "explanation": "Checked on answer page 3."},
                },
            ]
        )
        self.assertEqual(response["revision"], 1)
        self.assertEqual(response["etag"], '"review-r1"')
        current = json.loads((self.directory / "review/current.json").read_text(encoding="utf-8"))
        self.assertEqual(current["directory"], "000001")
        snapshot = self.directory / "review/revisions/000001"
        self.assertTrue((snapshot / "audit.json").is_file())
        self.assertTrue((snapshot / "rag.sqlite3").is_file())

        # Existing reader URLs resolve through the published snapshot, while
        # the legacy root documents remain an immutable revision-zero fallback.
        published_questions = self.service.document(self.exam_id, "questions")
        self.assertIn("q2", {item["questionId"] for item in published_questions["questions"]})
        root_questions = json.loads((self.directory / "questions.json").read_text(encoding="utf-8"))
        self.assertNotIn("q2", {item["questionId"] for item in root_questions["questions"]})
        published_answers = self.service.document(self.exam_id, "answers")
        answer_two = next(item for item in published_answers["answers"] if item["questionId"] == "q2")
        self.assertEqual(answer_two["answer"], "C")
        self.assertEqual(answer_two["source"], "human_review")
        self.assertEqual(answer_two["verification"]["revision"], 1)
        exact, _ = self.service._retrieve(self.exam_id, "q2", "q2 answer", snapshot=snapshot)
        self.assertTrue(any("正确答案：C" in item["content"] for item in exact))
        audit = json.loads((snapshot / "audit.json").read_text(encoding="utf-8"))
        self.assertEqual(audit["baseRevision"], 0)
        self.assertEqual([item["op"] for item in audit["operations"]], ["upsertQuestion", "upsertAnswer"])
        status = json.loads((self.directory / "status.json").read_text(encoding="utf-8"))
        self.assertEqual(status["result"]["reviewRevision"], 1)
        self.assertEqual(status["result"]["reviewCounts"]["answerConflicts"], 0)

    def test_non_objective_question_cannot_keep_an_answer_key(self) -> None:
        unresolved = {
            "questionId": "q1",
            "number": 1,
            "type": "unknown",
            "page": 1,
            "bbox": self.question_one["bbox"],
            "stem": self.question_one["stem"],
            "options": self.question_one["options"],
        }
        with self.assertRaisesRegex(PlatformError, "non-objective"):
            self.review_patch([{"op": "upsertQuestion", "question": unresolved}])
        self.assertEqual(self.service.review(self.exam_id)["revision"], 0)

        response = self.review_patch([
            {"op": "upsertQuestion", "question": unresolved},
            {"op": "removeAnswer", "questionId": "q1"},
        ])
        question = next(item for item in response["questions"] if item["questionId"] == "q1")
        self.assertTrue(question["reviewRequired"])
        self.assertEqual(response["answers"], [])

    def test_objective_listening_question_may_have_no_printed_stem(self) -> None:
        listening_question = self.question_two()
        listening_question["stem"] = ""
        response = self.review_patch([
            {"op": "upsertQuestion", "question": listening_question},
            {
                "op": "upsertAnswer",
                "answer": {"questionId": "q2", "answer": "B", "explanation": "Checked against the key."},
            },
        ])
        published = next(item for item in response["questions"] if item["questionId"] == "q2")
        self.assertEqual(published["stem"], "")
        self.assertFalse(published["reviewRequired"])

    def test_removing_conflict_only_question_clears_its_orphan_issue(self) -> None:
        answers = json.loads((self.directory / "answers.json").read_text(encoding="utf-8"))
        answers["conflicts"] = [{
            "questionId": "q3",
            "reason": "答案资料同时出现 A 和 B",
            "values": ["A", "B"],
        }]
        _atomic_json(self.directory / "answers.json", answers)

        response = self.review_patch([
            {"op": "removeQuestion", "questionId": "q3", "cascadeAnswer": False},
        ])
        self.assertNotIn("q3", {item["questionId"] for item in response["questions"]})
        self.assertFalse(any(item["targetId"] == "q3" for item in response["issues"]))
        published = self.service.document(self.exam_id, "answers")
        self.assertFalse(any(item.get("questionId") == "q3" for item in published["conflicts"]))

    def test_human_answer_supersedes_conflicting_raw_rag_evidence(self) -> None:
        connection = sqlite3.connect(str(self.directory / "rag.sqlite3"))
        try:
            raw = "q1 答案资料第1页：1. A original parsed evidence"
            connection.execute(
                "INSERT INTO chunks(question_id, kind, content, embedding) VALUES (?, ?, ?, ?)",
                ("q1", "answer_text", raw, json.dumps(platform_module._embedding(raw))),
            )
            connection.commit()
        finally:
            connection.close()

        response = self.review_patch([{
            "op": "upsertAnswer",
            "answer": {"questionId": "q1", "answer": "B", "explanation": "Confirmed against page 3."},
        }])
        snapshot, _, _ = self.service._current_review_snapshot(self.exam_id)
        exact, _ = self.service._retrieve(self.exam_id, "q1", "q1 answer", snapshot=snapshot)
        evidence = "\n".join(str(item["content"]) for item in exact)
        self.assertIn("人工复核给出的正确答案：B", evidence)
        self.assertNotIn("original parsed evidence", evidence)
        answer = next(item for item in response["answers"] if item["questionId"] == "q1")
        self.assertEqual(answer["source"], "human_review")

    def test_snapshot_hashes_are_verified_and_orphan_revision_is_skipped(self) -> None:
        orphan = self.directory / "review/revisions/000001"
        orphan.mkdir(parents=True)
        (orphan / "forensic.txt").write_text("unpublished", encoding="utf-8")
        response = self.review_patch([{"op": "upsertQuestion", "question": self.question_two()}])
        self.assertEqual(response["revision"], 2)
        self.assertTrue((orphan / "forensic.txt").is_file())

        snapshot = self.directory / "review/revisions/000002/questions.json"
        document = json.loads(snapshot.read_text(encoding="utf-8"))
        document["questions"][0]["stem"] = "tampered"
        snapshot.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(PlatformError, "integrity"):
            self.service.review(self.exam_id)

    def test_stale_document_and_assistant_revision_are_rejected(self) -> None:
        class Handler:
            def __init__(self, etag: str = "") -> None:
                self.headers = {"If-Match": etag} if etag else {}
                self.responses = []

            def _json_response(self, status, document, include_body=True, extra_headers=None) -> None:
                self.responses.append((status, document, extra_headers or {}))

            def _json_error(self, status, message) -> None:
                self.responses.append((status, {"error": message}, {}))

        api = object.__new__(PlatformAPI)
        api.service = self.service
        questions_handler = Handler()
        api.handle_get(questions_handler, urlparse(f"/api/exams/{self.exam_id}/questions"))
        self.assertEqual(questions_handler.responses[0][2]["ETag"], '"review-r0"')

        self.review_patch([{"op": "upsertQuestion", "question": self.question_two()}])
        stale_answers = Handler('"review-r0"')
        api.handle_get(stale_answers, urlparse(f"/api/exams/{self.exam_id}/answers"))
        self.assertEqual(stale_answers.responses[0][0], platform_module.HTTPStatus.PRECONDITION_FAILED)
        with self.assertRaises(PlatformError) as caught:
            self.service.assistant(self.exam_id, {
                "questionId": "q1",
                "message": "Why?",
                "reviewRevision": 0,
            })
        self.assertEqual(caught.exception.status, platform_module.HTTPStatus.CONFLICT)

    def test_stale_revision_is_rejected_without_changing_current_snapshot(self) -> None:
        self.review_patch([{"op": "upsertQuestion", "question": self.question_two()}])
        with self.assertRaises(PlatformError) as caught:
            self.review_patch(
                [{"op": "upsertAnswer", "answer": {"questionId": "q1", "answer": "B", "explanation": ""}}],
                revision=0,
            )
        self.assertEqual(caught.exception.status, platform_module.HTTPStatus.CONFLICT)
        self.assertEqual(self.service.review(self.exam_id)["revision"], 1)

    def test_invalid_answer_and_client_computed_fields_are_rejected_atomically(self) -> None:
        invalid_question = {**self.question_two(), "confidence": 1.0}
        with self.assertRaises(PlatformError):
            self.review_patch([{"op": "upsertQuestion", "question": invalid_question}])
        with self.assertRaises(PlatformError):
            self.review_patch(
                [{"op": "upsertAnswer", "answer": {"questionId": "q1", "answer": "E", "explanation": ""}}]
            )
        self.assertEqual(self.service.review(self.exam_id)["revision"], 0)
        self.assertFalse((self.directory / "review/current.json").exists())

    def test_question_bbox_and_ready_state_are_enforced(self) -> None:
        outside = self.question_two()
        outside["bbox"] = {"x": 590, "y": 10, "width": 40, "height": 40}
        with self.assertRaises(PlatformError):
            self.review_patch([{"op": "upsertQuestion", "question": outside}])
        status = json.loads((self.directory / "status.json").read_text(encoding="utf-8"))
        status["status"] = "processing"
        _atomic_json(self.directory / "status.json", status)
        with self.assertRaises(PlatformError) as caught:
            self.review_patch([{"op": "upsertQuestion", "question": self.question_two()}])
        self.assertEqual(caught.exception.status, platform_module.HTTPStatus.CONFLICT)

    def test_review_etag_is_strict_and_requires_a_precondition(self) -> None:
        self.assertEqual(_parse_review_etag('"review-r12"'), 12)
        for value in ("", "review-r12", 'W/"review-r12"', '"review-r01"'):
            with self.subTest(value=value), self.assertRaises(PlatformError) as caught:
                _parse_review_etag(value)
            self.assertEqual(caught.exception.status, platform_module.HTTPStatus.PRECONDITION_REQUIRED)

    def test_corrupt_review_pointer_never_falls_back_to_revision_zero(self) -> None:
        pointer = self.directory / "review/current.json"
        pointer.parent.mkdir(parents=True)
        pointer.write_text("not json", encoding="utf-8")
        with self.assertRaises(PlatformError) as caught:
            self.service.review(self.exam_id)
        self.assertEqual(caught.exception.status, platform_module.HTTPStatus.INTERNAL_SERVER_ERROR)

    def test_http_review_contract_emits_etag_and_requires_local_if_match(self) -> None:
        class Handler:
            def __init__(self, body: bytes = b"", *, host: str = "127.0.0.1:4173") -> None:
                self.headers = {
                    "Host": host,
                    "Origin": "http://127.0.0.1:4173",
                    "Content-Type": "application/json",
                    "Content-Length": str(len(body)),
                }
                self.rfile = io.BytesIO(body)
                self.client_address = ("127.0.0.1", 12345)
                self.responses: list[tuple[object, object, object]] = []

            def _request_is_same_origin(self) -> bool:
                return True

            def _json_response(self, status, document, include_body=True, extra_headers=None) -> None:
                self.responses.append((status, document, extra_headers or {}))

            def _json_error(self, status, message) -> None:
                self.responses.append((status, {"error": message}, {}))

        api = object.__new__(PlatformAPI)
        api.service = self.service
        route = urlparse(f"/api/exams/{self.exam_id}/review")
        reader = Handler()
        self.assertTrue(api.handle_get(reader, route))
        self.assertEqual(reader.responses[0][0], platform_module.HTTPStatus.OK)
        self.assertEqual(reader.responses[0][2]["ETag"], '"review-r0"')

        missing_precondition = Handler(b"{}")
        self.assertTrue(api.handle_patch(missing_precondition, route))
        self.assertEqual(missing_precondition.responses[0][0], platform_module.HTTPStatus.PRECONDITION_REQUIRED)

        remote_host = Handler(b"{}", host="example.com")
        remote_host.headers["If-Match"] = '"review-r0"'
        self.assertTrue(api.handle_patch(remote_host, route))
        self.assertEqual(remote_host.responses[0][0], platform_module.HTTPStatus.FORBIDDEN)


class ReviewFrontendRegressionTests(unittest.TestCase):
    def test_listening_question_stem_is_optional_in_review_form(self) -> None:
        html = (PROJECT_ROOT / "public/review.html").read_text(encoding="utf-8")
        source = (PROJECT_ROOT / "public/js/review.js").read_text(encoding="utf-8")
        self.assertIn("题干（听力客观题可留空）", html)
        self.assertNotRegex(html, r'id="question-stem"[^>]*\brequired\b')
        self.assertIn("if (!stem && LONG_TYPES.has(type))", source)


class UploadFrontendRegressionTests(unittest.TestCase):
    def test_form_data_is_captured_before_inputs_are_disabled(self) -> None:
        source = (PROJECT_ROOT / "public/js/upload.js").read_text(encoding="utf-8")
        start = source.index("async function submitUpload(event)")
        end = source.index("$$('input[type=\"file\"]'", start)
        submit_handler = source[start:end]

        self.assertLess(
            submit_handler.index("const uploadBody = new FormData(form);"),
            submit_handler.index("setFormBusy(true);"),
        )
        self.assertIn("new XMLHttpRequest()", source)
        self.assertIn("request.upload.addEventListener('progress'", source)


class ReaderFrontendRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        public = PROJECT_ROOT / "public"
        cls.html = (public / "reader.html").read_text(encoding="utf-8")
        cls.javascript = (public / "js/reader.js").read_text(encoding="utf-8")
        cls.styles = (public / "css/reader.css").read_text(encoding="utf-8")

    @staticmethod
    def function_source(source: str, function_name: str) -> str:
        """Return one JavaScript function without depending on a JS parser."""

        marker = f"function {function_name}("
        start = source.index(marker)
        opening = source.index("{", start)
        depth = 0
        quote = ""
        escaped = False
        for index in range(opening, len(source)):
            character = source[index]
            if quote:
                if escaped:
                    escaped = False
                elif character == "\\":
                    escaped = True
                elif character == quote:
                    quote = ""
                continue
            if character in {"'", '"', "`"}:
                quote = character
            elif character == "{":
                depth += 1
            elif character == "}":
                depth -= 1
                if depth == 0:
                    return source[start:index + 1]
        raise AssertionError(f"unterminated JavaScript function: {function_name}")

    def test_copy_tool_has_panel_and_clipboard_fallback(self) -> None:
        self.assertIn('data-tool="copy"', self.html)
        self.assertIn('id="selection-copy-panel"', self.html)
        self.assertIn(".selection-copy-panel", self.styles)
        self.assertRegex(self.javascript, r"tools\s*=\s*new Set\([^\n]+['\"]copy['\"]")
        self.assertIn("navigator.clipboard", self.javascript)
        self.assertRegex(self.javascript, r"execCommand\(['\"]copy['\"]\)")
        self.assertIn("#selection-copy-panel", self.javascript)
        self.assertIn("selectionPointerActive", self.javascript)
        self.assertIn("(pointer: coarse)", self.javascript)

    def test_highlight_color_is_saved_on_each_annotation(self) -> None:
        self.assertIn('id="highlight-color"', self.html)
        self.assertIn("#highlight-color", self.javascript)
        self.assertRegex(self.javascript, r"highlightColor\s*:\s*[^,\n]+")
        self.assertRegex(self.javascript, r"highlightColor\s*:\s*state\.highlightColor")
        self.assertRegex(
            self.javascript,
            r"type:\s*['\"]highlight['\"][\s\S]{0,320}?color:\s*state\.highlightColor",
        )
        self.assertIn("annotation.color", self.javascript)
        self.assertRegex(self.styles, r"\.mark-highlight\s*\{[^}]*var\(--highlight-color")

    def test_question_rail_has_fixed_width_and_expand_toggle(self) -> None:
        self.assertRegex(self.javascript, r"const\s+QUESTION_RAIL_WIDTH\s*=\s*\d+")
        self.assertGreaterEqual(self.javascript.count("QUESTION_RAIL_WIDTH"), 2)
        self.assertIn("data-toggle-page-question", self.javascript)
        self.assertRegex(self.javascript, r"data-toggle-page-question[\s\S]{0,900}aria-expanded")
        self.assertIn("questionFocusRequest", self.javascript)
        self.assertIn(".page-question-card.is-expanded", self.styles)

    def test_floating_ai_launcher_keeps_explicit_question_context(self) -> None:
        self.assertIn('id="ai-floating-launcher"', self.html)
        self.assertIn('aria-controls="ai-question-panel"', self.html)
        self.assertIn('id="ai-question-context"', self.html)
        self.assertIn("#ai-floating-launcher", self.javascript)
        self.assertIn("#ai-question-context", self.javascript)
        self.assertIn("aiQuestionDrafts", self.javascript)
        self.assertIn("assistantPendingQuestions", self.javascript)
        self.assertIn(".ai-floating-launcher", self.styles)

    def test_reader_binds_questions_answers_and_ai_to_one_review_revision(self) -> None:
        self.assertIn("questionDataRevision", self.javascript)
        self.assertIn("questionDataEtag", self.javascript)
        self.assertIn("'If-Match': questionDataEtag", self.javascript)
        self.assertIn("body.reviewRevision = requestRevision", self.javascript)
        self.assertIn("response.status === 412", self.javascript)
        self.assertIn("response.status === 409", self.javascript)
        self.assertIn("aiHistoryRevision", self.javascript)
        self.assertIn("state.aiHistory = {}", self.javascript)
        self.assertIn("requestRevision !== questionDataRevision", self.javascript)

    def test_writing_templates_parse_placeholders_and_use_safe_dom_rendering(self) -> None:
        self.assertIn("writingTemplates", self.javascript)
        self.assertIn("function normalizeStoredWritingTemplates(", self.javascript)
        parse_source = self.function_source(self.javascript, "parseWritingTemplate")
        self.assertIn(".replace(", parse_source)
        self.assertIn(r"\{\{", parse_source)
        self.assertIn(r"\}\}", parse_source)

        render_source = self.function_source(self.javascript, "renderWritingTemplateBuilder")
        self.assertNotIn("innerHTML", render_source)
        self.assertRegex(render_source, r"(?:textContent|makeElement|createTextNode|\.append\()")
        apply_source = self.function_source(self.javascript, "applyWritingTemplate")
        self.assertNotIn("innerHTML", apply_source)
        self.assertRegex(apply_source, r"(?:\.value|textContent|createTextNode)")
        self.assertIn("completed.length > MAX_LONG_ANSWER_CHARS", apply_source)


@unittest.skipUnless(REFERENCE_PAPER.is_file() and REFERENCE_ANSWERS.is_file(), "local reference PDFs are absent")
class ReferencePipelineRegressionTests(unittest.TestCase):
    def test_reference_set_keeps_uncertain_items_out_of_the_key(self) -> None:
        with TemporaryDirectory() as temporary:
            work = Path(temporary)
            paper_pages, paper_source = _extract_document(REFERENCE_PAPER, work, "paper")
            questions, _ = _extract_questions(paper_pages, paper_source)
            answer_pages, answer_source = _extract_document(REFERENCE_ANSWERS, work, "answers")
            answers, issues = _extract_answers(answer_pages, answer_source, questions)

        self.assertEqual(len(questions), 47)
        self.assertEqual({item["questionId"] for item in questions if item["type"] in {"writing", "translation"}}, {
            "writing-1", "translation-1",
        })
        self.assertEqual([item["number"] for item in _unresolved_question_gaps(questions)], list(range(26, 36)))
        mapping = {item["questionId"]: item["answer"] for item in answers}
        self.assertEqual({key: mapping.get(key) for key in ("q4", "q5", "q6", "q7")}, {
            "q4": "D", "q5": "B", "q6": "C", "q7": "D",
        })
        self.assertNotIn("q48", mapping)
        self.assertTrue(any(item["questionId"] == "q48" for item in issues))


if __name__ == "__main__":
    unittest.main()
