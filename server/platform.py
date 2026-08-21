#!/usr/bin/env python3
"""Runtime exam ingestion, parsing, retrieval, and file-serving support.

This module deliberately sits beside the existing static/TTS/chat server.  It
does not publish uploaded files through ``public/`` and it produces the same
page/word manifest shape already consumed by the reader.

Only the Python standard library is required.  PDF and OCR work is delegated
to bounded adapters (Poppler, the optional PaddleOCR sidecar, OCRmyPDF, and
Tesseract) when those services or programs are installed.
"""

from __future__ import annotations

import cgi
import hashlib
import ipaddress
import json
import math
import mimetypes
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import unicodedata
import uuid
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from .paddle_ocr import PaddleOCRClient, PaddleOCRError, PaddleOCRUnavailable


PROJECT_ROOT = Path(__file__).resolve().parent.parent
EXAMS_DIR = PROJECT_ROOT / "data" / "exams"
XHTML_NAMESPACE = {"x": "http://www.w3.org/1999/xhtml"}

MAX_UPLOAD_BYTES = 460 * 1024 * 1024
MAX_PDF_BYTES = 80 * 1024 * 1024
MAX_AUDIO_BYTES = 300 * 1024 * 1024
MAX_PDF_PAGES = 120
MAX_TITLE_CHARS = 160
MAX_ASSISTANT_BYTES = 48 * 1024
MAX_ASSISTANT_MESSAGE_CHARS = 8_000
MAX_ASSISTANT_HISTORY = 12
MAX_REVIEW_BYTES = 256 * 1024
MAX_REVIEW_OPERATIONS = 100
MAX_REVIEW_REASON_CHARS = 500
PDF_TIMEOUT_SECONDS = 180
OCR_TIMEOUT_SECONDS = 900
DEEPSEEK_TIMEOUT_SECONDS = 60
DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"

SAFE_EXAM_ID = re.compile(r"^exam-[0-9]{8}-[0-9a-f]{12}$")
SAFE_PAGE_ASSET = re.compile(r"^page-[1-9][0-9]{0,2}\.jpg$")
SAFE_QUESTION_ID = re.compile(
    r"^(?:q([1-9][0-9]{0,2})|(writing|translation)-([1-9][0-9]{0,2}))$"
)
SAFE_REVIEW_REVISION_DIRECTORY = re.compile(r"^[0-9]{6}$")
QUESTION_TYPES = frozenset({"single_choice", "matching", "writing", "translation", "unknown"})
QUESTION_START = re.compile(r"^\s*(?:question\s+)?([1-9][0-9]{0,2})\s*[.、)]\s*(.*)$", re.I)
OPTION_START = re.compile(r"^\s*([A-D])\s*[.、)]\s*(.+)$", re.I)
INDIVIDUAL_ANSWER = re.compile(
    r"(?<![\d(])([1-9][0-9]{0,2})\s*(?:[.、:：\-]|\s)\s*"
    r"(?:答案\s*[:：]?\s*)?([A-O])(?=$|[\s,，。;；:：)])",
    re.I,
)
ANSWER_RANGE = re.compile(
    r"(?<!\d)([1-9][0-9]{0,2})\s*[-—~～至]\s*([1-9][0-9]{0,2})"
    r"\s*[:：]?\s*([A-O](?:\s*[A-O]){1,19})(?=$|\s|[,，。;；])",
    re.I,
)

AUDIO_EXTENSIONS = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4"}
REVIEW_LABELS = {"reliable": "可靠", "suggestedReview": "建议检查", "manualReview": "人工确认"}


class PlatformError(Exception):
    """An expected API or pipeline error safe to show to the uploader."""

    def __init__(self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.message = message
        self.status = status


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _atomic_json(path: Path, document: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as output:
            json.dump(document, output, ensure_ascii=False, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        os.replace(str(temporary), str(path))
    finally:
        temporary.unlink(missing_ok=True)


def _read_json(path: Path, fallback: object = None) -> object:
    try:
        with path.open("r", encoding="utf-8") as source:
            return json.load(source)
    except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return fallback


def _safe_exam_directory(exam_id: str) -> Path:
    if not SAFE_EXAM_ID.fullmatch(exam_id):
        raise PlatformError("invalid exam id", HTTPStatus.NOT_FOUND)
    root = EXAMS_DIR.resolve()
    candidate = (root / exam_id).resolve()
    if candidate.parent != root:
        raise PlatformError("invalid exam id", HTTPStatus.NOT_FOUND)
    return candidate


def _review_status(confidence: float) -> str:
    if confidence >= 0.95:
        return "reliable"
    if confidence >= 0.80:
        return "suggestedReview"
    return "manualReview"


def _review_summary(items: list[dict[str, object]]) -> dict[str, int]:
    counts = {"total": len(items), "reliable": 0, "suggestedReview": 0, "manualReview": 0}
    for item in items:
        label = str(item.get("reviewStatus") or _review_status(float(item.get("confidence", 0))))
        if label in counts:
            counts[label] += 1
    return counts


def _unresolved_question_gaps(items: list[dict[str, object]]) -> list[dict[str, object]]:
    """Report internal number gaps without manufacturing question content."""

    numbers = sorted(
        {
            int(item["number"])
            for item in items
            if isinstance(item.get("number"), int) and 1 <= int(item["number"]) <= 200
        }
    )
    if len(numbers) < 2:
        return []
    present = set(numbers)
    return [
        {
            "questionId": f"q{number}",
            "number": number,
            "reason": "相邻题号之间存在缺口，但文字坐标中没有足够证据生成题干；系统未猜测该题内容",
            "reviewStatus": "manualReview",
            "reviewLabel": REVIEW_LABELS["manualReview"],
        }
        for number in range(numbers[0], numbers[-1] + 1)
        if number not in present
    ]


def _review_etag(revision: int) -> str:
    return f'"review-r{max(0, int(revision))}"'


def _review_document_digest(document: dict[str, object]) -> str:
    encoded = json.dumps(
        document,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _parse_review_etag(value: str) -> int:
    match = re.fullmatch(r'"review-r(0|[1-9][0-9]*)"', str(value or "").strip())
    if not match:
        raise PlatformError(
            'If-Match must contain the current review ETag, for example "review-r0"',
            HTTPStatus.PRECONDITION_REQUIRED,
        )
    return int(match.group(1))


def _review_text(value: object, label: str, maximum: int, *, required: bool = False) -> str:
    if not isinstance(value, str):
        raise PlatformError(f"{label} must be a string")
    text = unicodedata.normalize("NFC", value).strip()
    if required and not text:
        raise PlatformError(f"{label} must not be empty")
    if len(text) > maximum:
        raise PlatformError(f"{label} may contain at most {maximum} characters")
    if any(unicodedata.category(character) == "Cc" and character not in "\n\t" for character in text):
        raise PlatformError(f"{label} contains unsupported control characters")
    return text


def _review_page_dimensions(manifest: dict[str, object]) -> dict[int, tuple[float, float]]:
    dimensions: dict[int, tuple[float, float]] = {}
    pages = manifest.get("pages", [])
    if not isinstance(pages, list):
        return dimensions
    for page in pages:
        if not isinstance(page, dict):
            continue
        try:
            number = int(page["number"])
            width = float(page["width"])
            height = float(page["height"])
        except (KeyError, TypeError, ValueError):
            continue
        if number > 0 and width > 0 and height > 0 and all(math.isfinite(value) for value in (width, height)):
            dimensions[number] = (width, height)
    return dimensions


def _normalize_review_question(
    raw: object,
    manifest: dict[str, object],
    existing: dict[str, object] | None,
    revision: int,
    actor: str,
    reviewed_at: str,
) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise PlatformError("upsertQuestion.question must be an object")
    allowed = {"questionId", "number", "type", "page", "bbox", "stem", "options"}
    unknown = set(raw) - allowed
    if unknown:
        raise PlatformError(f"question contains unsupported fields: {', '.join(sorted(unknown))}")
    missing = allowed - set(raw)
    if missing:
        raise PlatformError(f"question is missing fields: {', '.join(sorted(missing))}")

    question_id = _review_text(raw.get("questionId"), "question.questionId", 32, required=True)
    identifier = SAFE_QUESTION_ID.fullmatch(question_id)
    if not identifier:
        raise PlatformError("question.questionId must look like q26, writing-1, or translation-1")
    question_type = _review_text(raw.get("type"), "question.type", 32, required=True)
    if question_type not in QUESTION_TYPES:
        raise PlatformError(f"question.type must be one of: {', '.join(sorted(QUESTION_TYPES))}")

    objective_number, long_type, _ = identifier.groups()
    raw_number = raw.get("number")
    if objective_number:
        if isinstance(raw_number, bool) or not isinstance(raw_number, int) or raw_number != int(objective_number):
            raise PlatformError("qN question.number must be the integer N")
        if question_type in {"writing", "translation"}:
            raise PlatformError("qN questions cannot use writing or translation type")
        number: object = raw_number
    else:
        if question_type != long_type:
            raise PlatformError(f"{question_id} must use type {long_type}")
        if isinstance(raw_number, bool) or not isinstance(raw_number, (str, int)):
            raise PlatformError("long-response question.number must be a short string or integer")
        number = _review_text(str(raw_number), "question.number", 32, required=True)

    raw_page = raw.get("page")
    if isinstance(raw_page, bool) or not isinstance(raw_page, int):
        raise PlatformError("question.page must be an integer")
    dimensions = _review_page_dimensions(manifest)
    if raw_page not in dimensions:
        raise PlatformError("question.page is outside the paper manifest")
    page_width, page_height = dimensions[raw_page]

    raw_bbox = raw.get("bbox")
    if not isinstance(raw_bbox, dict) or set(raw_bbox) != {"x", "y", "width", "height"}:
        raise PlatformError("question.bbox must contain only x, y, width, and height")
    try:
        x, y, width, height = (float(raw_bbox[key]) for key in ("x", "y", "width", "height"))
    except (TypeError, ValueError):
        raise PlatformError("question.bbox values must be numbers")
    if not all(math.isfinite(value) for value in (x, y, width, height)) or x < 0 or y < 0 or width <= 0 or height <= 0:
        raise PlatformError("question.bbox must be a finite positive rectangle")
    if x + width > page_width + 0.5 or y + height > page_height + 0.5:
        raise PlatformError("question.bbox must stay within its manifest page")

    # Listening questions in CET paper PDFs often print only the options; the
    # spoken question stem exists in the audio, not on the page.  An empty stem
    # is therefore valid for objective questions, but not for long responses.
    stem = _review_text(
        raw.get("stem"),
        "question.stem",
        12_000,
        required=question_type in {"writing", "translation"},
    )
    raw_options = raw.get("options")
    if not isinstance(raw_options, list) or len(raw_options) > 15:
        raise PlatformError("question.options must be an array with at most 15 items")
    options: list[dict[str, object]] = []
    labels: set[str] = set()
    for index, raw_option in enumerate(raw_options):
        if not isinstance(raw_option, dict) or set(raw_option) != {"label", "text"}:
            raise PlatformError(f"question.options[{index}] must contain only label and text")
        label = _review_text(raw_option.get("label"), f"question.options[{index}].label", 1, required=True).upper()
        if label not in "ABCDEFGHIJKLMNO" or label in labels:
            raise PlatformError("question option labels must be unique letters A-O")
        labels.add(label)
        option_text = _review_text(raw_option.get("text"), f"question.options[{index}].text", 4_000)
        option: dict[str, object] = {"label": label, "text": option_text}
        if not option_text:
            option["textMissing"] = True
        options.append(option)
    if question_type in {"single_choice", "matching"} and len(options) < 2:
        raise PlatformError(f"{question_type} questions require at least two options")
    if question_type in {"writing", "translation"} and options:
        raise PlatformError(f"{question_type} questions cannot contain options")
    if question_type == "unknown" and len(options) == 1:
        raise PlatformError("unknown questions may not contain exactly one option")

    options_incomplete = any(not str(option.get("text") or "").strip() for option in options)
    # ``unknown`` is a deliberate unresolved state.  A human save must not
    # accidentally promote it to a reliable, gradeable question merely
    # because its option text happens to be complete.
    unresolved_type = question_type == "unknown"
    confidence = 0.79 if options_incomplete or unresolved_type else 1.0
    status = _review_status(confidence)
    normalized: dict[str, object] = {
        "questionId": question_id,
        "number": number,
        "type": question_type,
        "page": raw_page,
        "bbox": {"x": round(x, 3), "y": round(y, 3), "width": round(width, 3), "height": round(height, 3)},
        "stem": stem,
        "options": options,
        "optionsIncomplete": options_incomplete,
        "confidence": confidence,
        "reviewStatus": status,
        "reviewLabel": REVIEW_LABELS[status],
        "reviewRequired": options_incomplete or unresolved_type,
        "source": "human_review",
        "verification": {"method": "human", "actor": actor, "revision": revision, "reviewedAt": reviewed_at},
    }
    if existing and existing.get("section"):
        normalized["section"] = str(existing["section"])[:160]
    parser_confidence = existing.get("parserConfidence") if existing else None
    if parser_confidence is None and existing and existing.get("source") != "human_review":
        parser_confidence = existing.get("confidence")
    if isinstance(parser_confidence, (int, float)) and not isinstance(parser_confidence, bool) and math.isfinite(float(parser_confidence)):
        normalized["parserConfidence"] = round(max(0.0, min(1.0, float(parser_confidence))), 3)
    return normalized


def _normalize_review_answer(
    raw: object,
    questions: dict[str, dict[str, object]],
    existing: dict[str, object] | None,
    revision: int,
    actor: str,
    reviewed_at: str,
) -> dict[str, object]:
    if not isinstance(raw, dict):
        raise PlatformError("upsertAnswer.answer must be an object")
    allowed = {"questionId", "answer", "explanation"}
    unknown = set(raw) - allowed
    if unknown:
        raise PlatformError(f"answer contains unsupported fields: {', '.join(sorted(unknown))}")
    if not {"questionId", "answer"}.issubset(raw):
        raise PlatformError("answer must contain questionId and answer")
    question_id = _review_text(raw.get("questionId"), "answer.questionId", 32, required=True)
    question = questions.get(question_id)
    if not question:
        raise PlatformError("answer.questionId does not exist in the reviewed paper")
    if str(question.get("type")) not in {"single_choice", "matching"}:
        raise PlatformError("only objective questions may receive an answer key")
    answer = _review_text(raw.get("answer"), "answer.answer", 1, required=True).upper()
    labels = {
        str(option.get("label") or "").upper()
        for option in question.get("options", [])
        if isinstance(option, dict)
    }
    if answer not in labels:
        raise PlatformError("answer.answer must match one of the reviewed question options")
    explanation = _review_text(raw.get("explanation", ""), "answer.explanation", 12_000)
    normalized: dict[str, object] = {
        "questionId": question_id,
        "answer": answer,
        "explanation": explanation,
        "confidence": 1.0,
        "source": "human_review",
        "reviewStatus": "reliable",
        "reviewLabel": REVIEW_LABELS["reliable"],
        "reviewRequired": False,
        "verification": {"method": "human", "actor": actor, "revision": revision, "reviewedAt": reviewed_at},
    }
    if existing and isinstance(existing.get("page"), int):
        normalized["page"] = existing["page"]
    parser_confidence = existing.get("parserConfidence") if existing else None
    if parser_confidence is None and existing and existing.get("source") != "human_review":
        parser_confidence = existing.get("confidence")
    if isinstance(parser_confidence, (int, float)) and not isinstance(parser_confidence, bool) and math.isfinite(float(parser_confidence)):
        normalized["parserConfidence"] = round(max(0.0, min(1.0, float(parser_confidence))), 3)
    return normalized


def _review_issues(
    questions_document: dict[str, object],
    answers_document: dict[str, object],
) -> list[dict[str, object]]:
    issues: list[dict[str, object]] = []
    seen: set[str] = set()

    def append(issue_id: str, **values: object) -> None:
        if issue_id in seen:
            return
        seen.add(issue_id)
        issues.append({"issueId": issue_id, **values})

    for unresolved in questions_document.get("unresolved", []):
        if not isinstance(unresolved, dict):
            continue
        question_id = str(unresolved.get("questionId") or "unknown")
        append(
            f"missing-question:{question_id}",
            kind="missing_question",
            targetId=question_id,
            message=str(unresolved.get("reason") or "题号存在缺口，需要人工补录")[:500],
            severity="manualReview",
        )
    for question in questions_document.get("questions", []):
        if not isinstance(question, dict) or not question.get("reviewRequired"):
            continue
        question_id = str(question.get("questionId") or "unknown")
        append(
            f"question-review:{question_id}",
            kind="question_review",
            targetId=question_id,
            page=question.get("page"),
            message=str(question.get("reviewReason") or "题目解析结果需要人工复核")[:500],
            severity=str(question.get("reviewStatus") or "manualReview"),
        )
    for answer in answers_document.get("answers", []):
        if not isinstance(answer, dict) or not answer.get("reviewRequired"):
            continue
        question_id = str(answer.get("questionId") or "unknown")
        append(
            f"answer-review:{question_id}",
            kind="answer_review",
            targetId=question_id,
            page=answer.get("page"),
            message="答案绑定需要人工复核",
            severity=str(answer.get("reviewStatus") or "manualReview"),
        )
    for index, conflict in enumerate(answers_document.get("conflicts", [])):
        if not isinstance(conflict, dict):
            continue
        question_id = str(conflict.get("questionId") or "unknown")
        digest = hashlib.sha256(json.dumps(conflict, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:10]
        append(
            f"answer-conflict:{question_id}:{digest}",
            kind="answer_conflict",
            targetId=question_id,
            message=str(conflict.get("reason") or f"第 {index + 1} 个答案冲突需要人工复核")[:500],
            severity="manualReview",
        )
    return issues


def _refresh_rag_answers(
    source: Path,
    destination: Path,
    answers: list[dict[str, object]],
    superseded_question_ids: set[str],
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_file():
        shutil.copy2(str(source), str(destination))
    else:
        _build_index(destination, [], [])
    connection = sqlite3.connect(str(destination))
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("DELETE FROM chunks WHERE kind = 'official_answer'")
        # Raw answer-page chunks are useful evidence until a human explicitly
        # changes or removes that question's answer.  Keeping a superseded
        # chunk would let the same revision claim both the old and new answer.
        if superseded_question_ids:
            placeholders = ",".join("?" for _ in superseded_question_ids)
            connection.execute(
                f"DELETE FROM chunks WHERE kind = 'answer_text' AND question_id IN ({placeholders})",
                tuple(sorted(superseded_question_ids)),
            )
        for answer in answers:
            provenance = "人工复核" if answer.get("source") == "human_review" else "上传答案资料"
            content = f"{answer['questionId']} {provenance}给出的正确答案：{answer['answer']}。"
            if answer.get("explanation"):
                content += f" {provenance}中的解析：{answer['explanation']}"
            connection.execute(
                "INSERT INTO chunks(question_id, kind, content, embedding) VALUES (?, ?, ?, ?)",
                (
                    str(answer["questionId"]),
                    "official_answer",
                    content,
                    json.dumps(_embedding(content), separators=(",", ":")),
                ),
            )
        connection.commit()
    except (OSError, sqlite3.Error) as error:
        connection.rollback()
        raise PlatformError(f"无法更新复核后的答案索引：{error}", HTTPStatus.INTERNAL_SERVER_ERROR)
    finally:
        connection.close()


def _run(command: list[str], timeout: int, error_message: str) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        raise PlatformError(f"{error_message}：缺少命令 {command[0]}", HTTPStatus.SERVICE_UNAVAILABLE)
    except subprocess.TimeoutExpired:
        raise PlatformError(f"{error_message}：处理超时", HTTPStatus.UNPROCESSABLE_ENTITY)
    except OSError as error:
        raise PlatformError(f"{error_message}：{error}", HTTPStatus.UNPROCESSABLE_ENTITY)
    if result.returncode != 0:
        diagnostic = result.stderr.decode("utf-8", "replace").strip().splitlines()
        suffix = f"（{diagnostic[-1][:240]}）" if diagnostic else ""
        raise PlatformError(f"{error_message}{suffix}", HTTPStatus.UNPROCESSABLE_ENTITY)
    return result


def _ocr_languages() -> str:
    """Choose OCR languages without claiming unavailable Chinese support."""

    configured = os.environ.get("CET_OCR_LANGUAGES", "").strip()
    if configured:
        if not re.fullmatch(r"[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*", configured):
            raise PlatformError("CET_OCR_LANGUAGES 格式无效，应类似 eng+chi_sim")
        return configured
    tesseract = shutil.which("tesseract")
    if not tesseract:
        return "eng"
    try:
        result = subprocess.run([tesseract, "--list-langs"], check=False, capture_output=True, timeout=12)
        available = set(result.stdout.decode("utf-8", "replace").split())
    except (OSError, subprocess.TimeoutExpired):
        return "eng"
    return "eng+chi_sim" if {"eng", "chi_sim"}.issubset(available) else "eng"


def _clean_title(raw_title: str, original_name: str) -> str:
    title = "".join(character for character in raw_title if unicodedata.category(character) != "Cc").strip()
    if not title:
        title = Path(original_name).stem.strip() or "未命名英语试卷"
    return title[:MAX_TITLE_CHARS]


def _file_size(file_object) -> int:
    current = file_object.tell()
    file_object.seek(0, os.SEEK_END)
    size = file_object.tell()
    file_object.seek(current)
    return size


def _read_header(file_object, length: int = 16) -> bytes:
    current = file_object.tell()
    file_object.seek(0)
    header = file_object.read(length)
    file_object.seek(current)
    return header


def _validate_pdf_field(field, label: str) -> tuple[int, str]:
    filename = Path(str(field.filename or "")).name
    if Path(filename).suffix.lower() != ".pdf":
        raise PlatformError(f"{label}必须是 .pdf 文件")
    size = _file_size(field.file)
    if size < 32 or size > MAX_PDF_BYTES:
        raise PlatformError(f"{label}大小必须在 32 字节到 {MAX_PDF_BYTES // (1024 * 1024)} MB 之间")
    if not _read_header(field.file, 5).startswith(b"%PDF-"):
        raise PlatformError(f"{label}文件签名无效，不是有效 PDF")
    return size, filename


def _validate_audio_field(field) -> tuple[int, str, str]:
    filename = Path(str(field.filename or "")).name
    extension = Path(filename).suffix.lower()
    if extension not in AUDIO_EXTENSIONS:
        raise PlatformError("听力文件必须是 MP3、WAV 或 M4A")
    size = _file_size(field.file)
    if size < 12 or size > MAX_AUDIO_BYTES:
        raise PlatformError(f"听力文件大小必须在 12 字节到 {MAX_AUDIO_BYTES // (1024 * 1024)} MB 之间")
    header = _read_header(field.file, 16)
    valid = False
    if extension == ".mp3":
        valid = header.startswith(b"ID3") or (len(header) >= 2 and header[0] == 0xFF and header[1] & 0xE0 == 0xE0)
    elif extension == ".wav":
        valid = header[:4] == b"RIFF" and header[8:12] == b"WAVE"
    elif extension == ".m4a":
        valid = len(header) >= 12 and header[4:8] == b"ftyp"
    if not valid:
        raise PlatformError("听力文件签名与扩展名不匹配")
    return size, filename, AUDIO_EXTENSIONS[extension]


def _copy_uploaded_file(source, destination: Path, maximum: int) -> str:
    source.seek(0)
    digest = hashlib.sha256()
    written = 0
    with destination.open("xb") as output:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            written += len(chunk)
            if written > maximum:
                raise PlatformError("uploaded file exceeds its size limit")
            output.write(chunk)
            digest.update(chunk)
        output.flush()
        os.fsync(output.fileno())
    return digest.hexdigest()


def _field(form: cgi.FieldStorage, name: str, required: bool = False):
    try:
        value = form[name]
    except KeyError:
        value = None
    if isinstance(value, list):
        raise PlatformError(f"multipart field {name} may appear only once")
    if required and (value is None or not getattr(value, "filename", None)):
        raise PlatformError(f"multipart field {name} is required")
    return value


def _parse_bbox(path: Path) -> list[dict[str, object]]:
    try:
        root = ET.parse(str(path)).getroot()
    except (ET.ParseError, OSError, ValueError) as error:
        raise PlatformError(f"无法解析 PDF 文字坐标：{error}", HTTPStatus.UNPROCESSABLE_ENTITY)
    pages: list[dict[str, object]] = []
    for page_number, page in enumerate(root.findall(".//x:page", XHTML_NAMESPACE), start=1):
        try:
            width = float(page.attrib["width"])
            height = float(page.attrib["height"])
        except (KeyError, ValueError):
            raise PlatformError("PDF 文字坐标缺少页面尺寸", HTTPStatus.UNPROCESSABLE_ENTITY)
        words: list[dict[str, object]] = []
        word_index = 0
        for line_index, line in enumerate(page.findall(".//x:line", XHTML_NAMESPACE)):
            for word in line.findall("x:word", XHTML_NAMESPACE):
                text = "".join(word.itertext()).strip()
                if not text:
                    continue
                try:
                    x_min = float(word.attrib["xMin"])
                    y_min = float(word.attrib["yMin"])
                    x_max = float(word.attrib["xMax"])
                    y_max = float(word.attrib["yMax"])
                except (KeyError, ValueError):
                    continue
                if x_max <= x_min or y_max <= y_min:
                    continue
                words.append(
                    {
                        "id": word_index,
                        "line": line_index,
                        "text": text[:500],
                        "x": round(x_min, 3),
                        "y": round(y_min, 3),
                        "width": round(x_max - x_min, 3),
                        "height": round(y_max - y_min, 3),
                    }
                )
                word_index += 1
        pages.append(
            {
                "number": page_number,
                "width": round(width, 3),
                "height": round(height, 3),
                "words": words,
            }
        )
    if not pages:
        raise PlatformError("PDF 中没有可处理的页面", HTTPStatus.UNPROCESSABLE_ENTITY)
    if len(pages) > MAX_PDF_PAGES:
        raise PlatformError(f"PDF 页数不能超过 {MAX_PDF_PAGES} 页", HTTPStatus.UNPROCESSABLE_ENTITY)
    return pages


def _extract_bbox_pdf(pdf: Path, work: Path, stem: str) -> list[dict[str, object]]:
    pdftotext = shutil.which("pdftotext")
    if not pdftotext:
        raise PlatformError("服务器缺少 Poppler pdftotext，无法提取 PDF 文字坐标", HTTPStatus.SERVICE_UNAVAILABLE)
    bbox = work / f"{stem}.xhtml"
    _run([pdftotext, "-bbox-layout", str(pdf), str(bbox)], PDF_TIMEOUT_SECONDS, "PDF 文字提取失败")
    return _parse_bbox(bbox)


def _meaningful_word_count(pages: list[dict[str, object]]) -> int:
    return sum(
        1
        for page in pages
        for word in page.get("words", [])
        if re.search(r"[A-Za-z0-9\u4e00-\u9fff]", str(word.get("text", "")))
    )


def _png_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as image:
        header = image.read(24)
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise PlatformError("OCR 页面图像无效", HTTPStatus.UNPROCESSABLE_ENTITY)
    return int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")


def _render_ocr_page_images(
    pdf: Path,
    base_pages: list[dict[str, object]],
    work: Path,
    stem: str,
) -> list[Path]:
    pdftoppm = shutil.which("pdftoppm")
    if not pdftoppm:
        raise PlatformError(
            "扫描版 PDF 需要安装 Poppler pdftoppm 才能生成 OCR 页面图像",
            HTTPStatus.SERVICE_UNAVAILABLE,
        )
    numbers = [int(page["number"]) for page in base_pages]
    if not numbers:
        return []
    images: list[Path] = []
    contiguous = sorted(numbers) == list(range(min(numbers), max(numbers) + 1))
    if contiguous and len(numbers) > 1:
        prefix = work / f"{stem}-batch"
        _run(
            [
                pdftoppm,
                "-f",
                str(min(numbers)),
                "-l",
                str(max(numbers)),
                "-png",
                "-r",
                "200",
                str(pdf),
                str(prefix),
            ],
            PDF_TIMEOUT_SECONDS,
            "OCR 页面图像批量生成失败",
        )
        produced: dict[int, Path] = {}
        pattern = re.compile(rf"^{re.escape(prefix.name)}-0*([1-9][0-9]*)\.png$")
        for candidate in work.glob(f"{prefix.name}-*.png"):
            match = pattern.fullmatch(candidate.name)
            if match:
                produced[int(match.group(1))] = candidate
        for number in numbers:
            image = produced.get(number)
            if image is None:
                raise PlatformError(f"第 {number} 页没有生成 OCR 图像", HTTPStatus.UNPROCESSABLE_ENTITY)
            _png_dimensions(image)
            images.append(image)
        return images
    for page in base_pages:
        number = int(page["number"])
        prefix = work / f"{stem}-page-{number}"
        _run(
            [pdftoppm, "-f", str(number), "-l", str(number), "-singlefile", "-png", "-r", "200", str(pdf), str(prefix)],
            PDF_TIMEOUT_SECONDS,
            f"第 {number} 页 OCR 图像生成失败",
        )
        image = prefix.with_suffix(".png")
        _png_dimensions(image)
        images.append(image)
    return images


def _paddle_language() -> str:
    language = os.environ.get("CET_PADDLEOCR_LANGUAGE", "en").strip() or "en"
    if not re.fullmatch(r"[A-Za-z0-9_+-]{1,32}", language):
        raise PlatformError("CET_PADDLEOCR_LANGUAGE 格式无效，应类似 en 或 ch")
    return language


def _paddleocr_pages(
    pdf: Path,
    base_pages: list[dict[str, object]],
    work: Path,
    stem: str,
) -> list[dict[str, object]]:
    client = PaddleOCRClient.from_environment()
    if not client.configured:
        raise PaddleOCRUnavailable("CET_PADDLEOCR_URL is not configured")
    images = _render_ocr_page_images(pdf, base_pages, work, f"{stem}-paddleocr")
    try:
        return client.recognize_pages(images, base_pages, language=_paddle_language())
    finally:
        for image in images:
            image.unlink(missing_ok=True)


def _ocrmypdf_pages(
    pdf: Path,
    work: Path,
    stem: str,
    *,
    skip_text: bool,
) -> list[dict[str, object]]:
    ocrmypdf = shutil.which("ocrmypdf")
    if not ocrmypdf:
        raise PlatformError("服务器未安装 OCRmyPDF", HTTPStatus.SERVICE_UNAVAILABLE)
    searchable = work / f"{stem}-ocr.pdf"
    command = [
        ocrmypdf,
        "--output-type",
        "pdf",
        "--language",
        _ocr_languages(),
    ]
    if skip_text:
        command.append("--skip-text")
    # Do not deskew or rotate here.  The reader renders the original PDF, so
    # transformed OCR coordinates would no longer align with its page image.
    command.extend([str(pdf), str(searchable)])
    _run(
        command,
        OCR_TIMEOUT_SECONDS,
        "扫描版 PDF 的 OCRmyPDF 处理失败",
    )
    return _extract_bbox_pdf(searchable, work, f"{stem}-ocr-output")


def _merge_ocr_replacements(
    pages: list[dict[str, object]],
    candidates: list[dict[str, object]],
    target_numbers: set[int],
) -> tuple[list[dict[str, object]], set[int]]:
    base_by_number = {int(page["number"]): page for page in pages}
    replacements: dict[int, dict[str, object]] = {}
    for candidate in candidates:
        number = int(candidate.get("number", 0))
        base = base_by_number.get(number)
        if not base or number not in target_numbers or _meaningful_word_count([candidate]) < 3:
            continue
        try:
            same_geometry = (
                abs(float(candidate["width"]) - float(base["width"])) <= 0.5
                and abs(float(candidate["height"]) - float(base["height"])) <= 0.5
            )
        except (KeyError, TypeError, ValueError):
            same_geometry = False
        if same_geometry:
            replacements[number] = candidate
    return (
        [replacements.get(int(page["number"]), page) for page in pages],
        set(replacements),
    )


def _tesseract_pages(pdf: Path, base_pages: list[dict[str, object]], work: Path) -> list[dict[str, object]]:
    tesseract = shutil.which("tesseract")
    if not tesseract:
        raise PlatformError(
            "扫描版 PDF 需要配置 PaddleOCR、安装 OCRmyPDF，或安装 Tesseract 后重试",
            HTTPStatus.SERVICE_UNAVAILABLE,
        )
    images = _render_ocr_page_images(pdf, base_pages, work, "ocr")
    ocr_pages: list[dict[str, object]] = []
    languages = _ocr_languages()
    for page, image in zip(base_pages, images):
        number = int(page["number"])
        pixel_width, pixel_height = _png_dimensions(image)
        result = _run(
            [tesseract, str(image), "stdout", "-l", languages, "tsv"],
            OCR_TIMEOUT_SECONDS,
            f"第 {number} 页 Tesseract OCR 失败",
        )
        page_width = float(page["width"])
        page_height = float(page["height"])
        words: list[dict[str, object]] = []
        line_map: dict[tuple[int, int, int], int] = {}
        for raw_line in result.stdout.decode("utf-8", "replace").splitlines()[1:]:
            columns = raw_line.split("\t", 11)
            if len(columns) != 12 or columns[0] != "5":
                continue
            text = columns[11].strip()
            if not text:
                continue
            try:
                left, top, width, height = map(int, columns[6:10])
                confidence = float(columns[10])
                key = (int(columns[2]), int(columns[3]), int(columns[4]))
            except ValueError:
                continue
            if confidence < 20 or width <= 0 or height <= 0:
                continue
            if key not in line_map:
                line_map[key] = len(line_map)
            words.append(
                {
                    "id": len(words),
                    "line": line_map[key],
                    "text": text[:500],
                    "x": round(left * page_width / pixel_width, 3),
                    "y": round(top * page_height / pixel_height, 3),
                    "width": round(width * page_width / pixel_width, 3),
                    "height": round(height * page_height / pixel_height, 3),
                    "ocrConfidence": round(confidence / 100, 3),
                }
            )
        ocr_pages.append({**page, "words": words})
        image.unlink(missing_ok=True)
    return ocr_pages


def _extract_document(
    pdf: Path,
    work: Path,
    stem: str,
    on_ocr=None,
) -> tuple[list[dict[str, object]], str]:
    pages = [
        {**page, "extractionSource": "pdf_text"}
        for page in _extract_bbox_pdf(pdf, work, stem)
    ]
    # A cover page or a short writing prompt may legitimately be sparse; use a
    # per-document threshold instead of requiring text on every page.
    threshold = max(8, len(pages) * 3)
    original_word_count = _meaningful_word_count(pages)
    paddle_configuration_error = ""
    try:
        paddle_client = PaddleOCRClient.from_environment()
    except PaddleOCRError as error:
        paddle_client = PaddleOCRClient(endpoint="")
        paddle_configuration_error = str(error)[:500]
    sparse_pages = [
        page
        for page in pages
        if _meaningful_word_count([page]) < 3
    ]
    if original_word_count >= threshold and not sparse_pages:
        return pages, "pdf_text"

    if on_ocr:
        on_ocr()
    paddle_error = paddle_configuration_error
    used_engines: list[str] = []
    if paddle_client.configured:
        paddle_targets = sparse_pages if original_word_count >= threshold else pages
        try:
            paddle_pages = [
                {**page, "extractionSource": "paddleocr"}
                for page in _paddleocr_pages(pdf, paddle_targets, work, stem)
            ]
            if original_word_count >= threshold:
                pages, replaced = _merge_ocr_replacements(
                    pages,
                    paddle_pages,
                    {int(page["number"]) for page in sparse_pages},
                )
                if replaced:
                    used_engines.append("paddleocr")
                sparse_pages = [
                    page for page in pages if _meaningful_word_count([page]) < 3
                ]
                if not sparse_pages:
                    return pages, "pdf_text+" + "+".join(used_engines)
            else:
                if _meaningful_word_count(paddle_pages) >= threshold:
                    return paddle_pages, "paddleocr"
                paddle_error = "PaddleOCR 已运行，但没有识别出足够文字"
        except PaddleOCRError as error:
            paddle_error = str(error)[:500]

    # Mixed PDFs keep native coordinates on text pages and continue through
    # every installed fallback for only the still-sparse pages.  Blank cover
    # pages are allowed to remain sparse after all engines have been tried.
    if original_word_count >= threshold:
        if sparse_pages and shutil.which("ocrmypdf"):
            try:
                ocr_pages = [
                    {**page, "extractionSource": "ocrmypdf"}
                    for page in _ocrmypdf_pages(pdf, work, f"{stem}-mixed", skip_text=True)
                ]
                pages, replaced = _merge_ocr_replacements(
                    pages,
                    ocr_pages,
                    {int(page["number"]) for page in sparse_pages},
                )
                if replaced:
                    used_engines.append("ocrmypdf")
                sparse_pages = [
                    page for page in pages if _meaningful_word_count([page]) < 3
                ]
            except PlatformError:
                # Tesseract remains an independent fallback below.
                pass
        if sparse_pages and shutil.which("tesseract"):
            try:
                tesseract_pages = [
                    {**page, "extractionSource": "tesseract"}
                    for page in _tesseract_pages(pdf, sparse_pages, work)
                ]
                pages, replaced = _merge_ocr_replacements(
                    pages,
                    tesseract_pages,
                    {int(page["number"]) for page in sparse_pages},
                )
                if replaced:
                    used_engines.append("tesseract")
            except PlatformError:
                pass
        return pages, "pdf_text" + ("+" + "+".join(used_engines) if used_engines else "")

    fallback_errors: list[str] = []
    if shutil.which("ocrmypdf"):
        try:
            ocr_pages = [
                {**page, "extractionSource": "ocrmypdf"}
                for page in _ocrmypdf_pages(pdf, work, stem, skip_text=False)
            ]
            if _meaningful_word_count(ocr_pages) >= threshold:
                return ocr_pages, "ocrmypdf"
            fallback_errors.append("OCRmyPDF 已运行，但没有识别出足够文字")
        except PlatformError as error:
            fallback_errors.append(error.message)

    try:
        ocr_pages = [
            {**page, "extractionSource": "tesseract"}
            for page in _tesseract_pages(pdf, pages, work)
        ]
    except PlatformError as error:
        details = [message for message in [paddle_error, *fallback_errors, error.message] if message]
        if paddle_error:
            raise PlatformError(
                "；".join(details),
                error.status,
            ) from error
        if fallback_errors:
            raise PlatformError("；".join(details), error.status) from error
        raise
    if _meaningful_word_count(ocr_pages) < threshold:
        raise PlatformError("Tesseract 已运行，但没有识别出足够文字；请上传更清晰的扫描件", HTTPStatus.UNPROCESSABLE_ENTITY)
    return ocr_pages, "tesseract"


def _render_page_images(pdf: Path, pages: list[dict[str, object]], destination: Path) -> None:
    pdftoppm = shutil.which("pdftoppm")
    if not pdftoppm:
        raise PlatformError("服务器缺少 Poppler pdftoppm，无法生成页面图片", HTTPStatus.SERVICE_UNAVAILABLE)
    temporary = destination.parent / f".{destination.name}-{uuid.uuid4().hex}"
    temporary.mkdir(parents=True, exist_ok=False)
    try:
        numbers = [int(page["number"]) for page in pages]
        if not numbers or sorted(numbers) != list(range(1, max(numbers) + 1)):
            raise PlatformError("PDF 页面编号不连续，无法安全生成页面图片", HTTPStatus.UNPROCESSABLE_ENTITY)
        prefix = temporary / "render"
        _run(
            [
                pdftoppm,
                "-f",
                "1",
                "-l",
                str(max(numbers)),
                "-jpeg",
                "-r",
                "144",
                "-jpegopt",
                "quality=84,progressive=y,optimize=y",
                str(pdf),
                str(prefix),
            ],
            PDF_TIMEOUT_SECONDS,
            "PDF 页面图片批量生成失败",
        )
        pattern = re.compile(r"^render-0*([1-9][0-9]*)\.jpg$")
        produced: dict[int, Path] = {}
        for candidate in temporary.glob("render-*.jpg"):
            match = pattern.fullmatch(candidate.name)
            if match:
                produced[int(match.group(1))] = candidate
        for number in numbers:
            output = produced.get(number)
            if output is None or not output.is_file() or output.stat().st_size < 256:
                raise PlatformError(f"第 {number} 页没有生成有效图片", HTTPStatus.UNPROCESSABLE_ENTITY)
            output.rename(temporary / f"page-{number}.jpg")
        os.replace(str(temporary), str(destination))
    finally:
        if temporary.exists():
            shutil.rmtree(str(temporary), ignore_errors=True)


def _page_lines(pages: list[dict[str, object]]) -> list[dict[str, object]]:
    lines: list[dict[str, object]] = []
    for page in pages:
        grouped: dict[int, list[dict[str, object]]] = {}
        for word in page.get("words", []):
            try:
                line_number = int(word.get("line", 0))
            except (TypeError, ValueError):
                line_number = 0
            grouped.setdefault(line_number, []).append(word)
        for line_number in sorted(grouped):
            words = sorted(grouped[line_number], key=lambda item: (float(item.get("x", 0)), int(item.get("id", 0))))
            text = " ".join(str(item.get("text", "")).strip() for item in words).strip()
            if not text:
                continue
            left = min(float(item.get("x", 0)) for item in words)
            top = min(float(item.get("y", 0)) for item in words)
            right = max(float(item.get("x", 0)) + float(item.get("width", 0)) for item in words)
            bottom = max(float(item.get("y", 0)) + float(item.get("height", 0)) for item in words)
            lines.append(
                {
                    "page": int(page["number"]),
                    "line": line_number,
                    "extractionSource": str(page.get("extractionSource") or "pdf_text"),
                    "text": text,
                    "bbox": {
                        "x": round(left, 3),
                        "y": round(top, 3),
                        "width": round(right - left, 3),
                        "height": round(bottom - top, 3),
                    },
                    "words": words,
                }
            )
    return lines


def _union_bbox(lines: list[dict[str, object]], page_number: int) -> dict[str, float]:
    boxes = [line["bbox"] for line in lines if int(line["page"]) == page_number]
    if not boxes:
        return {"x": 0.0, "y": 0.0, "width": 0.0, "height": 0.0}
    left = min(float(box["x"]) for box in boxes)
    top = min(float(box["y"]) for box in boxes)
    right = max(float(box["x"]) + float(box["width"]) for box in boxes)
    bottom = max(float(box["y"]) + float(box["height"]) for box in boxes)
    return {
        "x": round(left, 3),
        "y": round(top, 3),
        "width": round(right - left, 3),
        "height": round(bottom - top, 3),
    }


def _structure_markers(lines: list[dict[str, object]]) -> list[dict[str, object]]:
    markers: list[dict[str, object]] = []
    patterns = (
        ("section", re.compile(r"^\s*section\s+([A-Z0-9]+)\b", re.I)),
        ("part", re.compile(r"^\s*part\s+([IVX0-9A-Z]+)\b", re.I)),
        ("directions", re.compile(r"^\s*directions?\s*[:：]", re.I)),
    )
    for line in lines:
        for marker_type, pattern in patterns:
            match = pattern.search(str(line["text"]))
            if match:
                markers.append(
                    {
                        "type": marker_type,
                        "page": line["page"],
                        "text": str(line["text"])[:1000],
                        "bbox": line["bbox"],
                        "confidence": 0.99,
                        "reviewRequired": False,
                    }
                )
                break
    return markers


def _question_candidate(block: list[dict[str, object]], source_kind: str) -> dict[str, object] | None:
    if not block:
        return None
    first_match = QUESTION_START.match(str(block[0]["text"]))
    if not first_match:
        return None
    number = int(first_match.group(1))
    if number > 200:
        return None
    page = int(block[0]["page"])
    stem_parts: list[str] = []
    first_stem = first_match.group(2).strip()
    options: list[dict[str, str]] = []
    option_labels: set[str] = set()
    used_lines = [block[0]]
    inline_option = re.compile(r"(?<![A-Za-z])([A-D])\s*[)）.]\s*", re.I)

    def consume_inline(text: str, allow_leading_stem: bool) -> bool:
        matches = list(inline_option.finditer(text))
        if not matches:
            return False
        leading = text[: matches[0].start()].strip()
        if leading and allow_leading_stem:
            stem_parts.append(leading)
        for index, match in enumerate(matches):
            label = match.group(1).upper()
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            option_text = text[match.end() : end].strip()
            if label in option_labels:
                continue
            option_labels.add(label)
            options.append({"label": label, "text": option_text[:4000]})
        return True

    if first_stem and not consume_inline(first_stem, allow_leading_stem=True):
        stem_parts.append(first_stem)
    marker = re.compile(r"^\s*(?:section\b|part\s+[IVX0-9A-Z]+\b|directions?\s*[:：])", re.I)
    for line in block[1:]:
        text = str(line["text"]).strip()
        if marker.search(text):
            break
        used_lines.append(line)
        option = OPTION_START.match(text)
        if option:
            label = option.group(1).upper()
            if label not in option_labels:
                option_labels.add(label)
                options.append({"label": label, "text": option.group(2).strip()[:4000]})
        elif consume_inline(text, allow_leading_stem=not options):
            continue
        elif options:
            # Wrapped lines after an option belong to that option, not to the
            # question stem.  This also prevents a following section heading
            # from turning the final multiple-choice item into a translation.
            previous = options[-1]
            previous["text"] = f"{previous['text']} {text}".strip()[:4000]
        elif len(" ".join(stem_parts)) < 8_000:
            stem_parts.append(text)
    stem = " ".join(part for part in stem_parts if part).strip()[:8_000]

    prompt_words = re.search(r"\b(write|translate|explain|complete|choose|answer)\b", stem, re.I)
    if (not stem or not re.search(r"[A-Za-z\u4e00-\u9fff]", stem)) and len(options) < 2:
        return None

    observed_option_count = len(options)
    observed_labels = [option["label"] for option in options]
    options_incomplete = False
    if {"A", "B"}.issubset(set(observed_labels)) and observed_option_count < 4:
        # CET Directions establish four selectable labels.  Missing text often
        # comes from a two-column extraction order.  Add only empty controls—
        # never fabricated option wording—and force manual review.
        by_label = {option["label"]: option for option in options}
        options = [
            by_label.get(label, {"label": label, "text": "", "textMissing": True})
            for label in "ABCD"
        ]
        options_incomplete = True
    labels = [option["label"] for option in options]
    sequential = labels == list("ABCD")[: len(labels)] if labels else False
    if len(options) >= 4 and sequential:
        confidence = 0.97
    elif len(options) >= 2 and sequential:
        confidence = 0.91
    elif "?" in stem or prompt_words:
        confidence = 0.84
    else:
        # Keep an explicit numbered statement as an unclassified question so
        # matching items are not silently lost, but require human review.
        confidence = 0.76
    candidate_uses_ocr = any(
        str(line.get("extractionSource") or source_kind) != "pdf_text"
        for line in used_lines
    )
    if candidate_uses_ocr:
        confidence -= 0.10
    if options_incomplete:
        confidence = min(confidence, 0.79)
    confidence = round(max(0.50, min(0.99, confidence)), 3)
    status = _review_status(confidence)
    question_type = "single_choice" if len(options) >= 2 else "unknown"
    lowered = stem.lower()
    if "writing" in lowered or "essay" in lowered:
        question_type = "writing"
    elif "translate" in lowered or "translation" in lowered:
        question_type = "translation"
    return {
        "questionId": f"q{number}",
        "number": number,
        "type": question_type,
        "page": page,
        "bbox": _union_bbox(used_lines, page),
        "stem": stem,
        "options": options,
        "optionsIncomplete": options_incomplete,
        "confidence": confidence,
        "reviewStatus": status,
        "reviewLabel": REVIEW_LABELS[status],
        "reviewRequired": confidence < 0.95,
        "source": "paper_pdf",
    }


def _merge_detached_question_stems(lines: list[dict[str, object]]) -> list[dict[str, object]]:
    """Join number-only boxes to an explicit stem printed on the same row.

    Poppler sometimes emits a narrow ``40.`` box and the sentence beside it as
    two independent XHTML lines.  Treating the boxes as document-order text
    drops the question or attaches several later stems to one number.  This
    merge is deliberately strict: same page, almost identical vertical
    position, a small horizontal gap, and visible language in the candidate.
    """

    replacements: dict[int, dict[str, object]] = {}
    consumed: set[int] = set()
    for index, line in enumerate(lines):
        number_match = re.fullmatch(r"\s*([1-9][0-9]{0,2})\s*[.、)]\s*", str(line["text"]))
        if not number_match:
            continue
        box = line["bbox"]
        page = int(line["page"])
        right = float(box["x"]) + float(box["width"])
        tolerance = max(2.2, float(box["height"]) * 0.28)
        candidates: list[tuple[float, int, dict[str, object]]] = []
        for other_index, other in enumerate(lines):
            if other_index == index or other_index in consumed or int(other["page"]) != page:
                continue
            other_box = other["bbox"]
            gap = float(other_box["x"]) - right
            if gap < -0.5 or gap > 42:
                continue
            if abs(float(other_box["y"]) - float(box["y"])) > tolerance:
                continue
            text = str(other["text"]).strip()
            if not re.search(r"[A-Za-z\u4e00-\u9fff]", text):
                continue
            if QUESTION_START.match(text) or OPTION_START.match(text):
                continue
            if re.match(r"^\s*(?:part|section|directions?)\b", text, re.I):
                continue
            candidates.append((gap, other_index, other))
        if not candidates:
            continue
        _, other_index, other = min(candidates, key=lambda item: (item[0], item[1]))
        other_box = other["bbox"]
        left = min(float(box["x"]), float(other_box["x"]))
        top = min(float(box["y"]), float(other_box["y"]))
        merged_right = max(
            float(box["x"]) + float(box["width"]),
            float(other_box["x"]) + float(other_box["width"]),
        )
        bottom = max(
            float(box["y"]) + float(box["height"]),
            float(other_box["y"]) + float(other_box["height"]),
        )
        replacements[index] = {
            **line,
            "text": f"{number_match.group(1)}. {str(other['text']).strip()}",
            "bbox": {
                "x": round(left, 3),
                "y": round(top, 3),
                "width": round(merged_right - left, 3),
                "height": round(bottom - top, 3),
            },
            "words": [*line.get("words", []), *other.get("words", [])],
        }
        consumed.add(other_index)
    return [replacements.get(index, line) for index, line in enumerate(lines) if index not in consumed]


def _question_section_context(
    question: dict[str, object],
    lines: list[dict[str, object]],
) -> tuple[str, str, list[str]]:
    """Return the nearest explicit section, its directions, and letter labels."""

    question_position = (int(question["page"]), float(question["bbox"].get("y", 0)))
    section_indexes = [
        index
        for index, line in enumerate(lines)
        if re.match(r"^\s*section\s+([A-Z0-9]+)\b", str(line["text"]), re.I)
        and (int(line["page"]), float(line["bbox"].get("y", 0))) <= question_position
    ]
    if not section_indexes:
        return "", "", []
    start = section_indexes[-1]
    section_match = re.match(r"^\s*section\s+([A-Z0-9]+)\b", str(lines[start]["text"]), re.I)
    section = f"Section {section_match.group(1).upper()}" if section_match else ""
    following: list[dict[str, object]] = []
    for line in lines[start + 1 :]:
        if re.match(r"^\s*section\s+([A-Z0-9]+)\b", str(line["text"]), re.I):
            break
        following.append(line)
    directions = " ".join(
        str(line["text"]).strip()
        for line in following[:12]
        if str(line["text"]).strip()
    )[:5000]
    labels = sorted(
        {
            match.group(1).upper()
            for line in following
            for match in [re.match(r"^\s*([A-O])\s*[)）.]\s*", str(line["text"]), re.I)]
            if match
        },
        key=lambda value: ord(value),
    )
    return section, directions, labels


def _extract_long_response_tasks(
    lines: list[dict[str, object]],
    source_kind: str,
) -> list[dict[str, object]]:
    """Create writing/translation inputs only from explicit paper headings."""

    definitions = (
        ("writing", "writing-1", "写作", re.compile(r"\bwrite\s+(?:an\s+)?essay\b", re.I)),
        ("translation", "translation-1", "翻译", re.compile(r"\btranslate\s+(?:a\s+)?passage\b", re.I)),
    )
    tasks: list[dict[str, object]] = []
    for question_type, question_id, number_label, evidence_pattern in definitions:
        heading_index = next(
            (
                index
                for index, line in enumerate(lines)
                if re.fullmatch(question_type, str(line["text"]).strip(), re.I)
            ),
            None,
        )
        if heading_index is None:
            continue
        end = len(lines)
        for index in range(heading_index + 1, len(lines)):
            if re.fullmatch(r"\s*part\s*", str(lines[index]["text"]), re.I):
                end = index
                break
        block = lines[heading_index:end]
        directions_index = next(
            (index for index, line in enumerate(block) if re.match(r"^\s*directions?\s*[:：]", str(line["text"]), re.I)),
            None,
        )
        if directions_index is None:
            continue
        prompt_lines = block[directions_index:]
        prompt = " ".join(str(line["text"]).strip() for line in prompt_lines if str(line["text"]).strip())[:12_000]
        if not evidence_pattern.search(prompt):
            continue
        page = int(block[0]["page"])
        prompt_on_page = [line for line in prompt_lines if int(line["page"]) == page]
        prompt_uses_ocr = any(
            str(line.get("extractionSource") or source_kind) != "pdf_text"
            for line in prompt_lines
        )
        confidence = 0.86 if prompt_uses_ocr else 0.96
        status = _review_status(confidence)
        tasks.append(
            {
                "questionId": question_id,
                "number": number_label,
                "type": question_type,
                "page": page,
                "bbox": _union_bbox(prompt_on_page or [block[0]], page),
                "stem": prompt,
                "options": [],
                "confidence": confidence,
                "reviewStatus": status,
                "reviewLabel": REVIEW_LABELS[status],
                "reviewRequired": confidence < 0.95,
                "source": "paper_pdf",
            }
        )
    return tasks


def _extract_questions(pages: list[dict[str, object]], source_kind: str) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    lines = _merge_detached_question_stems(_page_lines(pages))
    starts: list[int] = []
    for index, line in enumerate(lines):
        match = QUESTION_START.match(str(line["text"]))
        if match and 1 <= int(match.group(1)) <= 200:
            starts.append(index)
    candidates: dict[str, dict[str, object]] = {}
    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else min(len(lines), start + 30)
        # A question block is bounded to avoid absorbing a following passage
        # when the next question marker was not recognized.
        candidate = _question_candidate(lines[start : min(end, start + 30)], source_kind)
        if not candidate:
            continue
        question_id = str(candidate["questionId"])
        previous = candidates.get(question_id)
        if previous is None or float(candidate["confidence"]) > float(previous["confidence"]):
            candidates[question_id] = candidate
    questions = sorted(candidates.values(), key=lambda item: (int(item["number"]), int(item["page"])))
    for question in questions:
        section, directions, labels = _question_section_context(question, lines)
        if section:
            question["section"] = section
        matching_directions = (
            "paragraph" in directions.lower()
            and "letter" in directions.lower()
            and "corresponding" in directions.lower()
        )
        four_choice_directions = (
            "four choices" in directions.lower()
            and all(f"{label})" in directions.upper() for label in "ABCD")
        )
        if matching_directions and 2 <= len(labels) <= 15 and not question.get("options"):
            question["type"] = "matching"
            question["options"] = [
                {"label": label, "text": f"段落 {label}"}
                for label in labels
            ]
            confidence = min(0.94, max(0.82, float(question.get("confidence", 0))))
            question["confidence"] = round(confidence, 3)
            question["reviewStatus"] = _review_status(confidence)
            question["reviewLabel"] = REVIEW_LABELS[question["reviewStatus"]]
            question["reviewRequired"] = True
        elif four_choice_directions and not question.get("options") and "?" in str(question.get("stem", "")):
            # In a multi-column PDF the four option boxes can be emitted after
            # several narrow number boxes.  The section directions explicitly
            # establish A-D, so expose empty controls without inventing text.
            question["type"] = "single_choice"
            question["options"] = [
                {"label": label, "text": "", "textMissing": True}
                for label in "ABCD"
            ]
            question["optionsIncomplete"] = True
            confidence = min(0.79, float(question.get("confidence", 0.79)))
            question["confidence"] = round(confidence, 3)
            question["reviewStatus"] = _review_status(confidence)
            question["reviewLabel"] = REVIEW_LABELS[question["reviewStatus"]]
            question["reviewRequired"] = True
    questions.extend(_extract_long_response_tasks(lines, source_kind))
    return questions, _structure_markers(lines)


def _text_quality(text: str) -> float:
    if not text:
        return 0.0
    replacement = text.count("\ufffd")
    controls = sum(1 for character in text if unicodedata.category(character) == "Cc" and character not in "\n\t")
    printable = sum(1 for character in text if character.isprintable() or character in "\n\t")
    return max(0.0, min(1.0, printable / len(text) - (replacement + controls) / max(1, len(text)) * 4))


def _answer_lines(pages: list[dict[str, object]]) -> list[tuple[int, str, str]]:
    """Return reading order that respects two-column answer-booklet bands."""

    all_lines = _page_lines(pages)
    ordered: list[tuple[int, str, str]] = []
    for page in pages:
        page_number = int(page["number"])
        page_width = float(page["width"])
        page_lines = [line for line in all_lines if int(line["page"]) == page_number]
        full_width: list[dict[str, object]] = []
        column_lines: list[dict[str, object]] = []
        for line in page_lines:
            box = line["bbox"]
            left = float(box["x"])
            right = left + float(box["width"])
            structural = re.match(r"^\s*(?:part|section|questions?\s+[1-9])\b", str(line["text"]), re.I)
            is_full = bool(structural) or float(box["width"]) >= page_width * 0.67 or (
                left <= page_width * 0.12 and right >= page_width * 0.62
            )
            (full_width if is_full else column_lines).append(line)
        full_width.sort(key=lambda item: (float(item["bbox"]["y"]), float(item["bbox"]["x"])))
        lower = float("-inf")

        def emit_band(upper: float) -> None:
            band = [
                line
                for line in column_lines
                if lower < float(line["bbox"]["y"]) < upper
            ]
            left_column = [line for line in band if float(line["bbox"]["x"]) < page_width * 0.48]
            right_column = [line for line in band if float(line["bbox"]["x"]) >= page_width * 0.48]
            for line in sorted(left_column, key=lambda item: (float(item["bbox"]["y"]), float(item["bbox"]["x"]))) + sorted(
                right_column, key=lambda item: (float(item["bbox"]["y"]), float(item["bbox"]["x"]))
            ):
                text = str(line["text"]).strip()
                if text:
                    ordered.append((page_number, text, str(line.get("extractionSource") or "pdf_text")))

        for separator in full_width:
            y = float(separator["bbox"]["y"])
            emit_band(y)
            text = str(separator["text"]).strip()
            if text:
                ordered.append((page_number, text, str(separator.get("extractionSource") or "pdf_text")))
            lower = y
        emit_band(float("inf"))
    return ordered


def _extract_answers(
    pages: list[dict[str, object]],
    source_kind: str,
    questions: list[dict[str, object]],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    lines = _answer_lines(pages)
    candidates: dict[int, list[dict[str, object]]] = {}
    rejected_markers: list[dict[str, object]] = []
    question_ids = {str(item.get("questionId")) for item in questions}
    question_options = {
        str(item.get("questionId")): {
            str(option.get("label"))
            for option in item.get("options", [])
            if isinstance(option, dict) and option.get("label")
        }
        for item in questions
    }

    def add(
        number: int,
        answer: str,
        page: int,
        explanation: str,
        confidence: float,
        pattern: str,
        extraction_source: str,
    ) -> None:
        question_id = f"q{number}"
        if question_ids and question_id not in question_ids:
            return
        if not (1 <= number <= 200 and answer in "ABCDEFGHIJKLMNO"):
            return
        quality = _text_quality(explanation)
        clean_explanation = explanation.strip()[:12_000] if quality >= 0.72 and len(explanation.strip()) >= 8 else ""
        adjusted = confidence - (0.10 if extraction_source != "pdf_text" else 0.0)
        parsed_options = question_options.get(question_id, set())
        if parsed_options and answer not in parsed_options:
            rejected_markers.append(
                {
                    "questionId": question_id,
                    "reason": "答案字母不在已识别的题目选项中，系统未将其用于批改",
                    "value": answer,
                }
            )
            return
        if answer > "D":
            adjusted = min(adjusted, 0.93)
        if explanation and not clean_explanation:
            adjusted -= 0.08
        candidates.setdefault(number, []).append(
            {
                "questionId": question_id,
                "answer": answer,
                "explanation": clean_explanation,
                "page": page,
                "confidence": round(max(0.50, adjusted), 3),
                "source": "answer_pdf",
                "matchPattern": pattern,
            }
        )

    for page, text, extraction_source in lines:
        range_match = ANSWER_RANGE.search(text)
        if range_match and range_match.start() <= 4:
            first, last = int(range_match.group(1)), int(range_match.group(2))
            letters = re.findall(r"[A-O]", range_match.group(3).upper())
            if last >= first and len(letters) == last - first + 1:
                for offset, letter in enumerate(letters):
                    add(first + offset, letter, page, "", 0.95, "explicit_range", extraction_source)
        for match in INDIVIDUAL_ANSWER.finditer(text):
            if text[: match.start()].strip():
                continue
            number = int(match.group(1))
            answer = match.group(2).upper()
            explanation = text[match.end() :].lstrip(" ,，。;；:：-")
            add(number, answer, page, explanation, 0.98, "explicit_individual", extraction_source)

    # After coordinate-aware column ordering, accept a single explicit option
    # label within five lines of its numbered question.  If another question or
    # a section boundary appears first, no association is made.  This is less
    # complete than positional guessing but prevents shifted "official" keys.
    boundary = re.compile(r"^\s*(?:part|section|questions?\s+[1-9])\b", re.I)
    for index, (page, text, extraction_source) in enumerate(lines):
        question_match = QUESTION_START.match(text)
        if not question_match:
            continue
        number = int(question_match.group(1))
        found: list[tuple[str, int, str, str]] = []
        for following_page, following_text, following_source in lines[index + 1 : index + 9]:
            if QUESTION_START.match(following_text) or boundary.search(following_text):
                break
            option_match = re.match(r"^\s*([A-O])\s*[)）.、]\s*(.*)$", following_text, re.I)
            if option_match:
                found.append((option_match.group(1).upper(), following_page, option_match.group(2).strip(), following_source))
                continue
            trailing_match = re.search(r"\b([A-O])\s*[)）]\s*(?:[oO。.]\s*)?$", following_text, re.I)
            if trailing_match:
                found.append((trailing_match.group(1).upper(), following_page, following_text.strip(), following_source))
        labels = {item[0] for item in found}
        if len(labels) == 1:
            label, answer_page, explanation, answer_source = found[0]
            add(number, label, answer_page, explanation, 0.93, "numbered_explanation_option", answer_source)

    answers: list[dict[str, object]] = []
    conflicts: list[dict[str, object]] = list(rejected_markers)
    for number, matches in sorted(candidates.items()):
        letters = {str(item["answer"]) for item in matches}
        if len(letters) != 1:
            conflicts.append(
                {
                    "questionId": f"q{number}",
                    "reason": "答案资料中出现互相冲突的明确答案，系统未选择其中任何一个",
                    "values": sorted(letters),
                }
            )
            continue
        best = max(matches, key=lambda item: (bool(item["explanation"]), float(item["confidence"])))
        confidence = float(best["confidence"])
        status = _review_status(confidence)
        best.update(
            {
                "reviewStatus": status,
                "reviewLabel": REVIEW_LABELS[status],
                "reviewRequired": confidence < 0.95,
            }
        )
        answers.append(best)
    return answers, conflicts


def _tokenize(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", text).lower()
    tokens = re.findall(r"[a-z0-9']+|[\u4e00-\u9fff]", normalized)
    chinese = [token for token in tokens if "\u4e00" <= token <= "\u9fff"]
    tokens.extend(first + second for first, second in zip(chinese, chinese[1:]))
    return tokens[:20_000]


def _embedding(text: str, dimensions: int = 192) -> list[float]:
    vector = [0.0] * dimensions
    for token in _tokenize(text):
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=16).digest()
        index = int.from_bytes(digest[:4], "big") % dimensions
        sign = -1.0 if digest[4] & 1 else 1.0
        vector[index] += sign * (1.0 + min(len(token), 12) / 24.0)
    norm = math.sqrt(sum(value * value for value in vector))
    return [round(value / norm, 7) for value in vector] if norm else vector


def _cosine(left: list[float], right: list[float]) -> float:
    return sum(a * b for a, b in zip(left, right))


def _chunk_answer_pages(pages: list[dict[str, object]]) -> list[dict[str, str]]:
    chunks: list[dict[str, str]] = []
    for page, text, _extraction_source in _answer_lines(pages):
        if not text or _text_quality(text) < 0.70:
            continue
        match = re.search(r"(?:第\s*)?([1-9][0-9]{0,2})\s*(?:题|[.、)])", text, re.I)
        question_id = f"q{int(match.group(1))}" if match else ""
        chunks.append({"questionId": question_id, "kind": "answer_text", "content": f"答案资料第{page}页：{text}"[:1600]})
    return chunks


def _build_index(path: Path, answers: list[dict[str, object]], answer_pages: list[dict[str, object]]) -> None:
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    connection = sqlite3.connect(str(temporary))
    try:
        connection.execute(
            "CREATE TABLE chunks (id INTEGER PRIMARY KEY, question_id TEXT NOT NULL, kind TEXT NOT NULL, "
            "content TEXT NOT NULL, embedding TEXT NOT NULL)"
        )
        connection.execute("CREATE INDEX chunks_question_id ON chunks(question_id)")
        chunks: list[dict[str, str]] = []
        for answer in answers:
            content = f"{answer['questionId']} 正确答案：{answer['answer']}。"
            if answer.get("explanation"):
                content += f" 官方解析：{answer['explanation']}"
            chunks.append({"questionId": str(answer["questionId"]), "kind": "official_answer", "content": content})
        chunks.extend(_chunk_answer_pages(answer_pages))
        for chunk in chunks[:10_000]:
            connection.execute(
                "INSERT INTO chunks(question_id, kind, content, embedding) VALUES (?, ?, ?, ?)",
                (
                    chunk["questionId"],
                    chunk["kind"],
                    chunk["content"],
                    json.dumps(_embedding(chunk["content"]), separators=(",", ":")),
                ),
            )
        connection.commit()
    finally:
        connection.close()
    os.replace(str(temporary), str(path))


class PlatformService:
    """Own runtime exam directories and bounded background parsing jobs."""

    def __init__(self) -> None:
        EXAMS_DIR.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="exam-parser")
        self._recover_interrupted_jobs()

    def _recover_interrupted_jobs(self) -> None:
        for status_path in EXAMS_DIR.glob("exam-*/status.json"):
            document = _read_json(status_path, {})
            if not isinstance(document, dict) or document.get("status") not in {"queued", "processing"}:
                continue
            document.update(
                {
                    "status": "failed",
                    "stage": "failed",
                    "message": "服务重启中断了解析任务，请重新上传试卷",
                    "error": "解析任务因服务器重启而中断",
                    "updatedAt": _now(),
                }
            )
            _atomic_json(status_path, document)

    def _status_path(self, exam_id: str) -> Path:
        return _safe_exam_directory(exam_id) / "status.json"

    def _current_review_snapshot(self, exam_id: str) -> tuple[Path, int, dict[str, object]]:
        directory = _safe_exam_directory(exam_id)
        pointer_path = directory / "review" / "current.json"
        if not pointer_path.exists():
            return directory, 0, {}
        if not pointer_path.is_file():
            raise PlatformError("review snapshot metadata is invalid", HTTPStatus.INTERNAL_SERVER_ERROR)
        pointer = _read_json(pointer_path)
        if not isinstance(pointer, dict):
            raise PlatformError("review snapshot metadata is invalid", HTTPStatus.INTERNAL_SERVER_ERROR)
        revision = pointer.get("revision")
        revision_directory = str(pointer.get("directory") or "")
        if (
            isinstance(revision, bool)
            or not isinstance(revision, int)
            or not 1 <= revision <= 999_999
            or revision_directory != f"{revision:06d}"
            or not SAFE_REVIEW_REVISION_DIRECTORY.fullmatch(revision_directory)
        ):
            raise PlatformError("review snapshot metadata is invalid", HTTPStatus.INTERNAL_SERVER_ERROR)
        revisions = (directory / "review" / "revisions").resolve()
        snapshot = (revisions / revision_directory).resolve()
        if snapshot.parent != revisions or not snapshot.is_dir():
            raise PlatformError("review snapshot is missing", HTTPStatus.INTERNAL_SERVER_ERROR)
        if not (snapshot / "questions.json").is_file() or not (snapshot / "answers.json").is_file():
            raise PlatformError("review snapshot documents are incomplete", HTTPStatus.INTERNAL_SERVER_ERROR)
        if pointer.get("schemaVersion") != "cet-review-pointer/1":
            raise PlatformError("review snapshot metadata is invalid", HTTPStatus.INTERNAL_SERVER_ERROR)
        questions = _read_json(snapshot / "questions.json")
        answers = _read_json(snapshot / "answers.json")
        expected_questions_hash = str(pointer.get("questionsSha256") or "")
        expected_answers_hash = str(pointer.get("answersSha256") or "")
        if (
            not isinstance(questions, dict)
            or not isinstance(answers, dict)
            or not re.fullmatch(r"[0-9a-f]{64}", expected_questions_hash)
            or not re.fullmatch(r"[0-9a-f]{64}", expected_answers_hash)
            or _review_document_digest(questions) != expected_questions_hash
            or _review_document_digest(answers) != expected_answers_hash
        ):
            raise PlatformError("review snapshot integrity check failed", HTTPStatus.INTERNAL_SERVER_ERROR)
        return snapshot, revision, pointer

    @staticmethod
    def _snapshot_documents(snapshot: Path) -> tuple[dict[str, object], dict[str, object]]:
        questions = _read_json(snapshot / "questions.json")
        answers = _read_json(snapshot / "answers.json")
        if not isinstance(questions, dict) or not isinstance(answers, dict):
            raise PlatformError("exam review documents are unavailable", HTTPStatus.CONFLICT)
        return questions, answers

    def _set_status(
        self,
        exam_id: str,
        *,
        status: str,
        stage: str,
        progress: int,
        message: str,
        error: str | None = None,
        result: dict[str, object] | None = None,
    ) -> dict[str, object]:
        with self._lock:
            path = self._status_path(exam_id)
            current = _read_json(path, {})
            if not isinstance(current, dict):
                current = {}
            created_at = str(current.get("createdAt") or _now())
            document: dict[str, object] = {
                "examId": exam_id,
                "status": status,
                "stage": stage,
                "progress": max(0, min(100, int(progress))),
                "message": message,
                "error": error,
                "result": result,
                "createdAt": created_at,
                "updatedAt": _now(),
            }
            _atomic_json(path, document)
            return document

    def status(self, exam_id: str) -> dict[str, object]:
        path = self._status_path(exam_id)
        document = _read_json(path)
        if not isinstance(document, dict):
            raise PlatformError("exam not found", HTTPStatus.NOT_FOUND)
        return document

    def list_exams(self) -> dict[str, object]:
        exams: list[dict[str, object]] = []
        for directory in EXAMS_DIR.glob("exam-*"):
            if not directory.is_dir() or not SAFE_EXAM_ID.fullmatch(directory.name):
                continue
            status = _read_json(directory / "status.json", {})
            metadata = _read_json(directory / "metadata.json", {})
            if not isinstance(status, dict) or not isinstance(metadata, dict):
                continue
            exams.append(
                {
                    "examId": directory.name,
                    "title": str(metadata.get("title") or "未命名英语试卷"),
                    "status": status.get("status"),
                    "stage": status.get("stage"),
                    "progress": status.get("progress", 0),
                    "message": status.get("message", ""),
                    "error": status.get("error"),
                    "createdAt": status.get("createdAt"),
                    "updatedAt": status.get("updatedAt"),
                    "hasAnswer": bool(metadata.get("answer")),
                    "hasAudio": bool(metadata.get("audio")),
                    "result": status.get("result"),
                }
            )
        exams.sort(key=lambda item: str(item.get("createdAt") or ""), reverse=True)
        return {"exams": exams}

    def capabilities(self) -> dict[str, object]:
        """Report installed document tools without exposing paths or secrets."""

        commands = {
            "pdftotext": bool(shutil.which("pdftotext")),
            "pdftoppm": bool(shutil.which("pdftoppm")),
            "ocrmypdf": bool(shutil.which("ocrmypdf")),
            "tesseract": bool(shutil.which("tesseract")),
        }
        paddle: dict[str, object] = {
            "configured": False,
            "reachable": False,
            "ready": False,
            "modelLoaded": False,
            "language": None,
            "message": "未配置 PaddleOCR sidecar",
        }
        try:
            client = PaddleOCRClient.from_environment()
            paddle["configured"] = client.configured
            if client.configured:
                health = client.health(timeout_seconds=1.5)
                paddle.update(
                    {
                        "reachable": True,
                        "ready": bool(health.get("ready")),
                        "modelLoaded": bool(health.get("modelLoaded")),
                        "language": str(health.get("requestedLanguage") or _paddle_language()),
                        "languageReady": bool(health.get("languageReady")),
                        "allowedRootReady": bool(health.get("allowedRootReady")),
                        "runtimeImportReady": bool(health.get("runtimeImportReady")),
                        "message": (
                            "PaddleOCR sidecar 可用"
                            if health.get("ready")
                            else "PaddleOCR 可连接，但运行环境、共享目录或语言尚未就绪"
                        ),
                    }
                )
        except PaddleOCRError:
            if paddle["configured"]:
                paddle["message"] = "PaddleOCR 已配置但当前不可连接"
            else:
                paddle["message"] = "PaddleOCR 配置无效"
        native_pdf = commands["pdftotext"] and commands["pdftoppm"]
        tesseract_ready = commands["tesseract"] and commands["pdftoppm"]
        scanned_pdf = bool(native_pdf and (paddle["ready"] or commands["ocrmypdf"] or tesseract_ready))
        return {
            "schemaVersion": 1,
            "pdf": {
                "nativeText": native_pdf,
                "pageRendering": commands["pdftoppm"],
                "scanned": scanned_pdf,
            },
            "ocr": {
                "preferred": "paddleocr" if paddle["ready"] else (
                    "ocrmypdf" if commands["ocrmypdf"] else ("tesseract" if tesseract_ready else None)
                ),
                "paddleocr": paddle,
                "ocrmypdf": commands["ocrmypdf"],
                "tesseract": tesseract_ready,
                "tesseractLanguages": _ocr_languages() if commands["tesseract"] else None,
            },
        }

    def review(self, exam_id: str) -> dict[str, object]:
        with self._lock:
            status = self.status(exam_id)
            if status.get("status") != "ready":
                raise PlatformError("exam review is available only after parsing is ready", HTTPStatus.CONFLICT)
            snapshot, revision, pointer = self._current_review_snapshot(exam_id)
            questions_document, answers_document = self._snapshot_documents(snapshot)
            questions = questions_document.get("questions", [])
            answers = answers_document.get("answers", [])
            if not isinstance(questions, list) or not isinstance(answers, list):
                raise PlatformError("exam review documents are invalid", HTTPStatus.INTERNAL_SERVER_ERROR)
            issues = _review_issues(questions_document, answers_document)
            return {
                "schemaVersion": "cet-review/1",
                "examId": exam_id,
                "revision": revision,
                "etag": _review_etag(revision),
                "state": "needs_review" if issues else "reviewed",
                "updatedAt": str(pointer.get("updatedAt") or status.get("updatedAt") or _now()),
                "questions": questions,
                "answers": answers,
                "issues": issues,
                "reviewSummary": {
                    "questions": questions_document.get("reviewSummary", _review_summary(questions)),
                    "answers": answers_document.get("reviewSummary", _review_summary(answers)),
                    "openIssues": len(issues),
                },
                "answerOfficialSource": bool(answers_document.get("officialSource")),
            }

    def apply_review_patch(
        self,
        exam_id: str,
        payload: dict[str, object],
        expected_revision: int,
        actor: str = "local-reviewer",
    ) -> dict[str, object]:
        with self._lock:
            actor = _review_text(str(actor), "actor", 160, required=True)
            status = self.status(exam_id)
            if status.get("status") != "ready":
                raise PlatformError("only ready exams may be reviewed", HTTPStatus.CONFLICT)
            snapshot, current_revision, _ = self._current_review_snapshot(exam_id)
            if current_revision != expected_revision:
                raise PlatformError(
                    f"review revision changed; current revision is {current_revision}",
                    HTTPStatus.CONFLICT,
                )
            if set(payload) != {"schemaVersion", "baseRevision", "reason", "operations"}:
                raise PlatformError("review patch must contain only schemaVersion, baseRevision, reason, and operations")
            if payload.get("schemaVersion") != "cet-review/1":
                raise PlatformError("unsupported review schemaVersion")
            base_revision = payload.get("baseRevision")
            if isinstance(base_revision, bool) or not isinstance(base_revision, int):
                raise PlatformError("baseRevision must be an integer")
            if base_revision != current_revision:
                raise PlatformError(
                    f"review revision changed; current revision is {current_revision}",
                    HTTPStatus.CONFLICT,
                )
            reason = _review_text(payload.get("reason"), "reason", MAX_REVIEW_REASON_CHARS, required=True)
            operations = payload.get("operations")
            if not isinstance(operations, list) or not operations or len(operations) > MAX_REVIEW_OPERATIONS:
                raise PlatformError(f"operations must contain 1 to {MAX_REVIEW_OPERATIONS} items")
            exam_directory = _safe_exam_directory(exam_id)
            review_root = exam_directory / "review"
            revisions = review_root / "revisions"
            next_revision = current_revision + 1
            # A crash can leave a fully written snapshot that was never made
            # current.  Preserve that forensic data and advance to the next
            # free immutable directory instead of permanently blocking edits.
            while next_revision <= 999_999 and (revisions / f"{next_revision:06d}").exists():
                next_revision += 1
            if next_revision > 999_999:
                raise PlatformError("review revision limit reached", HTTPStatus.CONFLICT)

            questions_document, answers_document = self._snapshot_documents(snapshot)
            # JSON round-tripping provides a bounded, plain-data clone and keeps
            # a failed validation from mutating the currently published version.
            questions_document = json.loads(json.dumps(questions_document, ensure_ascii=False))
            answers_document = json.loads(json.dumps(answers_document, ensure_ascii=False))
            question_items = questions_document.get("questions", [])
            answer_items = answers_document.get("answers", [])
            if not isinstance(question_items, list) or not isinstance(answer_items, list):
                raise PlatformError("exam review documents are invalid", HTTPStatus.INTERNAL_SERVER_ERROR)
            questions_by_id = {
                str(item.get("questionId")): item
                for item in question_items
                if isinstance(item, dict) and item.get("questionId")
            }
            answers_by_id = {
                str(item.get("questionId")): item
                for item in answer_items
                if isinstance(item, dict) and item.get("questionId")
            }
            if len(questions_by_id) != len(question_items) or len(answers_by_id) != len(answer_items):
                raise PlatformError("exam review documents contain invalid or duplicate ids", HTTPStatus.INTERNAL_SERVER_ERROR)
            manifest = _read_json(_safe_exam_directory(exam_id) / "manifest.json")
            if not isinstance(manifest, dict) or not _review_page_dimensions(manifest):
                raise PlatformError("paper manifest is unavailable", HTTPStatus.CONFLICT)

            question_operations: list[tuple[str, dict[str, object]]] = []
            answer_operations: list[tuple[str, dict[str, object]]] = []
            question_targets: set[str] = set()
            answer_targets: set[str] = set()
            pending_answer_removals: set[str] = set()
            for index, raw_operation in enumerate(operations):
                if not isinstance(raw_operation, dict):
                    raise PlatformError(f"operations[{index}] must be an object")
                operation = raw_operation.get("op")
                if operation == "upsertQuestion":
                    if set(raw_operation) != {"op", "question"} or not isinstance(raw_operation.get("question"), dict):
                        raise PlatformError(f"operations[{index}] upsertQuestion must contain only op and question")
                    target = str(raw_operation["question"].get("questionId") or "")
                    bucket = question_operations
                elif operation == "removeQuestion":
                    if set(raw_operation) - {"op", "questionId", "cascadeAnswer"} or "questionId" not in raw_operation:
                        raise PlatformError(f"operations[{index}] removeQuestion fields are invalid")
                    if "cascadeAnswer" in raw_operation and not isinstance(raw_operation["cascadeAnswer"], bool):
                        raise PlatformError(f"operations[{index}].cascadeAnswer must be boolean")
                    target = str(raw_operation.get("questionId") or "")
                    bucket = question_operations
                elif operation == "upsertAnswer":
                    if set(raw_operation) != {"op", "answer"} or not isinstance(raw_operation.get("answer"), dict):
                        raise PlatformError(f"operations[{index}] upsertAnswer must contain only op and answer")
                    target = str(raw_operation["answer"].get("questionId") or "")
                    bucket = answer_operations
                elif operation == "removeAnswer":
                    if set(raw_operation) != {"op", "questionId"}:
                        raise PlatformError(f"operations[{index}] removeAnswer must contain only op and questionId")
                    target = str(raw_operation.get("questionId") or "")
                    bucket = answer_operations
                    pending_answer_removals.add(target)
                else:
                    raise PlatformError(f"operations[{index}].op is unsupported")
                if not SAFE_QUESTION_ID.fullmatch(target):
                    raise PlatformError(f"operations[{index}] contains an invalid questionId")
                targets = question_targets if bucket is question_operations else answer_targets
                if target in targets:
                    raise PlatformError(f"operations contains more than one change for {target}")
                targets.add(target)
                bucket.append((str(operation), raw_operation))

            reviewed_at = _now()
            cascaded_answers: set[str] = set()
            removed_questions: set[str] = set()
            for operation, raw_operation in question_operations:
                if operation == "upsertQuestion":
                    raw_question = raw_operation["question"]
                    target = str(raw_question["questionId"])
                    questions_by_id[target] = _normalize_review_question(
                        raw_question,
                        manifest,
                        questions_by_id.get(target),
                        next_revision,
                        actor,
                        reviewed_at,
                    )
                    continue
                target = str(raw_operation["questionId"])
                if target not in questions_by_id:
                    raise PlatformError(f"cannot remove unknown question {target}")
                removed_questions.add(target)
                if target in answers_by_id and target not in pending_answer_removals:
                    if raw_operation.get("cascadeAnswer") is not True:
                        raise PlatformError(
                            f"question {target} has an answer; remove it explicitly or set cascadeAnswer",
                            HTTPStatus.CONFLICT,
                        )
                    cascaded_answers.add(target)
                del questions_by_id[target]
            if not questions_by_id:
                raise PlatformError("a reviewed paper must retain at least one question")

            touched_answers = set(cascaded_answers)
            for target in cascaded_answers:
                answers_by_id.pop(target, None)
            for operation, raw_operation in answer_operations:
                if operation == "upsertAnswer":
                    raw_answer = raw_operation["answer"]
                    target = str(raw_answer["questionId"])
                    answers_by_id[target] = _normalize_review_answer(
                        raw_answer,
                        questions_by_id,
                        answers_by_id.get(target),
                        next_revision,
                        actor,
                        reviewed_at,
                    )
                else:
                    target = str(raw_operation["questionId"])
                    if target not in answers_by_id:
                        raise PlatformError(f"cannot remove unknown answer {target}")
                    del answers_by_id[target]
                touched_answers.add(target)

            # Existing parser answers must remain compatible with the final
            # question set.  A question option edit cannot silently invalidate
            # a previously published grading key.
            for question_id, answer in answers_by_id.items():
                question = questions_by_id.get(question_id)
                if not question:
                    raise PlatformError(f"answer {question_id} has no corresponding question")
                if str(question.get("type") or "") not in {"single_choice", "matching"}:
                    raise PlatformError(
                        f"answer {question_id} belongs to a non-objective question; remove it in the same patch"
                    )
                labels = {
                    str(option.get("label") or "").upper()
                    for option in question.get("options", [])
                    if isinstance(option, dict)
                }
                if str(answer.get("answer") or "").upper() not in labels:
                    raise PlatformError(
                        f"answer {question_id} no longer matches its options; update or remove the answer in the same patch"
                    )

            def question_sort(item: dict[str, object]) -> tuple[int, int, str]:
                match = re.fullmatch(r"q([1-9][0-9]{0,2})", str(item.get("questionId") or ""))
                return (0, int(match.group(1)), "") if match else (1, 0, str(item.get("questionId") or ""))

            next_questions = sorted(questions_by_id.values(), key=question_sort)
            next_answers = sorted(
                answers_by_id.values(),
                key=lambda item: question_sort({"questionId": item.get("questionId")}),
            )
            questions_document.update(
                {
                    "schemaVersion": 1,
                    "revision": next_revision,
                    "updatedAt": reviewed_at,
                    "questions": next_questions,
                    "unresolved": _unresolved_question_gaps(next_questions),
                    "reviewSummary": _review_summary(next_questions),
                }
            )
            questions_document["reviewSummary"]["unresolved"] = len(questions_document["unresolved"])
            resolved_conflicts = touched_answers | removed_questions
            conflicts = [
                conflict
                for conflict in answers_document.get("conflicts", [])
                if isinstance(conflict, dict) and str(conflict.get("questionId") or "") not in resolved_conflicts
            ]
            answers_document.update(
                {
                    "schemaVersion": 1,
                    "revision": next_revision,
                    "updatedAt": reviewed_at,
                    "answers": next_answers,
                    "conflicts": conflicts,
                    "reviewSummary": _review_summary(next_answers),
                }
            )

            before_hashes = {
                "questions": _review_document_digest(self._snapshot_documents(snapshot)[0]),
                "answers": _review_document_digest(self._snapshot_documents(snapshot)[1]),
            }
            after_hashes = {
                "questions": _review_document_digest(questions_document),
                "answers": _review_document_digest(answers_document),
            }
            audit_operations = []
            for operation, raw_operation in [*question_operations, *answer_operations]:
                item = raw_operation.get("question") or raw_operation.get("answer") or raw_operation
                audit_operations.append({"op": operation, "questionId": str(item.get("questionId") or "")})
            audit = {
                "schemaVersion": "cet-review-audit/1",
                "examId": exam_id,
                "revision": next_revision,
                "baseRevision": current_revision,
                "actor": actor,
                "createdAt": reviewed_at,
                "reason": reason,
                "operations": audit_operations,
                "beforeSha256": before_hashes,
                "afterSha256": after_hashes,
            }

            revisions.mkdir(parents=True, exist_ok=True)
            final_snapshot = revisions / f"{next_revision:06d}"
            if final_snapshot.exists():
                raise PlatformError("review revision already exists", HTTPStatus.CONFLICT)
            temporary = revisions / f".pending-{uuid.uuid4().hex}"
            temporary.mkdir(parents=False, exist_ok=False)
            installed_snapshot = False
            committed_pointer = False
            try:
                _atomic_json(temporary / "questions.json", questions_document)
                _atomic_json(temporary / "answers.json", answers_document)
                _refresh_rag_answers(
                    snapshot / "rag.sqlite3",
                    temporary / "rag.sqlite3",
                    next_answers,
                    touched_answers | removed_questions,
                )
                _atomic_json(temporary / "audit.json", audit)
                os.replace(str(temporary), str(final_snapshot))
                installed_snapshot = True
                pointer = {
                    "schemaVersion": "cet-review-pointer/1",
                    "revision": next_revision,
                    "directory": f"{next_revision:06d}",
                    "updatedAt": reviewed_at,
                    "questionsSha256": after_hashes["questions"],
                    "answersSha256": after_hashes["answers"],
                }
                _atomic_json(review_root / "current.json", pointer)
                committed_pointer = True
            finally:
                if temporary.exists():
                    shutil.rmtree(str(temporary), ignore_errors=True)
                if installed_snapshot and not committed_pointer and final_snapshot.exists():
                    shutil.rmtree(str(final_snapshot), ignore_errors=True)

            # Keep the upload dashboard in sync with the published snapshot.
            # The immutable snapshot and current pointer remain the source of
            # truth; a status refresh failure must not make a committed review
            # appear to have failed and invite a duplicate retry.
            try:
                status_document = dict(status)
                status_result = status_document.get("result")
                status_result = dict(status_result) if isinstance(status_result, dict) else {}
                status_result["reviewCounts"] = {
                    "questions": questions_document["reviewSummary"],
                    "answers": answers_document["reviewSummary"],
                    "answerConflicts": len(conflicts),
                }
                status_result["reviewRevision"] = next_revision
                status_document["result"] = status_result
                status_document["updatedAt"] = reviewed_at
                _atomic_json(self._status_path(exam_id), status_document)
            except OSError:
                pass

            response = self.review(exam_id)
            response["documents"] = {
                "questionsUrl": f"/api/exams/{exam_id}/questions",
                "answersUrl": f"/api/exams/{exam_id}/answers",
            }
            return response

    def create_from_multipart(self, handler) -> dict[str, object]:
        content_type = handler.headers.get("Content-Type", "")
        if content_type.split(";", 1)[0].strip().lower() != "multipart/form-data" or "boundary=" not in content_type:
            raise PlatformError("Content-Type must be multipart/form-data")
        raw_length = handler.headers.get("Content-Length")
        if raw_length is None:
            raise PlatformError("Content-Length is required", HTTPStatus.LENGTH_REQUIRED)
        try:
            content_length = int(raw_length)
        except ValueError:
            raise PlatformError("invalid Content-Length")
        if content_length <= 0:
            raise PlatformError("upload body must not be empty")
        if content_length > MAX_UPLOAD_BYTES:
            raise PlatformError("upload body is too large", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)

        try:
            form = cgi.FieldStorage(
                fp=handler.rfile,
                headers=handler.headers,
                environ={
                    "REQUEST_METHOD": "POST",
                    "CONTENT_TYPE": content_type,
                    "CONTENT_LENGTH": str(content_length),
                },
                keep_blank_values=True,
                limit=MAX_UPLOAD_BYTES,
            )
        except (OSError, ValueError) as error:
            raise PlatformError(f"invalid multipart upload: {error}")

        paper_field = _field(form, "exam_pdf", required=True)
        answer_field = _field(form, "answer_pdf")
        audio_field = _field(form, "audio")
        title_field = _field(form, "title")
        if answer_field is not None and not getattr(answer_field, "filename", None):
            answer_field = None
        if audio_field is not None and not getattr(audio_field, "filename", None):
            audio_field = None

        paper_size, paper_name = _validate_pdf_field(paper_field, "试卷 PDF")
        answer_info = _validate_pdf_field(answer_field, "答案 PDF") if answer_field is not None else None
        audio_info = _validate_audio_field(audio_field) if audio_field is not None else None
        raw_title = str(getattr(title_field, "value", "") or "") if title_field is not None else ""
        title = _clean_title(raw_title, paper_name)

        exam_id = f"exam-{datetime.now().strftime('%Y%m%d')}-{uuid.uuid4().hex[:12]}"
        final_directory = _safe_exam_directory(exam_id)
        temporary = EXAMS_DIR / f".upload-{uuid.uuid4().hex}"
        inputs = temporary / "input"
        inputs.mkdir(parents=True, exist_ok=False)
        try:
            paper_hash = _copy_uploaded_file(paper_field.file, inputs / "paper.pdf", MAX_PDF_BYTES)
            answer_metadata = None
            if answer_field is not None and answer_info is not None:
                answer_hash = _copy_uploaded_file(answer_field.file, inputs / "answer.pdf", MAX_PDF_BYTES)
                answer_metadata = {
                    "originalName": answer_info[1],
                    "size": answer_info[0],
                    "sha256": answer_hash,
                }
            audio_metadata = None
            if audio_field is not None and audio_info is not None:
                extension = Path(audio_info[1]).suffix.lower()
                stored_name = f"listening{extension}"
                audio_hash = _copy_uploaded_file(audio_field.file, inputs / stored_name, MAX_AUDIO_BYTES)
                audio_metadata = {
                    "originalName": audio_info[1],
                    "storedName": stored_name,
                    "size": audio_info[0],
                    "contentType": audio_info[2],
                    "sha256": audio_hash,
                }
            metadata: dict[str, object] = {
                "examId": exam_id,
                "title": title,
                "createdAt": _now(),
                "paper": {"originalName": paper_name, "size": paper_size, "sha256": paper_hash},
                "answer": answer_metadata,
                "audio": audio_metadata,
            }
            _atomic_json(temporary / "metadata.json", metadata)
            queued = {
                "examId": exam_id,
                "status": "queued",
                "stage": "queued",
                "progress": 0,
                "message": "文件已安全保存，等待解析",
                "error": None,
                "result": None,
                "createdAt": _now(),
                "updatedAt": _now(),
            }
            _atomic_json(temporary / "status.json", queued)
            os.replace(str(temporary), str(final_directory))
        finally:
            if temporary.exists():
                shutil.rmtree(str(temporary), ignore_errors=True)

        self._executor.submit(self._process_exam, exam_id)
        return {"examId": exam_id, "status": "queued", "statusUrl": f"/api/exams/{exam_id}/status"}

    def _process_exam(self, exam_id: str) -> None:
        directory = _safe_exam_directory(exam_id)
        metadata = _read_json(directory / "metadata.json", {})
        if not isinstance(metadata, dict):
            self._set_status(exam_id, status="failed", stage="failed", progress=0, message="元数据损坏", error="metadata.json is invalid")
            return
        try:
            self._set_status(exam_id, status="processing", stage="validating", progress=3, message="正在校验上传文件")
            paper = directory / "input" / "paper.pdf"
            try:
                with paper.open("rb") as paper_stream:
                    paper_signature = paper_stream.read(5)
            except OSError:
                paper_signature = b""
            if not paper.is_file() or not paper_signature.startswith(b"%PDF-"):
                raise PlatformError("试卷 PDF 在保存后校验失败", HTTPStatus.UNPROCESSABLE_ENTITY)
            assets = directory / "assets"
            assets.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix="exam-work-", dir=str(directory)) as temporary_name:
                work = Path(temporary_name)
                self._set_status(exam_id, status="processing", stage="extracting_text", progress=10, message="正在检测并提取试卷文字层")

                def paper_ocr_status() -> None:
                    self._set_status(exam_id, status="processing", stage="ocr", progress=18, message="试卷没有可用文字层，正在执行 OCR")

                paper_pages, paper_source = _extract_document(paper, work, "paper", paper_ocr_status)
                self._set_status(exam_id, status="processing", stage="rendering", progress=38, message=f"已识别 {len(paper_pages)} 页，正在生成原卷页面图片")
                _render_page_images(paper, paper_pages, assets / "pages")

                manifest_pages: list[dict[str, object]] = []
                for page in paper_pages:
                    number = int(page["number"])
                    manifest_pages.append(
                        {
                            "number": number,
                            "width": page["width"],
                            "height": page["height"],
                            "image": f"/api/exams/{exam_id}/assets/pages/page-{number}.jpg",
                            "textSource": str(page.get("extractionSource") or "pdf_text"),
                            "words": page.get("words", []),
                        }
                    )
                unresolved_text_pages = [
                    int(page["number"])
                    for page in paper_pages
                    if _meaningful_word_count([page]) < 3
                ]
                ocr_languages = (
                    _paddle_language()
                    if "paddleocr" in paper_source
                    else (_ocr_languages() if paper_source != "pdf_text" else None)
                )
                if unresolved_text_pages:
                    listed_pages = "、".join(str(number) for number in unresolved_text_pages[:12])
                    ocr_notice = f"第 {listed_pages} 页没有识别到足够文字；可能是空白页，也可能需要人工复核或更清晰的扫描件"
                elif (
                    ("paddleocr" in paper_source and ocr_languages != "ch")
                    or ("paddleocr" not in paper_source and paper_source != "pdf_text" and "chi_sim" not in str(ocr_languages or ""))
                ):
                    ocr_notice = "当前 OCR 仅有英文语言包；答案中的中文解析质量可能下降，低质量内容不会被当作可靠解析"
                else:
                    ocr_notice = None
                manifest: dict[str, object] = {
                    "id": exam_id,
                    "title": str(metadata.get("title") or "未命名英语试卷"),
                    "pageCount": len(manifest_pages),
                    "source": f"/api/exams/{exam_id}/source",
                    "pages": manifest_pages,
                    "extraction": {
                        "engine": paper_source,
                        "hadTextLayer": paper_source.startswith("pdf_text"),
                        "wordCount": _meaningful_word_count(paper_pages),
                        "ocrLanguages": ocr_languages,
                        "unresolvedTextPages": unresolved_text_pages,
                        "ocrNotice": ocr_notice,
                    },
                }
                _atomic_json(directory / "manifest.json", manifest)

                self._set_status(exam_id, status="processing", stage="parsing_questions", progress=60, message="正在保守识别题号、题干和选项")
                questions, structure = _extract_questions(paper_pages, paper_source)
                unresolved_questions = _unresolved_question_gaps(questions)
                question_review = _review_summary(questions)
                question_review["unresolved"] = len(unresolved_questions)
                question_document = {
                    "examId": exam_id,
                    "questions": questions,
                    "structure": structure,
                    "unresolved": unresolved_questions,
                    "reviewSummary": question_review,
                    "parser": {"engine": "coordinate_heuristics_v1", "policy": "uncertain-items-are-not-invented"},
                }
                _atomic_json(directory / "questions.json", question_document)

                answers: list[dict[str, object]] = []
                conflicts: list[dict[str, object]] = []
                answer_pages: list[dict[str, object]] = []
                answer_metadata = metadata.get("answer")
                if isinstance(answer_metadata, dict):
                    self._set_status(exam_id, status="processing", stage="parsing_answers", progress=72, message="正在提取答案 PDF 中的明确答案和解析")

                    def answer_ocr_status() -> None:
                        self._set_status(exam_id, status="processing", stage="ocr", progress=76, message="答案 PDF 没有可用文字层，正在执行 OCR")

                    answer_pages, answer_source = _extract_document(directory / "input" / "answer.pdf", work, "answer", answer_ocr_status)
                    answers, conflicts = _extract_answers(answer_pages, answer_source, questions)
                answer_document = {
                    "examId": exam_id,
                    "answers": answers,
                    "conflicts": conflicts,
                    "reviewSummary": _review_summary(answers),
                    "officialSource": bool(answer_metadata),
                    "policy": "only-explicit-answer-markers-are-stored",
                }
                _atomic_json(directory / "answers.json", answer_document)

                self._set_status(exam_id, status="processing", stage="indexing", progress=90, message="正在建立题号精确索引和本地向量补充索引")
                _build_index(directory / "rag.sqlite3", answers, answer_pages)

            metadata["paperExtraction"] = paper_source
            metadata["updatedAt"] = _now()
            _atomic_json(directory / "metadata.json", metadata)
            review_counts = {
                "questions": question_review,
                "answers": _review_summary(answers),
                "answerConflicts": len(conflicts),
            }
            result: dict[str, object] = {
                "manifestUrl": f"/api/exams/{exam_id}/manifest",
                "questionsUrl": f"/api/exams/{exam_id}/questions",
                "answersUrl": f"/api/exams/{exam_id}/answers",
                "sourceUrl": f"/api/exams/{exam_id}/source",
                "audioUrl": f"/api/exams/{exam_id}/audio" if metadata.get("audio") else None,
                "reviewCounts": review_counts,
            }
            self._set_status(exam_id, status="ready", stage="complete", progress=100, message="试卷解析完成", result=result)
        except PlatformError as error:
            self._set_status(exam_id, status="failed", stage="failed", progress=100, message="试卷解析失败", error=error.message)
        except Exception:
            # Do not expose an unexpected stack trace, filesystem path, or
            # secret in the status API.  The server console still gets a
            # useful exception for development diagnostics.
            import traceback

            traceback.print_exc()
            self._set_status(exam_id, status="failed", stage="failed", progress=100, message="试卷解析失败", error="服务器处理试卷时发生内部错误")

    def document_with_revision(self, exam_id: str, name: str) -> tuple[dict[str, object], int]:
        if name not in {"manifest", "questions", "answers"}:
            raise PlatformError("document not found", HTTPStatus.NOT_FOUND)
        with self._lock:
            directory = _safe_exam_directory(exam_id)
            revision = 0
            if name in {"questions", "answers"}:
                snapshot, revision, _ = self._current_review_snapshot(exam_id)
                path = snapshot / f"{name}.json"
            else:
                path = directory / f"{name}.json"
            document = _read_json(path)
            if not isinstance(document, dict):
                status = self.status(exam_id)
                if status.get("status") == "failed":
                    raise PlatformError(str(status.get("error") or "exam parsing failed"), HTTPStatus.UNPROCESSABLE_ENTITY)
                raise PlatformError("exam document is not ready", HTTPStatus.CONFLICT)
            return document, revision

    def document(self, exam_id: str, name: str) -> dict[str, object]:
        return self.document_with_revision(exam_id, name)[0]

    def source_path(self, exam_id: str) -> tuple[Path, str, str]:
        directory = _safe_exam_directory(exam_id)
        path = directory / "input" / "paper.pdf"
        metadata = _read_json(directory / "metadata.json", {})
        if not path.is_file() or not isinstance(metadata, dict):
            raise PlatformError("exam source not found", HTTPStatus.NOT_FOUND)
        name = Path(str((metadata.get("paper") or {}).get("originalName", "paper.pdf"))).name
        return path, "application/pdf", name

    def audio_path(self, exam_id: str) -> tuple[Path, str, str]:
        directory = _safe_exam_directory(exam_id)
        metadata = _read_json(directory / "metadata.json", {})
        audio = metadata.get("audio") if isinstance(metadata, dict) else None
        if not isinstance(audio, dict):
            raise PlatformError("this exam has no listening audio", HTTPStatus.NOT_FOUND)
        stored_name = Path(str(audio.get("storedName", ""))).name
        path = directory / "input" / stored_name
        if not path.is_file() or stored_name not in {"listening.mp3", "listening.wav", "listening.m4a"}:
            raise PlatformError("listening audio not found", HTTPStatus.NOT_FOUND)
        return path, str(audio.get("contentType") or mimetypes.guess_type(path.name)[0] or "application/octet-stream"), Path(str(audio.get("originalName") or path.name)).name

    def page_asset_path(self, exam_id: str, filename: str) -> tuple[Path, str, str]:
        if not SAFE_PAGE_ASSET.fullmatch(filename):
            raise PlatformError("page asset not found", HTTPStatus.NOT_FOUND)
        path = _safe_exam_directory(exam_id) / "assets" / "pages" / filename
        if not path.is_file():
            raise PlatformError("page asset not found", HTTPStatus.NOT_FOUND)
        return path, "image/jpeg", filename

    def _retrieve(
        self,
        exam_id: str,
        question_id: str,
        query: str,
        snapshot: Path | None = None,
    ) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
        path = (snapshot or _safe_exam_directory(exam_id)) / "rag.sqlite3"
        if not path.is_file():
            return [], []
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            exact_rows = connection.execute(
                "SELECT id, question_id, kind, content FROM chunks WHERE question_id = ? ORDER BY kind = 'official_answer' DESC, id LIMIT 8",
                (question_id,),
            ).fetchall()
            exact_ids = {int(row["id"]) for row in exact_rows}
            query_vector = _embedding(query)
            scored: list[tuple[float, sqlite3.Row]] = []
            for row in connection.execute("SELECT id, question_id, kind, content, embedding FROM chunks LIMIT 10000"):
                if int(row["id"]) in exact_ids:
                    continue
                try:
                    vector = json.loads(row["embedding"])
                    score = _cosine(query_vector, [float(value) for value in vector])
                except (TypeError, ValueError, json.JSONDecodeError):
                    continue
                if score >= 0.12:
                    scored.append((score, row))
            scored.sort(key=lambda item: item[0], reverse=True)
            exact = [
                {"questionId": row["question_id"], "kind": row["kind"], "content": row["content"]}
                for row in exact_rows
            ]
            vector = [
                {
                    "questionId": row["question_id"],
                    "kind": row["kind"],
                    "content": row["content"],
                    "score": round(score, 4),
                }
                for score, row in scored[:3]
            ]
            return exact, vector
        finally:
            connection.close()

    def assistant(self, exam_id: str, payload: dict[str, object]) -> dict[str, object]:
        allowed = {"questionId", "message", "userAnswer", "history", "reviewRevision"}
        if set(payload) - allowed:
            raise PlatformError("assistant request contains unsupported fields")
        question_id = payload.get("questionId")
        message = payload.get("message")
        user_answer = payload.get("userAnswer")
        history = payload.get("history", [])
        expected_revision = payload.get("reviewRevision")
        if not isinstance(question_id, str) or not re.fullmatch(
            r"(?:q[1-9][0-9]{0,2}|writing-[1-9][0-9]{0,2}|translation-[1-9][0-9]{0,2})",
            question_id,
        ):
            raise PlatformError("questionId must look like q26, writing-1, or translation-1")
        if not isinstance(message, str) or not message.strip() or len(message.strip()) > MAX_ASSISTANT_MESSAGE_CHARS:
            raise PlatformError(f"message must contain 1 to {MAX_ASSISTANT_MESSAGE_CHARS} characters")
        if user_answer is not None and (not isinstance(user_answer, str) or len(user_answer) > 100):
            raise PlatformError("userAnswer must be a short string")
        if expected_revision is not None and (
            isinstance(expected_revision, bool)
            or not isinstance(expected_revision, int)
            or expected_revision < 0
        ):
            raise PlatformError("reviewRevision must be a non-negative integer")
        if not isinstance(history, list) or len(history) > MAX_ASSISTANT_HISTORY:
            raise PlatformError(f"history may contain at most {MAX_ASSISTANT_HISTORY} messages")
        clean_history: list[dict[str, str]] = []
        for index, item in enumerate(history):
            if not isinstance(item, dict) or set(item) != {"role", "content"}:
                raise PlatformError(f"history[{index}] must contain only role and content")
            role, content = item.get("role"), item.get("content")
            if role not in {"user", "assistant"} or not isinstance(content, str) or not content.strip() or len(content) > 4_000:
                raise PlatformError(f"history[{index}] is invalid")
            clean_history.append({"role": role, "content": content.strip()})

        # Resolve the revision once so question, answer, and RAG evidence cannot
        # come from different review snapshots during an atomic publication.
        with self._lock:
            snapshot, revision, _ = self._current_review_snapshot(exam_id)
            if expected_revision is not None and expected_revision != revision:
                raise PlatformError(
                    f"review revision changed; current revision is {revision}",
                    HTTPStatus.CONFLICT,
                )
            questions_document, answers_document = self._snapshot_documents(snapshot)
            questions = questions_document.get("questions", [])
            question = next((item for item in questions if isinstance(item, dict) and item.get("questionId") == question_id), None)
            if question is None:
                raise PlatformError("questionId was not found in the parsed paper", HTTPStatus.NOT_FOUND)
            answers = answers_document.get("answers", [])
            official = next((item for item in answers if isinstance(item, dict) and item.get("questionId") == question_id), None)
            retrieval_query = " ".join(
                [question_id, str(question.get("stem") or ""), str(message), str(user_answer or "")]
            )
            exact, vector = self._retrieve(exam_id, question_id, retrieval_query, snapshot=snapshot)
        official_explanation_found = bool(official and str(official.get("explanation") or "").strip())
        disclaimer = "" if official_explanation_found else "答案资料中没有找到官方解析，以下为 AI 辅助分析。"
        reply = self._grounded_fallback(question_id, question, official, user_answer, disclaimer)
        api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
        if api_key and api_key not in {"YOUR_DEEPSEEK_API_KEY", "PASTE_YOUR_DEEPSEEK_API_KEY_HERE"}:
            try:
                reply = self._deepseek_assistant_reply(
                    api_key,
                    question_id,
                    question,
                    official,
                    user_answer,
                    message.strip(),
                    clean_history,
                    exact,
                    vector,
                    disclaimer,
                )
            except PlatformError as error:
                reply += f"\n\nAI 服务暂时不可用（{error.message}），以上仅展示已检索到的答案资料。"
        return {
            "examId": exam_id,
            "questionId": question_id,
            "revision": revision,
            "reply": reply,
            "grounding": {
                "officialExplanationFound": official_explanation_found,
                "exactMatches": len(exact),
                "vectorMatches": len(vector),
                "disclaimer": disclaimer,
                "retrievalOrder": ["question_id_exact", "deterministic_vector_supplement"],
            },
        }

    @staticmethod
    def _grounded_fallback(
        question_id: str,
        question: dict[str, object],
        official: dict[str, object] | None,
        user_answer: object,
        disclaimer: str,
    ) -> str:
        number = str(question.get("number") or question_id)
        parts = [f"{number}题" if number in {"写作", "翻译"} else f"第 {number} 题"]
        if user_answer:
            parts.append(f"你的答案是 {user_answer}。")
        if official:
            if official.get("source") == "human_review":
                parts.append(f"人工复核后的答案记录给出的正确答案是 {official.get('answer')}。")
            else:
                parts.append(f"你上传的答案资料明确给出的正确答案是 {official.get('answer')}。")
            explanation = str(official.get("explanation") or "").strip()
            if explanation:
                parts.append(f"答案资料中的解析：{explanation}")
            else:
                parts.append(disclaimer)
                parts.append("当前未配置可用的 AI 模型；为避免编造，暂不推断其他选项为什么错误。")
        else:
            parts.append(disclaimer)
            parts.append("答案资料中也没有识别到本题的明确答案；为避免猜测，系统不会生成正确选项。")
        return "\n\n".join(part for part in parts if part)

    @staticmethod
    def _deepseek_assistant_reply(
        api_key: str,
        question_id: str,
        question: dict[str, object],
        official: dict[str, object] | None,
        user_answer: object,
        message: str,
        history: list[dict[str, str]],
        exact: list[dict[str, object]],
        vector: list[dict[str, object]],
        disclaimer: str,
    ) -> str:
        evidence_parts = [f"当前题目 JSON：{json.dumps(question, ensure_ascii=False)}"]
        if official:
            evidence_parts.append(f"当前题明确答案记录：{json.dumps(official, ensure_ascii=False)}")
        if exact:
            evidence_parts.append("题号精确检索：\n" + "\n".join(str(item["content"]) for item in exact))
        if vector:
            evidence_parts.append("向量补充资料（不得据此冒充当前题官方答案）：\n" + "\n".join(str(item["content"]) for item in vector))
        system = (
            "你是 CET 试卷辅导助手。回答必须先使用题号精确检索到的用户上传答案资料；"
            "向量结果只能补充背景，不能据此推断或更改当前题正确答案。清楚区分官方资料和 AI 分析，"
            "引用原文依据；资料不足就明确说不知道，禁止编造。"
        )
        if disclaimer:
            system += f" 当前题没有找到官方解析，回答开头必须原样包含：{disclaimer}"
        user_content = (
            f"题号：{question_id}\n用户答案：{user_answer or '未作答'}\n用户问题：{message}\n\n"
            + "\n\n".join(evidence_parts)
        )[:28_000]
        request_body = json.dumps(
            {
                "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-chat"),
                "messages": [{"role": "system", "content": system}, *history, {"role": "user", "content": user_content}],
                "stream": False,
                "temperature": 0.2,
                "max_tokens": 1_400,
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request = Request(
            DEEPSEEK_API_URL,
            method="POST",
            data=request_body,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "CET-Exam-Platform/1.0",
            },
        )
        try:
            with urlopen(request, timeout=DEEPSEEK_TIMEOUT_SECONDS) as response:
                raw = response.read(128 * 1024 + 1)
        except HTTPError as error:
            try:
                error.read(4096)
            except OSError:
                pass
            raise PlatformError("上游 AI 请求失败", HTTPStatus.BAD_GATEWAY)
        except (URLError, OSError, TimeoutError):
            raise PlatformError("上游 AI 暂时不可用", HTTPStatus.BAD_GATEWAY)
        if len(raw) > 128 * 1024:
            raise PlatformError("上游 AI 响应过大", HTTPStatus.BAD_GATEWAY)
        try:
            reply = json.loads(raw.decode("utf-8"))["choices"][0]["message"]["content"]
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError):
            raise PlatformError("上游 AI 返回了无效响应", HTTPStatus.BAD_GATEWAY)
        if not isinstance(reply, str) or not reply.strip():
            raise PlatformError("上游 AI 返回了空响应", HTTPStatus.BAD_GATEWAY)
        cleaned = reply.strip()
        if disclaimer and disclaimer not in cleaned:
            cleaned = f"{disclaimer}\n\n{cleaned}"
        return cleaned


class PlatformAPI:
    """Small adapter between ``ReadingLabHandler`` and ``PlatformService``."""

    DETAIL_ROUTE = re.compile(
        r"^/api/exams/(exam-[0-9]{8}-[0-9a-f]{12})/(status|manifest|questions|answers|audio|source)$"
    )
    ASSET_ROUTE = re.compile(
        r"^/api/exams/(exam-[0-9]{8}-[0-9a-f]{12})/assets/pages/(page-[1-9][0-9]{0,2}\.jpg)$"
    )
    ASSISTANT_ROUTE = re.compile(r"^/api/exams/(exam-[0-9]{8}-[0-9a-f]{12})/assistant$")
    REVIEW_ROUTE = re.compile(r"^/api/exams/(exam-[0-9]{8}-[0-9a-f]{12})/review$")

    def __init__(self) -> None:
        self.service = PlatformService()

    @staticmethod
    def _send_error(handler, error: PlatformError) -> None:
        handler._json_error(error.status, error.message)

    def handle_get(self, handler, parsed, include_body: bool = True) -> bool:
        path = parsed.path.rstrip("/") or "/"
        if not path.startswith("/api/exams"):
            return False
        if parsed.query:
            handler._json_error(HTTPStatus.BAD_REQUEST, "query parameters are not supported")
            return True
        try:
            if path == "/api/exams/capabilities":
                handler._json_response(HTTPStatus.OK, self.service.capabilities(), include_body=include_body)
                return True
            if path == "/api/exams":
                handler._json_response(HTTPStatus.OK, self.service.list_exams(), include_body=include_body)
                return True
            review = self.REVIEW_ROUTE.fullmatch(path)
            if review:
                document = self.service.review(review.group(1))
                handler._json_response(
                    HTTPStatus.OK,
                    document,
                    include_body=include_body,
                    extra_headers={"ETag": str(document["etag"])},
                )
                return True
            detail = self.DETAIL_ROUTE.fullmatch(path)
            if detail:
                exam_id, resource = detail.groups()
                if resource == "status":
                    handler._json_response(HTTPStatus.OK, self.service.status(exam_id), include_body=include_body)
                elif resource in {"manifest", "questions", "answers"}:
                    document, revision = self.service.document_with_revision(exam_id, resource)
                    if resource in {"questions", "answers"}:
                        requested_etag = handler.headers.get("If-Match", "").strip()
                        if requested_etag and _parse_review_etag(requested_etag) != revision:
                            raise PlatformError(
                                f"review revision changed; current revision is {revision}",
                                HTTPStatus.PRECONDITION_FAILED,
                            )
                        handler._json_response(
                            HTTPStatus.OK,
                            document,
                            include_body=include_body,
                            extra_headers={"ETag": _review_etag(revision)},
                        )
                    else:
                        handler._json_response(HTTPStatus.OK, document, include_body=include_body)
                elif resource == "audio":
                    self._serve_file(handler, *self.service.audio_path(exam_id), include_body=include_body)
                elif resource == "source":
                    self._serve_file(handler, *self.service.source_path(exam_id), include_body=include_body)
                return True
            asset = self.ASSET_ROUTE.fullmatch(path)
            if asset:
                self._serve_file(handler, *self.service.page_asset_path(asset.group(1), asset.group(2)), include_body=include_body)
                return True
            raise PlatformError("API endpoint not found", HTTPStatus.NOT_FOUND)
        except PlatformError as error:
            self._send_error(handler, error)
            return True

    def handle_patch(self, handler, parsed) -> bool:
        path = parsed.path.rstrip("/") or "/"
        if not path.startswith("/api/exams"):
            return False
        if parsed.query:
            handler._json_error(HTTPStatus.BAD_REQUEST, "query parameters are not supported")
            return True
        if not handler._request_is_same_origin():
            handler._json_error(HTTPStatus.FORBIDDEN, "cross-origin requests are not allowed")
            return True
        try:
            address = ipaddress.ip_address(str(handler.client_address[0]))
        except (AttributeError, IndexError, ValueError):
            address = None
        review_host = urlparse(f"//{handler.headers.get('Host', '')}").hostname or ""
        try:
            host_is_loopback = ipaddress.ip_address(review_host).is_loopback
        except ValueError:
            host_is_loopback = review_host.lower() == "localhost"
        if address is None or not address.is_loopback or not host_is_loopback:
            handler._json_error(
                HTTPStatus.FORBIDDEN,
                "review writes are restricted to the local machine until authentication is configured",
            )
            return True
        route = self.REVIEW_ROUTE.fullmatch(path)
        if not route:
            handler._json_error(HTTPStatus.NOT_FOUND, "API endpoint not found")
            return True
        try:
            expected_revision = _parse_review_etag(handler.headers.get("If-Match", ""))
            payload = self._read_json_body(handler, maximum=MAX_REVIEW_BYTES)
            response = self.service.apply_review_patch(
                route.group(1),
                payload,
                expected_revision,
                actor="local-reviewer",
            )
            handler._json_response(
                HTTPStatus.OK,
                response,
                extra_headers={"ETag": str(response["etag"])},
            )
            return True
        except PlatformError as error:
            if error.status == HTTPStatus.CONFLICT:
                try:
                    current = self.service.review(route.group(1))
                    handler._json_response(
                        HTTPStatus.CONFLICT,
                        {"error": error.message, "currentRevision": current["revision"]},
                        extra_headers={"ETag": str(current["etag"])},
                    )
                    return True
                except PlatformError:
                    pass
            self._send_error(handler, error)
            return True

    def handle_post(self, handler, parsed) -> bool:
        path = parsed.path.rstrip("/") or "/"
        if not path.startswith("/api/exams"):
            return False
        if parsed.query:
            handler._json_error(HTTPStatus.BAD_REQUEST, "query parameters are not supported")
            return True
        if not handler._request_is_same_origin():
            handler._json_error(HTTPStatus.FORBIDDEN, "cross-origin requests are not allowed")
            return True
        try:
            if path == "/api/exams/upload":
                response = self.service.create_from_multipart(handler)
                handler._json_response(HTTPStatus.ACCEPTED, response)
                return True
            assistant = self.ASSISTANT_ROUTE.fullmatch(path)
            if assistant:
                payload = self._read_json_body(handler)
                response = self.service.assistant(assistant.group(1), payload)
                handler._json_response(HTTPStatus.OK, response)
                return True
            raise PlatformError("API endpoint not found", HTTPStatus.NOT_FOUND)
        except PlatformError as error:
            self._send_error(handler, error)
            return True

    @staticmethod
    def _read_json_body(handler, maximum: int = MAX_ASSISTANT_BYTES) -> dict[str, object]:
        media_type = handler.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if media_type != "application/json":
            raise PlatformError("Content-Type must be application/json", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
        raw_length = handler.headers.get("Content-Length")
        if raw_length is None:
            raise PlatformError("Content-Length is required", HTTPStatus.LENGTH_REQUIRED)
        try:
            length = int(raw_length)
        except ValueError:
            raise PlatformError("invalid Content-Length")
        if length <= 0:
            raise PlatformError("request body must not be empty")
        if length > maximum:
            raise PlatformError("request body is too large", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        raw = handler.rfile.read(length)
        if len(raw) != length:
            raise PlatformError("incomplete request body")
        try:
            document = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise PlatformError("request body must be valid UTF-8 JSON")
        if not isinstance(document, dict):
            raise PlatformError("request body must be a JSON object")
        return document

    @staticmethod
    def _serve_file(handler, path: Path, content_type: str, download_name: str, include_body: bool) -> None:
        try:
            size = path.stat().st_size
        except OSError:
            raise PlatformError("file not found", HTTPStatus.NOT_FOUND)
        start, end = 0, size - 1
        status = HTTPStatus.OK
        range_header = handler.headers.get("Range", "").strip()
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header)
            if not match or (not match.group(1) and not match.group(2)):
                PlatformAPI._range_error(handler, size)
                return
            try:
                if not match.group(1):
                    suffix = int(match.group(2))
                    if suffix <= 0:
                        raise ValueError
                    start = max(0, size - suffix)
                else:
                    start = int(match.group(1))
                    if match.group(2):
                        end = int(match.group(2))
                if start >= size or start < 0 or end < start:
                    raise ValueError
                end = min(end, size - 1)
            except ValueError:
                PlatformAPI._range_error(handler, size)
                return
            status = HTTPStatus.PARTIAL_CONTENT
        length = max(0, end - start + 1)
        fallback_name = re.sub(r"[^A-Za-z0-9._-]", "_", download_name) or "download"
        disposition = f"inline; filename=\"{fallback_name}\"; filename*=UTF-8''{quote(download_name)}"
        handler.send_response(status)
        handler.send_header("Content-Type", content_type)
        handler.send_header("Content-Length", str(length))
        handler.send_header("Accept-Ranges", "bytes")
        handler.send_header("Content-Disposition", disposition)
        handler.send_header("Cache-Control", "private, max-age=3600")
        handler.send_header("X-Content-Type-Options", "nosniff")
        if status == HTTPStatus.PARTIAL_CONTENT:
            handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        handler.end_headers()
        if not include_body or length <= 0:
            return
        with path.open("rb") as source:
            source.seek(start)
            remaining = length
            while remaining:
                chunk = source.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                try:
                    handler.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    # Browsers routinely cancel an initial media request after
                    # reading metadata and reopen it with a narrower Range.
                    break
                remaining -= len(chunk)

    @staticmethod
    def _range_error(handler, size: int) -> None:
        handler.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
        handler.send_header("Content-Range", f"bytes */{size}")
        handler.send_header("Content-Length", "0")
        handler.send_header("Cache-Control", "no-store")
        handler.end_headers()


PLATFORM_API = PlatformAPI()
