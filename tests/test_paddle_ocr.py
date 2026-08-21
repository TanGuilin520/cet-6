from __future__ import annotations

import json
import sys
import unittest
from http import HTTPStatus
from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType
from unittest.mock import Mock, patch

from server.paddle_ocr import (
    PaddleOCRClient,
    PaddleOCRError,
    PaddleOCRProtocolError,
    convert_response_to_pages,
)
from services.paddleocr.app import (
    PaddleOCRHandler,
    PaddleRuntime,
    RequestError,
    SidecarApplication,
    normalize_ocr_result,
)
from server.platform import PlatformError, _extract_document, _ocrmypdf_pages


class PaddleOCRAdapterTests(unittest.TestCase):
    @staticmethod
    def write_png_header(path: Path, width: int, height: int) -> None:
        path.write_bytes(
            b"\x89PNG\r\n\x1a\n"
            + b"\x00\x00\x00\rIHDR"
            + width.to_bytes(4, "big")
            + height.to_bytes(4, "big")
        )

    def test_client_sends_a_relative_posix_path_below_shared_root(self) -> None:
        captured = {}

        class FakeResponse:
            headers = {"Content-Type": "application/json; charset=utf-8"}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, limit):
                self.assert_limit = limit
                return json.dumps({
                    "schemaVersion": 1,
                    "engine": {"name": "paddleocr", "version": "3.7.0"},
                    "pages": [{
                        "pageNumber": 1,
                        "imageWidth": 1200,
                        "imageHeight": 1600,
                        "lines": [],
                    }],
                }).encode("utf-8")

        def fake_urlopen(request, timeout):
            captured["body"] = json.loads(request.data.decode("utf-8"))
            captured["timeout"] = timeout
            return FakeResponse()

        with TemporaryDirectory() as temporary:
            shared_root = Path(temporary)
            page = shared_root / "exam-1" / "work" / "page-1.png"
            page.parent.mkdir(parents=True)
            self.write_png_header(page, 1200, 1600)
            client = PaddleOCRClient(
                endpoint="http://127.0.0.1:8765/v1/ocr",
                shared_root=shared_root,
            )
            with patch("server.paddle_ocr.urlopen", side_effect=fake_urlopen):
                pages = client.recognize_pages(
                    [page],
                    [{"number": 1, "width": 600, "height": 800}],
                )

        self.assertEqual(captured["body"]["pages"][0]["imagePath"], "exam-1/work/page-1.png")
        self.assertFalse(Path(captured["body"]["pages"][0]["imagePath"]).is_absolute())
        self.assertEqual(pages[0]["words"], [])

    def test_client_rejects_an_image_outside_the_shared_root(self) -> None:
        with TemporaryDirectory() as shared_temporary, TemporaryDirectory() as outside_temporary:
            shared_root = Path(shared_temporary)
            outside = Path(outside_temporary) / "page.png"
            self.write_png_header(outside, 100, 100)
            client = PaddleOCRClient(
                endpoint="http://127.0.0.1:8765/v1/ocr",
                shared_root=shared_root,
            )
            with self.assertRaisesRegex(PaddleOCRError, "outside the configured shared root"):
                client.recognize_pages(
                    [outside],
                    [{"number": 1, "width": 50, "height": 50}],
                )

    def test_health_sends_token_and_reports_language_readiness(self) -> None:
        captured = {}

        class FakeResponse:
            headers = {"Content-Type": "application/json; charset=utf-8"}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, limit):
                return json.dumps({
                    "status": "ok",
                    "schemaVersion": 1,
                    "engine": "paddleocr",
                    "allowedLanguages": ["ch"],
                    "allowedRootReady": True,
                    "runtimeImportReady": True,
                    "modelLoaded": False,
                    "loadedLanguages": [],
                }).encode("utf-8")

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["headers"] = dict(request.header_items())
            captured["timeout"] = timeout
            return FakeResponse()

        client = PaddleOCRClient(
            endpoint="http://127.0.0.1:8765/v1/ocr",
            token="health-secret",
            language="en",
        )
        with patch("server.paddle_ocr.urlopen", side_effect=fake_urlopen):
            health = client.health(timeout_seconds=1.5)

        self.assertEqual(captured["url"], "http://127.0.0.1:8765/healthz")
        self.assertEqual(captured["headers"]["Authorization"], "Bearer health-secret")
        self.assertEqual(health["status"], "ok")
        self.assertFalse(health["ready"])
        self.assertFalse(health["languageReady"])
        self.assertEqual(health["requestedLanguage"], "en")
        self.assertEqual(health["allowedLanguages"], ["ch"])

    def test_health_rejects_inconsistent_readiness_flags(self) -> None:
        class FakeResponse:
            headers = {"Content-Type": "application/json"}

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self, limit):
                return json.dumps({
                    "status": "ok",
                    "schemaVersion": 1,
                    "engine": "paddleocr",
                    "allowedLanguages": ["en"],
                    "allowedRootReady": False,
                    "runtimeImportReady": True,
                    "modelLoaded": False,
                    "loadedLanguages": [],
                }).encode("utf-8")

        client = PaddleOCRClient(endpoint="http://127.0.0.1:8765/v1/ocr")
        with patch("server.paddle_ocr.urlopen", return_value=FakeResponse()):
            with self.assertRaisesRegex(PaddleOCRProtocolError, "inconsistent"):
                client.health()

    def test_word_boxes_are_scaled_into_existing_page_coordinates(self) -> None:
        response = {
            "schemaVersion": 1,
            "engine": {"name": "paddleocr", "version": "3.7.0"},
            "pages": [
                {
                    "pageNumber": 1,
                    "imageWidth": 1200,
                    "imageHeight": 1600,
                    "lines": [
                        {
                            "text": "Choose carefully",
                            "confidence": 0.96,
                            "box": [100, 200, 700, 260],
                            "words": [
                                {"text": "Choose", "box": [100, 200, 300, 260]},
                                {"text": "carefully", "box": [330, 200, 700, 260]},
                            ],
                        }
                    ],
                }
            ],
        }
        pages = convert_response_to_pages(
            response,
            [{"number": 1, "width": 600.0, "height": 800.0, "words": []}],
            [(1200, 1600)],
        )
        self.assertEqual([word["text"] for word in pages[0]["words"]], ["Choose", "carefully"])
        self.assertEqual(
            {key: pages[0]["words"][0][key] for key in ("x", "y", "width", "height")},
            {"x": 50.0, "y": 100.0, "width": 100.0, "height": 30.0},
        )
        self.assertEqual(pages[0]["words"][0]["ocrConfidence"], 0.96)
        self.assertEqual(pages[0]["words"][0]["ocrBoxSource"], "word-model")

    def test_line_only_result_is_tokenized_and_explicitly_marked_estimated(self) -> None:
        response = {
            "schemaVersion": 1,
            "engine": {"name": "paddleocr"},
            "pages": [
                {
                    "pageNumber": 2,
                    "imageWidth": 1000,
                    "imageHeight": 1000,
                    "lines": [
                        {
                            "text": "Why can't A work?",
                            "confidence": 0.8,
                            "box": [100, 100, 900, 200],
                            "words": [],
                        }
                    ],
                }
            ],
        }
        pages = convert_response_to_pages(
            response,
            [{"number": 2, "width": 500, "height": 500}],
            [(1000, 1000)],
        )
        self.assertEqual([word["text"] for word in pages[0]["words"]], ["Why", "can't", "A", "work", "?"])
        self.assertTrue(all(word["ocrBoxSource"] == "estimated-line" for word in pages[0]["words"]))

    def test_response_page_set_and_coordinates_are_strictly_validated(self) -> None:
        base = [{"number": 1, "width": 600, "height": 800}]
        missing = {"schemaVersion": 1, "engine": {"name": "paddleocr"}, "pages": []}
        with self.assertRaises(PaddleOCRProtocolError):
            convert_response_to_pages(missing, base, [(1200, 1600)])

        outside = {
            "schemaVersion": 1,
            "engine": {"name": "paddleocr"},
            "pages": [{
                "pageNumber": 1,
                "imageWidth": 1200,
                "imageHeight": 1600,
                "lines": [{
                    "text": "bad",
                    "confidence": 0.9,
                    "box": [0, 0, 1201, 10],
                    "words": [],
                }],
            }],
        }
        with self.assertRaises(PaddleOCRProtocolError):
            convert_response_to_pages(outside, base, [(1200, 1600)])


class PaddleOCRSidecarNormalizationTests(unittest.TestCase):
    @staticmethod
    def fake_runtime(
        *,
        import_ready: bool = True,
        languages: tuple[str, ...] = ("en", "ch"),
        loaded: tuple[str, ...] = (),
    ):
        runtime = Mock()
        runtime.runtime_import_ready = import_ready
        runtime.allowed_languages = frozenset(languages)
        runtime.loaded_languages = sorted(loaded)
        return runtime

    def test_runtime_import_probe_does_not_construct_a_model(self) -> None:
        fake_module = ModuleType("paddleocr")
        constructed = []

        class FakePaddleOCR:
            def __init__(self, **kwargs):
                constructed.append(kwargs)

        fake_module.PaddleOCR = FakePaddleOCR
        fake_module.__version__ = "test-version"
        with patch.dict(sys.modules, {"paddleocr": fake_module}):
            runtime = PaddleRuntime()

        self.assertTrue(runtime.runtime_import_ready)
        self.assertEqual(runtime.package_version, "test-version")
        self.assertEqual(constructed, [])

    def test_health_reports_mount_import_and_model_state(self) -> None:
        with TemporaryDirectory() as temporary:
            ready = SidecarApplication(
                Path(temporary),
                runtime=self.fake_runtime(loaded=("en",)),
            ).health_document()
            missing = SidecarApplication(
                Path(temporary) / "missing",
                runtime=self.fake_runtime(),
            ).health_document()
            import_failed = SidecarApplication(
                Path(temporary),
                runtime=self.fake_runtime(import_ready=False),
            ).health_document()

        self.assertEqual(ready["status"], "ok")
        self.assertEqual(ready["allowedLanguages"], ["ch", "en"])
        self.assertTrue(ready["allowedRootReady"])
        self.assertTrue(ready["runtimeImportReady"])
        self.assertTrue(ready["modelLoaded"])
        self.assertEqual(ready["loadedLanguages"], ["en"])
        self.assertEqual(missing["status"], "not_ready")
        self.assertFalse(missing["allowedRootReady"])
        self.assertEqual(import_failed["status"], "not_ready")
        self.assertFalse(import_failed["runtimeImportReady"])

    def test_protected_health_endpoint_requires_the_same_bearer_token(self) -> None:
        with TemporaryDirectory() as temporary:
            application = SidecarApplication(
                Path(temporary),
                token="sidecar-secret",
                runtime=self.fake_runtime(),
            )
            handler = object.__new__(PaddleOCRHandler)
            handler.path = "/healthz"
            handler.headers = {}
            handler._json = Mock()
            with patch("services.paddleocr.app.APPLICATION", application):
                handler.do_GET()
                handler._json.assert_called_once_with(
                    HTTPStatus.UNAUTHORIZED,
                    {"error": "unauthorized"},
                )

                handler.headers = {"Authorization": "Bearer sidecar-secret"}
                handler._json.reset_mock()
                handler.do_GET()
                status, document = handler._json.call_args.args

        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(document["status"], "ok")

    def test_sidecar_accepts_only_relative_paths_below_shared_root(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            page = root / "page.png"
            page.write_bytes(b"not decoded in this path validation test")
            application = SidecarApplication(root, runtime=self.fake_runtime())
            self.assertEqual(application.image_path("page.png"), page)
            with self.assertRaises(RequestError):
                application.image_path(str(page))
            with self.assertRaises(RequestError):
                application.image_path("../outside.png")

    def test_nested_paddlex_word_result_is_normalized(self) -> None:
        raw = {
            "res": {
                "rec_texts": ["Read this"],
                "rec_scores": [0.91],
                "rec_boxes": [[10, 20, 210, 60]],
                "text_word": [["Read", "this"]],
                "text_word_boxes": [[[10, 20, 90, 60], [100, 20, 210, 60]]],
            }
        }
        lines = normalize_ocr_result(raw, 400, 300)
        self.assertEqual(lines[0]["text"], "Read this")
        self.assertEqual(lines[0]["words"][1], {"text": "this", "box": [100.0, 20.0, 210.0, 60.0]})

    def test_mismatched_paddle_arrays_are_not_silently_truncated(self) -> None:
        raw = {"res": {"rec_texts": ["one"], "rec_scores": [], "rec_boxes": [[1, 1, 2, 2]]}}
        with self.assertRaises(RuntimeError):
            normalize_ocr_result(raw, 10, 10)

        partial_words = {
            "res": {
                "rec_texts": ["one"],
                "rec_scores": [0.9],
                "rec_boxes": [[1, 1, 8, 8]],
                "text_word": [["one"]],
            }
        }
        with self.assertRaises(RuntimeError):
            normalize_ocr_result(partial_words, 10, 10)


class PaddleOCRPipelineRoutingTests(unittest.TestCase):
    @staticmethod
    def page(number: int, word_count: int) -> dict[str, object]:
        return {
            "number": number,
            "width": 600.0,
            "height": 800.0,
            "words": [
                {
                    "id": index,
                    "line": index,
                    "text": f"word{index}",
                    "x": 10.0,
                    "y": 20.0 + index * 10,
                    "width": 30.0,
                    "height": 8.0,
                }
                for index in range(word_count)
            ],
        }

    def test_scanned_document_prefers_configured_paddle_sidecar(self) -> None:
        scanned = self.page(1, 0)
        recognized = self.page(1, 8)

        class FakeClient:
            configured = True

            def recognize_pages(self, images, pages, language="en"):
                self.request = (images, pages, language)
                return [recognized]

        fake_client = FakeClient()
        with TemporaryDirectory() as temporary, \
             patch("server.platform._extract_bbox_pdf", return_value=[scanned]), \
             patch("server.platform._render_ocr_page_images", return_value=[Path(temporary) / "page.png"]), \
             patch("server.platform.PaddleOCRClient.from_environment", return_value=fake_client):
            pages, source = _extract_document(
                Path(temporary) / "paper.pdf",
                Path(temporary),
                "paper",
            )

        self.assertEqual(source, "paddleocr")
        self.assertEqual(len(pages[0]["words"]), 8)

    def test_sparse_page_is_filled_without_replacing_native_text_pages(self) -> None:
        native = self.page(1, 8)
        sparse = self.page(2, 0)
        recognized_sparse = self.page(2, 4)

        class FakeClient:
            configured = True

            def recognize_pages(self, images, pages, language="en"):
                self.requested_numbers = [int(page["number"]) for page in pages]
                return [recognized_sparse]

        fake_client = FakeClient()
        with TemporaryDirectory() as temporary, \
             patch("server.platform._extract_bbox_pdf", return_value=[native, sparse]), \
             patch("server.platform._render_ocr_page_images", return_value=[Path(temporary) / "page-2.png"]), \
             patch("server.platform.PaddleOCRClient.from_environment", return_value=fake_client):
            pages, source = _extract_document(
                Path(temporary) / "mixed.pdf",
                Path(temporary),
                "mixed",
            )

        self.assertEqual(source, "pdf_text+paddleocr")
        self.assertEqual(fake_client.requested_numbers, [2])
        self.assertEqual(pages[0]["words"], native["words"])
        self.assertEqual(pages[1]["words"], recognized_sparse["words"])

    def test_mixed_pdf_continues_from_failed_paddle_and_ocrmypdf_to_tesseract(self) -> None:
        native = self.page(1, 8)
        sparse = self.page(2, 0)
        recognized_sparse = self.page(2, 5)

        class FakeClient:
            configured = True

        def installed(command):
            return f"/usr/bin/{command}" if command in {"ocrmypdf", "tesseract"} else None

        with TemporaryDirectory() as temporary, \
             patch("server.platform._extract_bbox_pdf", return_value=[native, sparse]), \
             patch("server.platform.PaddleOCRClient.from_environment", return_value=FakeClient()), \
             patch("server.platform._paddleocr_pages", side_effect=PaddleOCRError("sidecar failed")), \
             patch("server.platform._ocrmypdf_pages", side_effect=PlatformError("ocrmypdf failed")), \
             patch("server.platform._tesseract_pages", return_value=[recognized_sparse]) as tesseract, \
             patch("server.platform.shutil.which", side_effect=installed):
            pages, source = _extract_document(
                Path(temporary) / "mixed.pdf",
                Path(temporary),
                "mixed",
            )

        self.assertEqual(source, "pdf_text+tesseract")
        self.assertEqual(pages[0]["words"], native["words"])
        self.assertEqual(pages[0]["extractionSource"], "pdf_text")
        self.assertEqual(pages[1]["words"], recognized_sparse["words"])
        self.assertEqual(pages[1]["extractionSource"], "tesseract")
        self.assertEqual([item["number"] for item in tesseract.call_args.args[1]], [2])

    def test_full_scan_falls_back_to_tesseract_when_ocrmypdf_fails(self) -> None:
        scanned = self.page(1, 0)
        recognized = self.page(1, 8)

        class FakeClient:
            configured = False

        def installed(command):
            return f"/usr/bin/{command}" if command in {"ocrmypdf", "tesseract"} else None

        with TemporaryDirectory() as temporary, \
             patch("server.platform._extract_bbox_pdf", return_value=[scanned]), \
             patch("server.platform.PaddleOCRClient.from_environment", return_value=FakeClient()), \
             patch("server.platform._ocrmypdf_pages", side_effect=PlatformError("ocrmypdf failed")), \
             patch("server.platform._tesseract_pages", return_value=[recognized]), \
             patch("server.platform.shutil.which", side_effect=installed):
            pages, source = _extract_document(
                Path(temporary) / "scan.pdf",
                Path(temporary),
                "scan",
            )

        self.assertEqual(source, "tesseract")
        self.assertEqual(pages[0]["extractionSource"], "tesseract")

    def test_ocrmypdf_keeps_original_page_geometry(self) -> None:
        captured = {}

        def fake_run(command, timeout, message):
            captured["command"] = command

        with TemporaryDirectory() as temporary, \
             patch("server.platform.shutil.which", return_value="/usr/bin/ocrmypdf"), \
             patch("server.platform._run", side_effect=fake_run), \
             patch("server.platform._extract_bbox_pdf", return_value=[self.page(1, 8)]):
            _ocrmypdf_pages(
                Path(temporary) / "scan.pdf",
                Path(temporary),
                "scan",
                skip_text=True,
            )

        self.assertIn("--skip-text", captured["command"])
        self.assertNotIn("--deskew", captured["command"])
        self.assertNotIn("--rotate-pages", captured["command"])


if __name__ == "__main__":
    unittest.main()
