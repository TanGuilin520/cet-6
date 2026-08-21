#!/usr/bin/env python3
"""Bounded HTTP sidecar for PaddleOCR 3.x.

The service accepts relative paths under one explicitly allowed shared
directory. It never fetches URLs or writes into the main application's exam data.
PaddleOCR is imported lazily so protocol tests do not require ML dependencies.
"""

from __future__ import annotations

import argparse
import hmac
import json
import math
import os
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable


SCHEMA_VERSION = 1
MAX_REQUEST_BYTES = 512 * 1024
MAX_PAGES = 200
MAX_IMAGE_BYTES = 64 * 1024 * 1024
MAX_IMAGE_DIMENSION = 65_535
MAX_IMAGE_PIXELS = 100_000_000
MAX_TEXT_CHARS = 2_000
MAX_LINES_PER_PAGE = 20_000
LANGUAGE_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_+-")


class RequestError(ValueError):
    """A client-visible request validation error."""


def _plain(value: Any) -> Any:
    """Convert numpy-like values from Paddle result objects to JSON types."""

    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    to_list = getattr(value, "tolist", None)
    if callable(to_list):
        return _plain(to_list())
    item = getattr(value, "item", None)
    if callable(item):
        return _plain(item())
    return value


def _finite(value: Any, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeError(f"{context} is not numeric")
    result = float(value)
    if not math.isfinite(result):
        raise RuntimeError(f"{context} is not finite")
    return result


def _rect(value: Any, width: int, height: int, context: str) -> list[float]:
    value = _plain(value)
    if not isinstance(value, list):
        raise RuntimeError(f"{context} is not a coordinate list")
    if len(value) == 4 and all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value):
        x_min, y_min, x_max, y_max = (_finite(item, context) for item in value)
    elif len(value) >= 4 and all(isinstance(point, list) and len(point) == 2 for point in value):
        xs = [_finite(point[0], context) for point in value]
        ys = [_finite(point[1], context) for point in value]
        x_min, y_min, x_max, y_max = min(xs), min(ys), max(xs), max(ys)
    else:
        raise RuntimeError(f"{context} is not a rectangle or polygon")
    if (
        x_min < 0
        or y_min < 0
        or x_max <= x_min
        or y_max <= y_min
        or x_max > width
        or y_max > height
    ):
        raise RuntimeError(f"{context} lies outside the image")
    return [x_min, y_min, x_max, y_max]


def _png_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as image:
        header = image.read(24)
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise RequestError("only PNG page images are accepted")
    width = int.from_bytes(header[16:20], "big")
    height = int.from_bytes(header[20:24], "big")
    if (
        not 0 < width <= MAX_IMAGE_DIMENSION
        or not 0 < height <= MAX_IMAGE_DIMENSION
        or width * height > MAX_IMAGE_PIXELS
    ):
        raise RequestError("page image dimensions are invalid")
    return width, height


def _result_payload(result: Any) -> dict[str, Any]:
    value = getattr(result, "json", result)
    if callable(value):
        value = value()
    value = _plain(value)
    if not isinstance(value, dict):
        raise RuntimeError("PaddleOCR returned a non-object result")
    nested = value.get("res")
    if isinstance(nested, dict):
        value = nested
    return value


def normalize_ocr_result(result: Any, image_width: int, image_height: int) -> list[dict[str, Any]]:
    """Normalize one PaddleOCR Result into the stable sidecar line contract."""

    payload = _result_payload(result)
    texts = _plain(payload.get("rec_texts", []))
    scores = _plain(payload.get("rec_scores", []))
    boxes = _plain(payload.get("rec_boxes", payload.get("rec_polys", [])))
    if not isinstance(texts, list) or not isinstance(scores, list) or not isinstance(boxes, list):
        raise RuntimeError("PaddleOCR line results have invalid types")
    if not (len(texts) == len(scores) == len(boxes)):
        raise RuntimeError("PaddleOCR line result lengths do not match")
    if len(texts) > MAX_LINES_PER_PAGE:
        raise RuntimeError("PaddleOCR returned too many lines")

    has_word_texts = "text_word" in payload
    has_word_boxes = "text_word_boxes" in payload
    if has_word_texts != has_word_boxes:
        raise RuntimeError("PaddleOCR returned only half of the word-box result")
    all_word_texts = _plain(payload.get("text_word", []))
    all_word_boxes = _plain(payload.get("text_word_boxes", []))
    has_word_results = has_word_texts and has_word_boxes
    if has_word_results and (
        not isinstance(all_word_texts, list)
        or not isinstance(all_word_boxes, list)
        or len(all_word_texts) != len(texts)
        or len(all_word_boxes) != len(texts)
    ):
        raise RuntimeError("PaddleOCR word result lengths do not match line results")

    lines: list[dict[str, Any]] = []
    for index, (raw_text, raw_score, raw_box) in enumerate(zip(texts, scores, boxes)):
        if not isinstance(raw_text, str):
            raise RuntimeError(f"PaddleOCR line {index} text is invalid")
        text = raw_text.strip()
        if not text:
            continue
        if len(text) > MAX_TEXT_CHARS:
            raise RuntimeError(f"PaddleOCR line {index} text is too long")
        confidence = _finite(raw_score, f"line {index} confidence")
        if not 0 <= confidence <= 1:
            raise RuntimeError(f"line {index} confidence is outside 0..1")
        line: dict[str, Any] = {
            "text": text,
            "confidence": confidence,
            "box": _rect(raw_box, image_width, image_height, f"line {index} box"),
            "words": [],
        }
        if has_word_results:
            word_texts = all_word_texts[index]
            word_boxes = all_word_boxes[index]
            if not isinstance(word_texts, list) or not isinstance(word_boxes, list):
                raise RuntimeError(f"PaddleOCR word result {index} is invalid")
            if len(word_texts) != len(word_boxes):
                raise RuntimeError(f"PaddleOCR word result {index} lengths do not match")
            for word_index, (raw_word, raw_word_box) in enumerate(zip(word_texts, word_boxes)):
                if not isinstance(raw_word, str):
                    raise RuntimeError(f"PaddleOCR word {index}:{word_index} text is invalid")
                word = raw_word.strip()
                if not word:
                    continue
                if len(word) > 500:
                    raise RuntimeError(f"PaddleOCR word {index}:{word_index} is too long")
                line["words"].append(
                    {
                        "text": word,
                        "box": _rect(
                            raw_word_box,
                            image_width,
                            image_height,
                            f"word {index}:{word_index} box",
                        ),
                    }
                )
        lines.append(line)
    return lines


class PaddleRuntime:
    """Import-checked, lazily cached PaddleOCR models keyed by language.

    Importing the package at service startup verifies that the installed
    Paddle/PaddleOCR runtime is usable, but does not construct a model and does
    not download model data.  Model construction stays lazy on the first OCR
    request.
    """

    def __init__(self) -> None:
        configured = os.environ.get("PADDLEOCR_ALLOWED_LANGS", "en,ch")
        self.allowed_languages = frozenset(item.strip() for item in configured.split(",") if item.strip())
        if not self.allowed_languages:
            raise RuntimeError("PADDLEOCR_ALLOWED_LANGS must contain at least one language")
        if any(
            len(language) > 32 or any(character not in LANGUAGE_CHARS for character in language)
            for language in self.allowed_languages
        ):
            raise RuntimeError("PADDLEOCR_ALLOWED_LANGS contains an invalid language")
        self.device = os.environ.get("PADDLEOCR_DEVICE", "cpu").strip() or "cpu"
        self.ocr_version = os.environ.get("PADDLEOCR_OCR_VERSION", "").strip()
        self._models: dict[str, Any] = {}
        self._lock = threading.RLock()
        self.package_version = "unavailable"
        self.runtime_import_ready = False
        self.runtime_import_error = ""
        self._paddle_ocr_class: Any = None
        self._probe_runtime_import()

    def _probe_runtime_import(self) -> None:
        """Verify imports without instantiating PaddleOCR or loading a model."""

        try:
            from paddleocr import PaddleOCR, __version__
        except Exception as error:
            self.runtime_import_error = type(error).__name__
            return
        self._paddle_ocr_class = PaddleOCR
        self.package_version = str(__version__)
        self.runtime_import_ready = True

    @property
    def loaded_languages(self) -> list[str]:
        with self._lock:
            return sorted(self._models)

    def _model(self, language: str) -> Any:
        model = self._models.get(language)
        if model is not None:
            return model
        if not self.runtime_import_ready or self._paddle_ocr_class is None:
            raise RuntimeError("PaddleOCR runtime import is unavailable")

        kwargs: dict[str, Any] = {
            "lang": language,
            "device": self.device,
            "use_doc_orientation_classify": False,
            "use_doc_unwarping": False,
            "use_textline_orientation": False,
            "return_word_box": True,
        }
        if self.ocr_version:
            kwargs["ocr_version"] = self.ocr_version
        model = self._paddle_ocr_class(**kwargs)
        self._models[language] = model
        return model

    def recognize(self, image_path: Path, language: str) -> Any:
        if language not in self.allowed_languages:
            raise RequestError(f"language {language!r} is not enabled by this sidecar")
        with self._lock:
            model = self._model(language)
            try:
                results = list(model.predict(str(image_path), return_word_box=True))
            except KeyError as error:
                # PaddleOCR 3.2 had a documented empty-page bug where word-box
                # output omitted text_word_region.  Retrying without word boxes
                # produces a valid empty/line-only response instead of failing
                # the whole uploaded exam.
                if str(error).strip("'") != "text_word_region":
                    raise
                results = list(model.predict(str(image_path), return_word_box=False))
        if len(results) > 1:
            raise RuntimeError("one page image produced multiple PaddleOCR results")
        return results[0] if results else {"rec_texts": [], "rec_scores": [], "rec_boxes": []}


class SidecarApplication:
    def __init__(
        self,
        allowed_root: Path,
        token: str = "",
        runtime: PaddleRuntime | None = None,
    ) -> None:
        try:
            self.allowed_root = allowed_root.resolve(strict=False)
        except (OSError, RuntimeError) as error:
            raise RuntimeError("PADDLEOCR_ALLOWED_ROOT is invalid") from error
        self.token = token
        self.runtime = runtime if runtime is not None else PaddleRuntime()

    @property
    def allowed_root_ready(self) -> bool:
        """Whether the shared mount exists and this process can traverse it."""

        try:
            return (
                self.allowed_root.is_dir()
                and os.access(self.allowed_root, os.R_OK | os.X_OK)
            )
        except OSError:
            return False

    def health_document(self) -> dict[str, Any]:
        allowed_root_ready = self.allowed_root_ready
        runtime_import_ready = bool(self.runtime.runtime_import_ready)
        loaded_languages = list(self.runtime.loaded_languages)
        return {
            "status": "ok" if allowed_root_ready and runtime_import_ready else "not_ready",
            "schemaVersion": SCHEMA_VERSION,
            "engine": "paddleocr",
            "allowedLanguages": sorted(self.runtime.allowed_languages),
            "allowedRootReady": allowed_root_ready,
            "runtimeImportReady": runtime_import_ready,
            "modelLoaded": bool(loaded_languages),
            "loadedLanguages": loaded_languages,
        }

    def authorize(self, authorization: str) -> bool:
        if not self.token:
            return True
        prefix = "Bearer "
        if not authorization.startswith(prefix):
            return False
        return hmac.compare_digest(authorization[len(prefix):], self.token)

    def image_path(self, value: Any) -> Path:
        if not isinstance(value, str) or not value or "\x00" in value:
            raise RequestError("imagePath must be a non-empty path")
        raw_path = Path(value)
        if raw_path.is_absolute():
            raise RequestError("imagePath must be relative to PADDLEOCR_ALLOWED_ROOT")
        try:
            path = (self.allowed_root / raw_path).resolve(strict=True)
            path.relative_to(self.allowed_root)
        except (OSError, RuntimeError, ValueError) as error:
            raise RequestError("imagePath is outside PADDLEOCR_ALLOWED_ROOT or does not exist") from error
        if not path.is_file() or path.stat().st_size > MAX_IMAGE_BYTES:
            raise RequestError("page image is not a bounded regular file")
        return path

    def process(self, document: Any) -> dict[str, Any]:
        if not isinstance(document, dict) or document.get("schemaVersion") != SCHEMA_VERSION:
            raise RequestError("unsupported request schema")
        language = document.get("language")
        if (
            not isinstance(language, str)
            or not language
            or len(language) > 32
            or any(character not in LANGUAGE_CHARS for character in language)
        ):
            raise RequestError("language is invalid")
        if language not in self.runtime.allowed_languages:
            raise RequestError(f"language {language!r} is not enabled by this sidecar")
        pages = document.get("pages")
        if not isinstance(pages, list) or not 0 < len(pages) <= MAX_PAGES:
            raise RequestError("pages must be a non-empty bounded list")

        page_numbers: set[int] = set()
        response_pages: list[dict[str, Any]] = []
        for index, page in enumerate(pages):
            if not isinstance(page, dict):
                raise RequestError(f"page {index} must be an object")
            page_number = page.get("pageNumber")
            if isinstance(page_number, bool) or not isinstance(page_number, int) or page_number <= 0:
                raise RequestError(f"page {index} number is invalid")
            if page_number in page_numbers:
                raise RequestError("page numbers must be unique")
            page_numbers.add(page_number)
            image = self.image_path(page.get("imagePath"))
            width, height = _png_dimensions(image)
            supplied_width = page.get("imageWidth")
            supplied_height = page.get("imageHeight")
            if (
                isinstance(supplied_width, bool)
                or isinstance(supplied_height, bool)
                or not isinstance(supplied_width, int)
                or not isinstance(supplied_height, int)
                or supplied_width != width
                or supplied_height != height
            ):
                raise RequestError(f"page {page_number} dimensions do not match the PNG")
            for field in ("pageWidth", "pageHeight"):
                value = page.get(field)
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                    raise RequestError(f"page {page_number} {field} is invalid")
            result = self.runtime.recognize(image, language)
            response_pages.append(
                {
                    "pageNumber": page_number,
                    "imageWidth": width,
                    "imageHeight": height,
                    "lines": normalize_ocr_result(result, width, height),
                }
            )
        return {
            "schemaVersion": SCHEMA_VERSION,
            "engine": {
                "name": "paddleocr",
                "version": self.runtime.package_version,
                "ocrVersion": self.runtime.ocr_version or "default",
                "geometryPreprocessing": False,
            },
            "pages": response_pages,
        }


APPLICATION: SidecarApplication | None = None


class PaddleOCRHandler(BaseHTTPRequestHandler):
    server_version = "PaddleOCRSidecar/1"

    def log_message(self, format: str, *args: Any) -> None:
        super().log_message(format, *args)

    def _json(self, status: HTTPStatus, body: dict[str, Any]) -> None:
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/healthz":
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        assert APPLICATION is not None
        if not APPLICATION.authorize(self.headers.get("Authorization", "")):
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        self._json(HTTPStatus.OK, APPLICATION.health_document())

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/ocr":
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        assert APPLICATION is not None
        if not APPLICATION.authorize(self.headers.get("Authorization", "")):
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        media_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if media_type != "application/json":
            self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "Content-Type must be application/json"})
            return
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._json(HTTPStatus.LENGTH_REQUIRED, {"error": "valid Content-Length is required"})
            return
        if not 0 < length <= MAX_REQUEST_BYTES:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "request is empty or too large"})
            return
        raw = self.rfile.read(length)
        if len(raw) != length:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "incomplete request body"})
            return
        try:
            document = json.loads(raw.decode("utf-8"))
            response = APPLICATION.process(document)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json(HTTPStatus.BAD_REQUEST, {"error": "request body is not valid UTF-8 JSON"})
            return
        except RequestError as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        except Exception as error:
            self.log_error("PaddleOCR inference failed: %s", error)
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "PaddleOCR inference failed"})
            return
        self._json(HTTPStatus.OK, response)


def main(argv: Iterable[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Run the CET PaddleOCR sidecar")
    parser.add_argument("--host", default=os.environ.get("PADDLEOCR_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PADDLEOCR_PORT", "8765")))
    parser.add_argument(
        "--allowed-root",
        default=os.environ.get("PADDLEOCR_ALLOWED_ROOT", ""),
        help="Only PNG paths below this shared directory may be processed",
    )
    args = parser.parse_args(argv)
    if not args.allowed_root:
        parser.error("--allowed-root or PADDLEOCR_ALLOWED_ROOT is required")
    global APPLICATION
    APPLICATION = SidecarApplication(Path(args.allowed_root), os.environ.get("PADDLEOCR_TOKEN", ""))
    server = ThreadingHTTPServer((args.host, args.port), PaddleOCRHandler)
    print(f"PaddleOCR sidecar listening on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
