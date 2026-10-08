from __future__ import annotations

import hashlib
import io
import json
import unittest
from http import HTTPStatus
from http.client import IncompleteRead
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import Request

import server.learning_methods as methods


# Original short fixtures, not a vendored copy of the user's course document.
STUDY_SOURCE = (
    "# 我的翻译学习总结\n\n"
    "## 1“是”字结构\n"
    "### 注意\n保留原句与我的学习提醒。\n"
    "### 例句\nAs a learner, I keep a notebook.\n\n"
    "## 4 “随着”结构\n"
    "### 类型一\nWith practice, my writing improves.\n"
    "### 类型二\nAs I practice, my writing improves.\n\n"
    "## 9 两大必考时态\n"
    "I have studied this method.\n\n"
    "## 18 关于各种时间朝代的翻译\n"
    "Read the date carefully.\n"
)


class ContractHandler:
    def __init__(self, body: bytes = b"{}", *, same_origin: bool = True, headers=None) -> None:
        self.headers = {
            "Content-Type": "application/json",
            "Content-Length": str(len(body)),
            **(headers or {}),
        }
        self.rfile = io.BytesIO(body)
        self.responses: list[tuple[object, object, bool]] = []
        self.same_origin = same_origin

    def _request_is_same_origin(self) -> bool:
        return self.same_origin

    def _json_response(self, status, body, include_body=True, **kwargs) -> None:
        self.responses.append((status, body, include_body))


class PublicResponse(io.BytesIO):
    def __init__(self, body: bytes, *, url=methods.SOURCE_RAW_URL, headers=None, status=200) -> None:
        super().__init__(body)
        self.url = url
        self.headers = headers or {}
        self.status = status

    def geturl(self):
        return self.url

    def getcode(self):
        return self.status


class TranslationSectionTests(unittest.TestCase):
    def test_actual_numbered_h2_shape_keeps_original_examples(self) -> None:
        cards = methods.parse_translation_markdown(STUDY_SOURCE)
        self.assertEqual(len(cards), 4)
        self.assertEqual(cards[0]["title"], "1“是”字结构")
        self.assertEqual(cards[1]["id"], "cet6-translation-section-04")
        self.assertEqual(cards[-1]["id"], "cet6-translation-section-18")
        self.assertEqual(cards[0]["bodyMarkdown"], "### 注意\n保留原句与我的学习提醒。\n### 例句\nAs a learner, I keep a notebook.")
        self.assertIn("With practice, my writing improves.", cards[1]["bodyMarkdown"])
        self.assertIn("随着", cards[1]["keywords"])
        self.assertEqual(cards[2]["category"], "时态语态")
        self.assertEqual(cards[-1]["category"], "数字与时间")

    def test_full_18_chapters_does_not_invent_readme_19th(self) -> None:
        document = "# 学习资料\n" + "\n".join(f"## {number}.方法{number}\n保留这一节的说明。" for number in range(1, 19))
        cards = methods.parse_translation_markdown(document)
        self.assertEqual(len(cards), 18)
        self.assertNotIn("cet6-translation-section-19", [card["id"] for card in cards])

    def test_h1_chapter_style_and_h2_numbered_shapes(self) -> None:
        document = "# 第1节 结构\n第一节原文。\n## 2.句式\n第二节原文。\n## 3．语序\n第三节原文。\n## 4、数字\n第四节原文。"
        self.assertEqual(len(methods.parse_translation_markdown(document)), 4)

    def test_fenced_and_h3_headings_remain_inside_chapter(self) -> None:
        document = "## 1结构\n```md\n## 2伪标题\n~~~\n## 3伪标题\n```\n### 4类型\n内容\n## 5语序\n最后说明。"
        cards = methods.parse_translation_markdown(document)
        self.assertEqual([card["id"] for card in cards], ["cet6-translation-section-01", "cet6-translation-section-05"])
        self.assertIn("## 2伪标题", cards[0]["bodyMarkdown"])
        self.assertIn("### 4类型", cards[0]["bodyMarkdown"])

    def test_missing_numbers_are_not_filled_and_numeric_only_heading_not_guessed(self) -> None:
        document = "## 1结构\n笔记。\n## 19\n仅数字不是章节标题。\n## 5句式\n笔记。"
        cards = methods.parse_translation_markdown(document)
        self.assertEqual([card["id"] for card in cards], ["cet6-translation-section-01", "cet6-translation-section-05"])
        self.assertIn("## 19", cards[0]["bodyMarkdown"])

    def test_empty_duplicate_zero_or_unsupported_document_rejected(self) -> None:
        for document in ("## 1结构\n", "## 1结构\n内容\n## 1重复\n内容", "## 0结构\n内容", "# 无章节\n只有介绍", "## 1结构\n含\x00内容"):
            with self.subTest(document=document):
                with self.assertRaises(methods.LearningMethodsError):
                    methods.parse_translation_markdown(document)


class LearningMethodsCacheTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.directory = Path(self.temporary.name) / "learning-methods"
        self.service = methods.LearningMethodsService(self.directory)
        self.download = mock.patch.object(methods, "_download_source", side_effect=AssertionError("unexpected network"))
        self.download_mock = self.download.start()

    def tearDown(self) -> None:
        self.download.stop()
        self.temporary.cleanup()

    def import_fixture(self) -> dict[str, object]:
        with mock.patch.object(methods, "_download_source", return_value=STUDY_SOURCE.encode("utf-8")):
            return self.service.refresh()

    def test_missing_get_is_read_only_and_never_network(self) -> None:
        document = self.service.cached_document()
        self.assertEqual(document["status"], "not_imported")
        self.assertEqual(document["cards"], [])
        self.assertFalse(self.directory.exists())
        self.download_mock.assert_not_called()

    def test_refresh_records_source_hash_attribution_and_caches_private_original(self) -> None:
        document = self.import_fixture()
        self.assertEqual(document["status"], "ready")
        self.assertEqual(document["count"], 4)
        self.assertEqual(document["source"]["sha256"], hashlib.sha256(STUDY_SOURCE.encode("utf-8")).hexdigest())
        self.assertEqual(document["source"]["kind"], "personal_notes")
        self.assertEqual(document["source"]["attribution"], methods.ATTRIBUTION)
        self.assertIn("不是官方", document["source"]["caution"])
        self.assertIn("sourceMarkdown", json.loads(self.service.cache_path.read_text(encoding="utf-8")))
        self.assertNotIn("sourceMarkdown", document)
        self.assertEqual(self.service.cached_document(), document)
        self.assertEqual(list(self.directory.iterdir()), [self.service.cache_path])

    def test_failed_refresh_never_replaces_good_cache(self) -> None:
        original = self.import_fixture()
        original_bytes = self.service.cache_path.read_bytes()
        bad_cases = [
            methods.LearningMethodsError("下载失败", HTTPStatus.BAD_GATEWAY),
            b"\xff\xfe\x01",
            b"",
            b"# No chapters",
            b"a" * (methods.MAX_SOURCE_BYTES + 1),
        ]
        for bad in bad_cases:
            with self.subTest(bad_type=type(bad).__name__):
                arguments = {"side_effect": bad} if isinstance(bad, Exception) else {"return_value": bad}
                with mock.patch.object(methods, "_download_source", **arguments):
                    with self.assertRaises(methods.LearningMethodsError):
                        self.service.refresh()
                self.assertEqual(self.service.cache_path.read_bytes(), original_bytes)
                self.assertEqual(self.service.cached_document(), original)

    def test_atomic_replace_failure_keeps_old_and_removes_temp(self) -> None:
        original = self.import_fixture()
        with mock.patch.object(methods, "_download_source", return_value=STUDY_SOURCE.replace("我的", "更新的").encode("utf-8")), mock.patch.object(methods.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(methods.LearningMethodsError) as raised:
                self.service.refresh()
        self.assertEqual(raised.exception.code, "cache_write_failed")
        self.assertEqual(self.service.cached_document(), original)
        self.assertEqual(list(self.directory.iterdir()), [self.service.cache_path])

    def test_corrupt_cache_is_not_rewritten_or_used(self) -> None:
        self.directory.mkdir()
        self.service.cache_path.write_bytes(b"\xffnot-json")
        before = self.service.cache_path.read_bytes()
        document = self.service.cached_document()
        self.assertEqual(document["status"], "not_imported")
        self.assertEqual(document["errorCode"], "cache_unavailable")
        self.assertEqual(self.service.cache_path.read_bytes(), before)
        self.download_mock.assert_not_called()

    def test_oversized_cache_is_bounded_and_not_rewritten(self) -> None:
        self.directory.mkdir()
        self.service.cache_path.write_bytes(b"x" * (methods.MAX_CACHE_BYTES + 1))
        self.assertEqual(self.service.cached_document()["status"], "not_imported")
        self.assertEqual(self.service.cache_path.stat().st_size, methods.MAX_CACHE_BYTES + 1)

    def test_tampered_source_or_hash_is_rejected_and_ui_metadata_is_fixed(self) -> None:
        self.import_fixture()
        document = json.loads(self.service.cache_path.read_text(encoding="utf-8"))
        for changes in ({"rawUrl": "http://127.0.0.1/private"}, {"sha256": "0" * 64}, {"fetchedAt": "not-a-date"}):
            changed = {**document, "source": {**document["source"], **changes}}
            self.service.cache_path.write_text(json.dumps(changed), encoding="utf-8")
            self.assertEqual(self.service.cached_document()["status"], "not_imported")
        changed = {**document, "source": {**document["source"], "attribution": "fake", "kind": "official"}, "cards": [{"title": "fake"}]}
        self.service.cache_path.write_text(json.dumps(changed), encoding="utf-8")
        trusted = self.service.cached_document()
        self.assertEqual(trusted["source"]["kind"], "personal_notes")
        self.assertEqual(trusted["source"]["attribution"], methods.ATTRIBUTION)
        self.assertEqual(trusted["cards"][0]["title"], "1“是”字结构")

    def test_concurrent_refresh_returns_conflict_without_network(self) -> None:
        self.service._refresh_lock.acquire()
        try:
            with self.assertRaises(methods.LearningMethodsError) as raised:
                self.service.refresh()
            self.assertEqual(raised.exception.status, HTTPStatus.CONFLICT)
            self.download_mock.assert_not_called()
        finally:
            self.service._refresh_lock.release()


class LearningMethodsDownloadTests(unittest.TestCase):
    def download_response(self, response: PublicResponse) -> tuple[bytes, mock.Mock]:
        opener = mock.Mock()
        opener.open.return_value = response
        with mock.patch.object(methods, "build_opener", return_value=opener):
            result = methods._download_source()
        return result, opener

    def test_download_has_fixed_https_url_timeout_and_no_authorization(self) -> None:
        content = STUDY_SOURCE.encode("utf-8")
        result, opener = self.download_response(PublicResponse(content, headers={"Content-Length": str(len(content))}))
        self.assertEqual(result, content)
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, methods.SOURCE_RAW_URL)
        self.assertEqual(opener.open.call_args.kwargs["timeout"], 8)
        self.assertNotIn("Authorization", request.headers)
        self.assertNotIn("Proxy-authorization", request.headers)
        self.assertEqual(set(request.headers), {"Accept", "User-agent"})

    def test_size_bound_applies_with_or_without_content_length(self) -> None:
        for headers, body in (({"Content-Length": str(methods.MAX_SOURCE_BYTES + 1)}, b"small"), ({}, b"x" * (methods.MAX_SOURCE_BYTES + 1))):
            with self.subTest(headers=headers):
                with self.assertRaises(methods.LearningMethodsError) as raised:
                    self.download_response(PublicResponse(body, headers=headers))
                self.assertEqual(raised.exception.code, "source_too_large")

    def test_invalid_content_length_and_non_ok_response_are_sanitized(self) -> None:
        for response in (PublicResponse(b"x", headers={"Content-Length": "secret-proxy-value"}), PublicResponse(b"x", status=302)):
            with self.assertRaises(methods.LearningMethodsError) as raised:
                self.download_response(response)
            self.assertNotIn("secret", raised.exception.message)

    def test_truncated_download_or_http_exception_is_not_imported(self) -> None:
        with self.assertRaises(methods.LearningMethodsError) as raised:
            self.download_response(PublicResponse(b"short", headers={"Content-Length": "100"}))
        self.assertEqual(raised.exception.code, "incomplete_download")
        opener = mock.Mock()
        opener.open.side_effect = IncompleteRead(b"private-data", 100)
        with mock.patch.object(methods, "build_opener", return_value=opener):
            with self.assertRaises(methods.LearningMethodsError) as raised:
                methods._download_source()
        self.assertEqual(raised.exception.code, "download_failed")
        self.assertNotIn("private-data", raised.exception.message)

    def test_final_url_must_equal_allowlisted_source(self) -> None:
        for target in ("http://127.0.0.1/private", "https://raw.githubusercontent.com/other/repository/master/file.md", methods.SOURCE_RAW_URL + "?secret=1"):
            with self.subTest(target=target):
                with self.assertRaises(methods.LearningMethodsError) as raised:
                    self.download_response(PublicResponse(b"secret", url=target))
                self.assertEqual(raised.exception.code, "unsafe_source")

    def test_redirect_rejects_localhost_protocol_userinfo_port_and_other_path(self) -> None:
        redirect = methods._AllowedSourceRedirectHandler()
        request = Request(methods.SOURCE_RAW_URL)
        targets = [
            "http://127.0.0.1/private",
            "https://raw.githubusercontent.com/other/file.md",
            methods.SOURCE_RAW_URL.replace("https://", "http://"),
            methods.SOURCE_RAW_URL.replace("raw.githubusercontent.com", "credential@raw.githubusercontent.com"),
            methods.SOURCE_RAW_URL.replace("raw.githubusercontent.com", "raw.githubusercontent.com:444"),
            methods.SOURCE_RAW_URL + "#fragment",
        ]
        for target in targets:
            with self.subTest(target=target):
                with self.assertRaises(methods.LearningMethodsError):
                    redirect.redirect_request(request, None, 302, "Found", {}, target)
        allowed = redirect.redirect_request(request, None, 302, "Found", {}, methods.SOURCE_RAW_URL)
        self.assertEqual(allowed.full_url, methods.SOURCE_RAW_URL)

    def test_network_errors_do_not_disclose_proxy_credentials(self) -> None:
        opener = mock.Mock()
        for error, expected_status in ((URLError("https://secret-user:secret-pass@proxy.local connection refused"), HTTPStatus.BAD_GATEWAY), (TimeoutError("secret-token"), HTTPStatus.GATEWAY_TIMEOUT), (URLError(TimeoutError("secret-token")), HTTPStatus.GATEWAY_TIMEOUT)):
            with self.subTest(error=type(error).__name__):
                opener.open.side_effect = error
                with mock.patch.object(methods, "build_opener", return_value=opener):
                    with self.assertRaises(methods.LearningMethodsError) as raised:
                        methods._download_source()
                self.assertEqual(raised.exception.status, expected_status)
                self.assertNotIn("secret", raised.exception.message)
                self.assertNotIn("proxy.local", raised.exception.message)

    def test_total_deadline_checked_before_body_reads(self) -> None:
        response = PublicResponse(b"x")
        with mock.patch.object(methods.time, "monotonic", side_effect=[0.0, 9.0]):
            with self.assertRaises(methods.LearningMethodsError) as raised:
                self.download_response(response)
        self.assertEqual(raised.exception.code, "download_timeout")


class LearningMethodsApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.service = methods.LearningMethodsService(Path(self.temporary.name) / "cache")
        self.api = methods.LearningMethodsAPI(self.service)
        self.no_network = mock.patch.object(methods, "_download_source", side_effect=AssertionError("unexpected network"))
        self.download_mock = self.no_network.start()

    def tearDown(self) -> None:
        self.no_network.stop()
        self.temporary.cleanup()

    def test_get_and_head_are_cache_only(self) -> None:
        for include_body in (True, False):
            handler = ContractHandler()
            self.assertTrue(self.api.handle_get(handler, urlparse(methods.API_PATH), include_body=include_body))
            status, body, received_include_body = handler.responses[0]
            self.assertEqual(status, HTTPStatus.OK)
            self.assertEqual(body["status"], "not_imported")
            self.assertEqual(received_include_body, include_body)
        self.download_mock.assert_not_called()

    def test_refresh_requires_explicit_post_and_empty_json(self) -> None:
        handler = ContractHandler()
        with mock.patch.object(methods, "_download_source", return_value=STUDY_SOURCE.encode("utf-8")) as download:
            self.assertTrue(self.api.handle_post(handler, urlparse(methods.API_PATH + "/refresh")))
            download.assert_called_once_with()
        self.assertEqual(handler.responses[0][0], HTTPStatus.OK)
        self.assertEqual(handler.responses[0][1]["status"], "ready")

    def test_cross_origin_request_never_fetches(self) -> None:
        handler = ContractHandler(same_origin=False)
        self.api.handle_post(handler, urlparse(methods.API_PATH + "/refresh"))
        self.assertEqual(handler.responses[0][0], HTTPStatus.FORBIDDEN)
        self.download_mock.assert_not_called()

    def test_arbitrary_urls_queries_or_extra_fields_are_never_fetched(self) -> None:
        for body, suffix in ((b'{"url":"http://127.0.0.1"}', ""), (b'{"source":"other"}', ""), (b"{}", "?url=http://127.0.0.1"), (b"[]", "")):
            with self.subTest(body=body, suffix=suffix):
                handler = ContractHandler(body)
                self.api.handle_post(handler, urlparse(methods.API_PATH + "/refresh" + suffix))
                self.assertEqual(handler.responses[0][0], HTTPStatus.BAD_REQUEST)
        self.download_mock.assert_not_called()

    def test_request_validation_bounds_utf8_json_and_content_length(self) -> None:
        cases = [
            (b"{}", {"Content-Type": "text/plain"}, HTTPStatus.UNSUPPORTED_MEDIA_TYPE),
            (b"{}", {"Content-Length": "bad"}, HTTPStatus.BAD_REQUEST),
            (b"{}", {"Content-Length": "0"}, HTTPStatus.BAD_REQUEST),
            (b"{}", {"Content-Length": "5"}, HTTPStatus.BAD_REQUEST),
            (b"{}", {"Content-Length": "1025"}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE),
            (b"\xff", {}, HTTPStatus.BAD_REQUEST),
            (b"{", {}, HTTPStatus.BAD_REQUEST),
        ]
        for body, headers, expected in cases:
            with self.subTest(headers=headers, body=body):
                handler = ContractHandler(body, headers=headers)
                self.api.handle_post(handler, urlparse(methods.API_PATH + "/refresh"))
                self.assertEqual(handler.responses[0][0], expected)
        handler = ContractHandler()
        del handler.headers["Content-Length"]
        self.api.handle_post(handler, urlparse(methods.API_PATH + "/refresh"))
        self.assertEqual(handler.responses[0][0], HTTPStatus.LENGTH_REQUIRED)
        self.download_mock.assert_not_called()

    def test_failed_refresh_reports_cached_availability_without_losing_old(self) -> None:
        with mock.patch.object(methods, "_download_source", return_value=STUDY_SOURCE.encode("utf-8")):
            self.service.refresh()
        with mock.patch.object(methods, "_download_source", side_effect=methods.LearningMethodsError("下载超时", HTTPStatus.GATEWAY_TIMEOUT, "download_timeout")):
            handler = ContractHandler()
            self.api.handle_post(handler, urlparse(methods.API_PATH + "/refresh"))
        status, body, _ = handler.responses[0]
        self.assertEqual(status, HTTPStatus.GATEWAY_TIMEOUT)
        self.assertTrue(body["cachedAvailable"])
        self.assertEqual(body["errorCode"], "download_timeout")
        self.assertEqual(self.service.cached_document()["count"], 4)

    def test_unrecognized_routes_do_not_take_other_apis(self) -> None:
        for url in ("/api/exams", "/reader.html", "/api/learning-methods-other"):
            self.assertFalse(self.api.handle_get(ContractHandler(), urlparse(url)))
            self.assertFalse(self.api.handle_post(ContractHandler(), urlparse(url)))
        handler = ContractHandler()
        self.api.handle_get(handler, urlparse(methods.API_PATH + "/other"))
        self.assertEqual(handler.responses[0][0], HTTPStatus.NOT_FOUND)
        handler = ContractHandler()
        self.api.handle_get(handler, urlparse(methods.API_PATH + "/refresh"), include_body=False)
        self.assertEqual(handler.responses[0][0], HTTPStatus.METHOD_NOT_ALLOWED)
        self.assertFalse(handler.responses[0][2])
        self.download_mock.assert_not_called()


if __name__ == "__main__":
    unittest.main()
