"""Dependency-free client adapter for the optional PaddleOCR sidecar.

The main CET server intentionally imports no machine-learning packages and
machine-learning packages.  This module talks to a separately managed
PaddleOCR process and converts its pixel-coordinate response into the page
coordinate schema already consumed by the reader.

The integration boundary stays independent so the existing
OCRmyPDF/Tesseract fallback path remains usable when the sidecar is disabled.
"""

from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import Request, urlopen


SCHEMA_VERSION = 1
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SHARED_ROOT = PROJECT_ROOT / "data" / "exams"
DEFAULT_TIMEOUT_SECONDS = 300.0
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
MAX_PAGES = 200
MAX_LINES_PER_PAGE = 20_000
MAX_WORDS_PER_PAGE = 200_000
MAX_TEXT_CHARS = 2_000
MAX_IMAGE_DIMENSION = 65_535
MAX_IMAGE_PIXELS = 100_000_000
LANGUAGE = re.compile(r"^[A-Za-z0-9_+-]{1,32}$")
TOKEN_PATTERN = re.compile(
    r"[A-Za-z0-9]+(?:[\u2019'][A-Za-z0-9]+)*(?:-[A-Za-z0-9]+)*|[^\s]",
    re.UNICODE,
)


class PaddleOCRError(RuntimeError):
    """Base error raised by the optional PaddleOCR adapter."""


class PaddleOCRUnavailable(PaddleOCRError):
    """Raised when the optional sidecar is not configured or cannot be reached."""


class PaddleOCRProtocolError(PaddleOCRError):
    """Raised when the sidecar violates the bounded response contract."""


def _environment_timeout(value: str) -> float:
    try:
        timeout = float(value)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_SECONDS
    if not math.isfinite(timeout) or timeout < 1 or timeout > 3_600:
        return DEFAULT_TIMEOUT_SECONDS
    return timeout


def _validated_endpoint(value: str) -> str:
    endpoint = value.strip()
    if not endpoint:
        return ""
    parsed = urlparse(endpoint)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise PaddleOCRUnavailable("CET_PADDLEOCR_URL must be a plain HTTP(S) endpoint")
    return endpoint


def _png_dimensions(path: Path) -> tuple[int, int]:
    try:
        with path.open("rb") as image:
            header = image.read(24)
    except OSError as error:
        raise PaddleOCRError(f"cannot read PaddleOCR page image: {error}") from error
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise PaddleOCRError("PaddleOCR page images must be PNG files")
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    if (
        not 0 < width <= MAX_IMAGE_DIMENSION
        or not 0 < height <= MAX_IMAGE_DIMENSION
        or width * height > MAX_IMAGE_PIXELS
    ):
        raise PaddleOCRError("PaddleOCR page image dimensions are invalid")
    return width, height


def _finite_number(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PaddleOCRProtocolError(f"{context} must be a finite number")
    number = float(value)
    if not math.isfinite(number):
        raise PaddleOCRProtocolError(f"{context} must be a finite number")
    return number


def _positive_number(value: object, context: str) -> float:
    number = _finite_number(value, context)
    if number <= 0:
        raise PaddleOCRProtocolError(f"{context} must be positive")
    return number


def _bounded_text(value: object, context: str, maximum: int = MAX_TEXT_CHARS) -> str:
    if not isinstance(value, str):
        raise PaddleOCRProtocolError(f"{context} must be text")
    text = value.strip()
    if not text or len(text) > maximum:
        raise PaddleOCRProtocolError(f"{context} is empty or too long")
    return text


def _bounded_box(
    value: object,
    pixel_width: int,
    pixel_height: int,
    context: str,
) -> tuple[float, float, float, float]:
    if not isinstance(value, list) or len(value) != 4:
        raise PaddleOCRProtocolError(f"{context} must be [x_min, y_min, x_max, y_max]")
    x_min, y_min, x_max, y_max = (
        _finite_number(item, context) for item in value
    )
    if (
        x_min < 0
        or y_min < 0
        or x_max <= x_min
        or y_max <= y_min
        or x_max > pixel_width
        or y_max > pixel_height
    ):
        raise PaddleOCRProtocolError(f"{context} lies outside the source image")
    return x_min, y_min, x_max, y_max


def _confidence(value: object, context: str) -> float:
    score = _finite_number(value, context)
    if not 0 <= score <= 1:
        raise PaddleOCRProtocolError(f"{context} must be between 0 and 1")
    return score


def _estimated_line_words(
    text: str,
    box: tuple[float, float, float, float],
) -> list[tuple[str, tuple[float, float, float, float]]]:
    """Estimate token boxes only when the sidecar has no word-level result.

    PaddleOCR exposes line boxes for every result and word boxes when
    ``return_word_box`` is supported by the selected recognition model.  This
    fallback is visibly marked in the manifest data so callers never mistake a
    proportional estimate for a model-produced coordinate.
    """

    matches = list(TOKEN_PATTERN.finditer(text))
    if not matches:
        return []
    x_min, y_min, x_max, y_max = box
    span = max(1, len(text))
    width = x_max - x_min
    return [
        (
            match.group(0),
            (
                x_min + width * match.start() / span,
                y_min,
                x_min + width * match.end() / span,
                y_max,
            ),
        )
        for match in matches
    ]


def convert_response_to_pages(
    document: object,
    base_pages: Sequence[Mapping[str, object]],
    image_sizes: Sequence[tuple[int, int]],
) -> list[dict[str, object]]:
    """Validate a sidecar response and map pixels to existing page units."""

    if not isinstance(document, dict):
        raise PaddleOCRProtocolError("PaddleOCR response must be a JSON object")
    if document.get("schemaVersion") != SCHEMA_VERSION:
        raise PaddleOCRProtocolError("unsupported PaddleOCR response schema")
    engine = document.get("engine")
    if not isinstance(engine, dict) or engine.get("name") != "paddleocr":
        raise PaddleOCRProtocolError("PaddleOCR response has an invalid engine descriptor")
    response_pages = document.get("pages")
    if not isinstance(response_pages, list):
        raise PaddleOCRProtocolError("PaddleOCR response pages must be a list")
    if len(base_pages) != len(image_sizes) or len(base_pages) > MAX_PAGES:
        raise PaddleOCRProtocolError("PaddleOCR request page metadata is inconsistent")

    expected: dict[int, tuple[Mapping[str, object], tuple[int, int]]] = {}
    for index, (page, image_size) in enumerate(zip(base_pages, image_sizes)):
        try:
            number = int(page["number"])
        except (KeyError, TypeError, ValueError) as error:
            raise PaddleOCRProtocolError(f"base page {index} has no valid number") from error
        if number <= 0 or number in expected:
            raise PaddleOCRProtocolError("base page numbers must be unique positive integers")
        pixel_width, pixel_height = image_size
        if (
            isinstance(pixel_width, bool)
            or isinstance(pixel_height, bool)
            or not isinstance(pixel_width, int)
            or not isinstance(pixel_height, int)
            or not 0 < pixel_width <= MAX_IMAGE_DIMENSION
            or not 0 < pixel_height <= MAX_IMAGE_DIMENSION
            or pixel_width * pixel_height > MAX_IMAGE_PIXELS
        ):
            raise PaddleOCRProtocolError("source image dimensions are invalid")
        expected[number] = (page, image_size)

    supplied: dict[int, dict[str, object]] = {}
    for index, raw_page in enumerate(response_pages):
        if not isinstance(raw_page, dict):
            raise PaddleOCRProtocolError(f"response page {index} must be an object")
        number_value = raw_page.get("pageNumber")
        if isinstance(number_value, bool) or not isinstance(number_value, int):
            raise PaddleOCRProtocolError(f"response page {index} has an invalid page number")
        if number_value in supplied:
            raise PaddleOCRProtocolError("PaddleOCR returned a duplicate page")
        supplied[number_value] = raw_page
    if set(supplied) != set(expected):
        raise PaddleOCRProtocolError("PaddleOCR response page set does not match the request")

    converted_pages: list[dict[str, object]] = []
    for number, (base_page, expected_image_size) in expected.items():
        raw_page = supplied[number]
        pixel_width_value = raw_page.get("imageWidth")
        pixel_height_value = raw_page.get("imageHeight")
        if (
            isinstance(pixel_width_value, bool)
            or isinstance(pixel_height_value, bool)
            or not isinstance(pixel_width_value, int)
            or not isinstance(pixel_height_value, int)
            or (pixel_width_value, pixel_height_value) != expected_image_size
        ):
            raise PaddleOCRProtocolError(f"page {number} image dimensions changed in the sidecar")
        pixel_width, pixel_height = expected_image_size
        page_width = _positive_number(base_page.get("width"), f"page {number} width")
        page_height = _positive_number(base_page.get("height"), f"page {number} height")
        raw_lines = raw_page.get("lines")
        if not isinstance(raw_lines, list) or len(raw_lines) > MAX_LINES_PER_PAGE:
            raise PaddleOCRProtocolError(f"page {number} has an invalid line list")

        words: list[dict[str, object]] = []
        for line_index, raw_line in enumerate(raw_lines):
            context = f"page {number} line {line_index}"
            if not isinstance(raw_line, dict):
                raise PaddleOCRProtocolError(f"{context} must be an object")
            line_text = _bounded_text(raw_line.get("text"), f"{context} text")
            line_score = _confidence(raw_line.get("confidence"), f"{context} confidence")
            line_box = _bounded_box(raw_line.get("box"), pixel_width, pixel_height, f"{context} box")
            raw_words = raw_line.get("words")
            if not isinstance(raw_words, list):
                raise PaddleOCRProtocolError(f"{context} words must be a list")

            line_words: list[tuple[str, tuple[float, float, float, float], float, bool]] = []
            if raw_words:
                for word_index, raw_word in enumerate(raw_words):
                    word_context = f"{context} word {word_index}"
                    if not isinstance(raw_word, dict):
                        raise PaddleOCRProtocolError(f"{word_context} must be an object")
                    word_text = _bounded_text(raw_word.get("text"), f"{word_context} text", 500)
                    word_box = _bounded_box(
                        raw_word.get("box"), pixel_width, pixel_height, f"{word_context} box"
                    )
                    word_score = (
                        _confidence(raw_word["confidence"], f"{word_context} confidence")
                        if "confidence" in raw_word
                        else line_score
                    )
                    line_words.append((word_text, word_box, word_score, False))
            else:
                line_words.extend(
                    (word_text, word_box, line_score, True)
                    for word_text, word_box in _estimated_line_words(line_text, line_box)
                )

            if len(words) + len(line_words) > MAX_WORDS_PER_PAGE:
                raise PaddleOCRProtocolError(f"page {number} contains too many words")
            for word_text, word_box, word_score, estimated in line_words:
                x_min, y_min, x_max, y_max = word_box
                words.append(
                    {
                        "id": len(words),
                        "line": line_index,
                        "text": word_text,
                        "x": round(x_min * page_width / pixel_width, 3),
                        "y": round(y_min * page_height / pixel_height, 3),
                        "width": round((x_max - x_min) * page_width / pixel_width, 3),
                        "height": round((y_max - y_min) * page_height / pixel_height, 3),
                        "ocrConfidence": round(word_score, 3),
                        "ocrEngine": "paddleocr",
                        "ocrBoxSource": "estimated-line" if estimated else "word-model",
                    }
                )
        converted_pages.append({**base_page, "words": words})
    return converted_pages


@dataclass(frozen=True)
class PaddleOCRClient:
    """Small HTTP client that can be safely instantiated by the main server."""

    endpoint: str
    shared_root: Path = DEFAULT_SHARED_ROOT
    token: str = ""
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    language: str = "en"

    @classmethod
    def from_environment(cls) -> "PaddleOCRClient":
        return cls(
            endpoint=_validated_endpoint(os.environ.get("CET_PADDLEOCR_URL", "")),
            shared_root=Path(
                os.environ.get("CET_PADDLEOCR_SHARED_ROOT", str(DEFAULT_SHARED_ROOT))
            ),
            token=os.environ.get("CET_PADDLEOCR_TOKEN", "").strip(),
            timeout_seconds=_environment_timeout(
                os.environ.get("CET_PADDLEOCR_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS))
            ),
            language=os.environ.get("CET_PADDLEOCR_LANGUAGE", "en").strip() or "en",
        )

    @property
    def configured(self) -> bool:
        return bool(self.endpoint)

    def health(
        self,
        timeout_seconds: float = 2.0,
        language: str | None = None,
    ) -> dict[str, object]:
        """Return validated readiness without asking the sidecar to load a model.

        Readiness is false when the shared mount or Paddle runtime import is not
        ready, or when the language configured by the main service is not
        enabled by the sidecar.  A configured bearer token is sent to healthz
        as well as the inference endpoint so a protected service can still be
        monitored without exposing an unauthenticated configuration probe.
        """

        if not self.configured:
            raise PaddleOCRUnavailable("CET_PADDLEOCR_URL is not configured")
        parsed = urlparse(self.endpoint)
        health_url = urlunparse((parsed.scheme, parsed.netloc, "/healthz", "", "", ""))
        requested_language = self.language if language is None else language
        if not isinstance(requested_language, str) or not LANGUAGE.fullmatch(requested_language):
            raise PaddleOCRError("PaddleOCR language is invalid")
        headers = {
            "Accept": "application/json",
            "User-Agent": "cet-reading-lab-paddle-adapter/1",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = Request(health_url, headers=headers, method="GET")
        try:
            with urlopen(request, timeout=max(0.2, min(float(timeout_seconds), 10.0))) as response:
                media_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
                raw = response.read(16 * 1024 + 1)
        except HTTPError as error:
            raise PaddleOCRUnavailable(
                f"PaddleOCR sidecar health check was rejected with HTTP {error.code}"
            ) from error
        except (URLError, TimeoutError, OSError) as error:
            raise PaddleOCRUnavailable(f"PaddleOCR sidecar health check failed: {error}") from error
        if media_type != "application/json" or len(raw) > 16 * 1024:
            raise PaddleOCRProtocolError("PaddleOCR health response is invalid")
        try:
            document = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PaddleOCRProtocolError("PaddleOCR health response is invalid") from error
        if not isinstance(document, dict):
            raise PaddleOCRProtocolError("PaddleOCR health response has an invalid schema")
        status = document.get("status")
        allowed_languages = document.get("allowedLanguages")
        loaded_languages = document.get("loadedLanguages")
        allowed_root_ready = document.get("allowedRootReady")
        runtime_import_ready = document.get("runtimeImportReady")
        model_loaded = document.get("modelLoaded")
        if (
            document.get("schemaVersion") != SCHEMA_VERSION
            or document.get("engine") != "paddleocr"
            or status not in {"ok", "not_ready"}
            or not isinstance(allowed_languages, list)
            or not 0 < len(allowed_languages) <= 64
            or not isinstance(loaded_languages, list)
            or len(loaded_languages) > len(allowed_languages)
            or type(allowed_root_ready) is not bool
            or type(runtime_import_ready) is not bool
            or type(model_loaded) is not bool
        ):
            raise PaddleOCRProtocolError("PaddleOCR health response has an invalid schema")
        for values, context in (
            (allowed_languages, "allowedLanguages"),
            (loaded_languages, "loadedLanguages"),
        ):
            if (
                any(not isinstance(value, str) or not LANGUAGE.fullmatch(value) for value in values)
                or len(values) != len(set(values))
            ):
                raise PaddleOCRProtocolError(
                    f"PaddleOCR health response {context} is invalid"
                )
        if (
            not set(loaded_languages).issubset(set(allowed_languages))
            or model_loaded != bool(loaded_languages)
            or (status == "ok") != (allowed_root_ready and runtime_import_ready)
        ):
            raise PaddleOCRProtocolError("PaddleOCR health readiness flags are inconsistent")
        language_ready = requested_language in allowed_languages
        return {
            "status": status,
            "schemaVersion": SCHEMA_VERSION,
            "engine": "paddleocr",
            "ready": status == "ok" and language_ready,
            "allowedLanguages": list(allowed_languages),
            "allowedRootReady": allowed_root_ready,
            "runtimeImportReady": runtime_import_ready,
            "modelLoaded": model_loaded,
            "loadedLanguages": list(loaded_languages),
            "requestedLanguage": requested_language,
            "languageReady": language_ready,
        }

    def recognize_pages(
        self,
        page_images: Sequence[Path],
        base_pages: Sequence[Mapping[str, object]],
        language: str = "en",
    ) -> list[dict[str, object]]:
        if not self.configured:
            raise PaddleOCRUnavailable("CET_PADDLEOCR_URL is not configured")
        if not LANGUAGE.fullmatch(language):
            raise PaddleOCRError("PaddleOCR language is invalid")
        if len(page_images) != len(base_pages) or not 0 < len(page_images) <= MAX_PAGES:
            raise PaddleOCRError("PaddleOCR page images and metadata must have equal bounded lengths")

        image_sizes: list[tuple[int, int]] = []
        pages: list[dict[str, object]] = []
        try:
            shared_root = Path(self.shared_root).resolve(strict=True)
        except OSError as error:
            raise PaddleOCRError(f"PaddleOCR shared root is unavailable: {error}") from error
        if not shared_root.is_dir():
            raise PaddleOCRError("PaddleOCR shared root must be a directory")
        for index, (image, page) in enumerate(zip(page_images, base_pages)):
            try:
                resolved = Path(image).resolve(strict=True)
            except OSError as error:
                raise PaddleOCRError(f"PaddleOCR page image is unavailable: {error}") from error
            try:
                relative_image = resolved.relative_to(shared_root)
            except ValueError as error:
                raise PaddleOCRError("PaddleOCR page image is outside the configured shared root") from error
            pixel_width, pixel_height = _png_dimensions(resolved)
            try:
                page_number = int(page["number"])
            except (KeyError, TypeError, ValueError) as error:
                raise PaddleOCRError(f"base page {index} has no valid page number") from error
            page_width = _positive_number(page.get("width"), f"page {page_number} width")
            page_height = _positive_number(page.get("height"), f"page {page_number} height")
            image_sizes.append((pixel_width, pixel_height))
            pages.append(
                {
                    "pageNumber": page_number,
                    "imagePath": relative_image.as_posix(),
                    "imageWidth": pixel_width,
                    "imageHeight": pixel_height,
                    "pageWidth": page_width,
                    "pageHeight": page_height,
                }
            )

        body = json.dumps(
            {"schemaVersion": SCHEMA_VERSION, "language": language, "pages": pages},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "cet-reading-lab-paddle-adapter/1",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = Request(self.endpoint, data=body, headers=headers, method="POST")
        try:
            with urlopen(request, timeout=self.timeout_seconds) as response:
                media_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
                if media_type != "application/json":
                    raise PaddleOCRProtocolError("PaddleOCR sidecar returned a non-JSON response")
                raw_response = response.read(MAX_RESPONSE_BYTES + 1)
        except HTTPError as error:
            detail = error.read(4_096).decode("utf-8", "replace").strip()
            raise PaddleOCRError(
                f"PaddleOCR sidecar rejected the request with HTTP {error.code}: {detail[:500]}"
            ) from error
        except (URLError, TimeoutError, OSError) as error:
            raise PaddleOCRUnavailable(f"PaddleOCR sidecar is unavailable: {error}") from error
        if len(raw_response) > MAX_RESPONSE_BYTES:
            raise PaddleOCRProtocolError("PaddleOCR response exceeds the configured size limit")
        try:
            document = json.loads(raw_response.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PaddleOCRProtocolError("PaddleOCR sidecar returned invalid JSON") from error
        return convert_response_to_pages(document, base_pages, image_sizes)
