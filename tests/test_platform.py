from __future__ import annotations

import io
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

from server.platform import (
    PlatformError,
    _extract_answers,
    _extract_document,
    _extract_questions,
    _merge_detached_question_stems,
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
