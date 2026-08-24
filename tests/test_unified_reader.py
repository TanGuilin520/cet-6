"""Regression contracts for the unified full-paper reader entry.

These tests deliberately stay independent from ``test_platform.py`` so the
home/catalog integration and the checked-in built-in paper data cannot drift
back to the old, unrelated single-passage practice page.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from server.platform import PlatformService  # noqa: E402


PUBLIC = PROJECT_ROOT / "public"
BUILT_IN_ROOT = PUBLIC / "assets" / "papers" / "2021-06-set-01"
BUILT_IN_ID = "2021-06-01"
EXAM_ID = "exam-20260824-aaaaaaaaaaaa"
SOURCE_SHA256 = "688e243765c218d42d2a5fc5b54adb34247e6b3549da0a86ad2a39623d03a670"


def javascript_function(source: str, function_name: str) -> str:
    """Extract one ordinary JavaScript function without a JS dependency."""

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


class UnifiedHomeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = (PUBLIC / "js" / "home.js").read_text(encoding="utf-8")

    def test_full_papers_all_enter_the_shared_reader(self) -> None:
        start_paper = javascript_function(self.source, "startPaper")
        reader_url = javascript_function(self.source, "unifiedReaderUrl")
        self.assertIn("reader.html?paper=", reader_url)
        self.assertIn("&cachefix=2", reader_url)
        self.assertIn("unifiedReaderUrl(paper.runtimePaperId)", start_paper)
        self.assertIn("paper.runtimePaperId", start_paper)
        self.assertNotIn("practice.html", start_paper)

    def test_home_has_no_fictitious_simulation_catalog(self) -> None:
        self.assertIn("const papers = [builtInPaper]", self.source)
        for old_placeholder in ("2025-12-01", "2025-06-02", "2024-12-03", "2023-06-01"):
            self.assertNotIn(old_placeholder, self.source)

        render_card = javascript_function(self.source, "renderPaperCard")
        render_catalog = javascript_function(self.source, "renderPapers")
        self.assertIn("paper.isBuiltIn", render_card)
        self.assertIn("paper.isBuiltIn", render_catalog)
        self.assertNotIn("paper.isRealPaper", render_card)
        self.assertNotIn("paper.isRealPaper", render_catalog)
        self.assertIn("availableYears", render_catalog)
        self.assertNotIn("['2025', '2024', '2023']", render_catalog)

    def test_only_ready_server_exams_are_added_dynamically(self) -> None:
        normalize = javascript_function(self.source, "normalizeApiPaper")
        load = javascript_function(self.source, "loadReadyExams")
        self.assertIn("item.status !== 'ready'", normalize)
        self.assertIn("EXAM_ID_PATTERN.test(examId)", normalize)
        self.assertIn("fetch('/api/exams'", load)
        self.assertIn("papers.splice(", load)

    def test_imported_copy_of_builtin_is_deduplicated_by_source_sha(self) -> None:
        source_pdf = BUILT_IN_ROOT / "source.pdf"
        self.assertEqual(hashlib.sha256(source_pdf.read_bytes()).hexdigest(), SOURCE_SHA256)
        self.assertIn(f"const BUILT_IN_SOURCE_SHA256 = '{SOURCE_SHA256}'", self.source)
        load = javascript_function(self.source, "loadReadyExams")
        self.assertIn("paper.paperSha256 === BUILT_IN_SOURCE_SHA256", load)
        self.assertIn("paper.paperSha256 !== BUILT_IN_SOURCE_SHA256", load)
        self.assertNotIn("builtInPaper.runtimePaperId = builtInRuntime.runtimePaperId", load)
        self.assertIn("runtimePaperId: '2021-06-01'", self.source)
        self.assertRegex(load, r"builtInPaper\.(?:hasAudio|hasAnswer|hasQuestions)")


class UnifiedCatalogBackendTests(unittest.TestCase):
    def test_exam_catalog_exposes_paper_sha_for_frontend_deduplication(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            exam = root / EXAM_ID
            exam.mkdir()
            (exam / "metadata.json").write_text(json.dumps({
                "title": "可用上传卷",
                "paper": {"sha256": SOURCE_SHA256},
                "answer": None,
                "audio": None,
            }), encoding="utf-8")
            (exam / "status.json").write_text(json.dumps({
                "status": "ready",
                "stage": "complete",
                "progress": 100,
                "createdAt": "2026-08-24T00:00:00Z",
                "result": {"reviewCounts": {"questions": {"total": 1}}},
            }), encoding="utf-8")

            service = object.__new__(PlatformService)
            with mock.patch("server.platform.EXAMS_DIR", root):
                payload = service.list_exams()

        self.assertEqual(len(payload["exams"]), 1)
        self.assertEqual(payload["exams"][0]["examId"], EXAM_ID)
        self.assertEqual(payload["exams"][0]["paperSha256"], SOURCE_SHA256)

    def test_builtin_documents_have_a_revision_zero_static_fallback(self) -> None:
        with TemporaryDirectory() as temporary, mock.patch("server.platform.EXAMS_DIR", Path(temporary)):
            service = PlatformService()
            try:
                manifest = service.builtin_manifest(BUILT_IN_ID)
                questions, question_revision = service.builtin_document_with_revision(BUILT_IN_ID, "questions")
                answers, answer_revision = service.builtin_document_with_revision(BUILT_IN_ID, "answers")
            finally:
                service._executor.shutdown(wait=True)

        self.assertEqual(manifest["id"], BUILT_IN_ID)
        self.assertIsNone(manifest["audioUrl"])
        self.assertEqual(question_revision, 0)
        self.assertEqual(answer_revision, 0)
        self.assertEqual(questions["examId"], BUILT_IN_ID)
        self.assertEqual(answers["examId"], BUILT_IN_ID)
        self.assertGreater(len(questions["questions"]), 0)
        self.assertGreater(len(answers["answers"]), 0)


class BuiltInReaderContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.html = (PUBLIC / "reader.html").read_text(encoding="utf-8")
        cls.javascript = (PUBLIC / "js" / "reader.js").read_text(encoding="utf-8")
        cls.manifest = json.loads((BUILT_IN_ROOT / "manifest.json").read_text(encoding="utf-8"))
        cls.question_document = json.loads((BUILT_IN_ROOT / "questions.json").read_text(encoding="utf-8"))
        cls.answer_document = json.loads((BUILT_IN_ROOT / "answers.json").read_text(encoding="utf-8"))

    def test_builtin_uses_manifest_driven_audio_and_shared_question_ai_urls(self) -> None:
        expected = {
            "manifestUrl": f"/api/papers/{BUILT_IN_ID}/manifest",
            "questionsUrl": f"/api/papers/{BUILT_IN_ID}/questions",
            "answersUrl": f"/api/papers/{BUILT_IN_ID}/answers",
            "assistantUrl": f"/api/papers/{BUILT_IN_ID}/assistant",
        }
        for field, url in expected.items():
            self.assertRegex(
                self.javascript,
                rf"{field}:\s*['\"]{re.escape(url)}['\"]",
            )
        self.assertIn('id="ai-floating-launcher"', self.html)
        self.assertIn('id="ai-question-panel"', self.html)
        self.assertIn('id="exam-audio"', self.html)
        self.assertIn('id="question-workspace"', self.html)
        self.assertIn("aiLauncher.hidden = !paperConfig.assistantUrl", self.javascript)

        built_in_config = self.javascript[:self.javascript.index("const requestedPaperId")]
        self.assertNotIn("audioUrl:", built_in_config)
        configure_audio = javascript_function(self.javascript, "configureExamAudio")
        self.assertIn("manifest?.audioUrl", configure_audio)
        self.assertNotIn("paperConfig.audioUrl", configure_audio)
        self.assertNotIn("fetch(", configure_audio)
        self.assertNotIn("HEAD", configure_audio)
        self.assertNotIn("loadedmetadata", configure_audio)
        self.assertNotIn("player.load()", configure_audio)
        self.assertLess(configure_audio.index("if (!audioUrl)"), configure_audio.index("player.src = audioUrl"))
        self.assertLess(configure_audio.index("player.src = audioUrl"), configure_audio.index("reveal();"))

    def test_builtin_question_and_answer_documents_are_coherent(self) -> None:
        questions = self.question_document.get("questions")
        answers = self.answer_document.get("answers")
        self.assertEqual(self.question_document.get("examId"), BUILT_IN_ID)
        self.assertEqual(self.answer_document.get("examId"), BUILT_IN_ID)
        self.assertIsInstance(questions, list)
        self.assertIsInstance(answers, list)
        self.assertGreater(len(questions), 0)

        pages = {int(page["number"]): page for page in self.manifest["pages"]}
        by_id = {str(question["questionId"]): question for question in questions}
        self.assertEqual(len(by_id), len(questions), "question IDs must be unique")

        for question_id, question in by_id.items():
            self.assertRegex(question_id, r"^(?:q[1-9][0-9]*|writing-[1-9][0-9]*|translation-[1-9][0-9]*)$")
            self.assertIn(question.get("type"), {"single_choice", "matching", "writing", "translation"})
            self.assertIn(question.get("page"), pages)
            self.assertGreaterEqual(float(question.get("confidence", -1)), 0)
            self.assertLessEqual(float(question.get("confidence", 2)), 1)

            bbox = question.get("bbox")
            self.assertIsInstance(bbox, dict)
            page = pages[int(question["page"])]
            self.assertGreater(float(bbox.get("width", 0)), 0)
            self.assertGreater(float(bbox.get("height", 0)), 0)
            self.assertGreaterEqual(float(bbox.get("x", -1)), 0)
            self.assertGreaterEqual(float(bbox.get("y", -1)), 0)
            self.assertLessEqual(float(bbox["x"]) + float(bbox["width"]), float(page["width"]) + 1)
            self.assertLessEqual(float(bbox["y"]) + float(bbox["height"]), float(page["height"]) + 1)

        seen_answers: set[str] = set()
        for answer in answers:
            question_id = str(answer.get("questionId") or "")
            self.assertIn(question_id, by_id)
            self.assertNotIn(question_id, seen_answers)
            seen_answers.add(question_id)
            option_labels = {
                str(option.get("label") or option.get("key") or "").upper()
                for option in by_id[question_id].get("options", [])
            }
            self.assertIn(str(answer.get("answer") or "").upper(), option_labels)


class StaticAssetFreshnessContractTests(unittest.TestCase):
    def test_unified_entry_assets_are_versioned_and_not_cached_by_the_dev_server(self) -> None:
        index_html = (PUBLIC / "index.html").read_text(encoding="utf-8")
        reader_html = (PUBLIC / "reader.html").read_text(encoding="utf-8")
        server_source = (PROJECT_ROOT / "server" / "app.py").read_text(encoding="utf-8")

        self.assertRegex(index_html, r'css/home\.css\?v=[^"\s]+')
        self.assertRegex(index_html, r'js/home\.js\?v=[^"\s]+')
        self.assertRegex(reader_html, r'css/reader\.css\?v=[^"\s]+')
        self.assertRegex(reader_html, r'js/reader\.js\?v=[^"\s]+')
        self.assertIn('{".html", ".js", ".css"}', server_source)
        self.assertIn('self.send_header("Cache-Control", "no-store")', server_source)

    def test_every_full_paper_entry_uses_the_versioned_unified_reader_url(self) -> None:
        upload_html = (PUBLIC / "upload.html").read_text(encoding="utf-8")
        sources = {
            "home": (PUBLIC / "js" / "home.js").read_text(encoding="utf-8"),
            "upload": (PUBLIC / "js" / "upload.js").read_text(encoding="utf-8"),
            "review": (PUBLIC / "js" / "review.js").read_text(encoding="utf-8"),
        }

        for name, source in sources.items():
            with self.subTest(source=name):
                self.assertIn("unifiedReaderUrl", source)
                self.assertIn("reader.html?paper=", source)
                self.assertIn("&cachefix=2", source)
                self.assertNotIn("practice.html", source)
        self.assertIn("reader.html?paper=2021-06-01&amp;cachefix=2", upload_html)


if __name__ == "__main__":
    unittest.main()
