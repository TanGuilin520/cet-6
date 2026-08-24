"""Mocked regression tests for the open dictionary pronunciation service."""

from __future__ import annotations

import json
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from http import HTTPStatus
from pathlib import Path
from unittest import mock

import server.dictionary as dictionary_module
from server.dictionary import (
    DICTIONARY_SERVICE,
    DictionaryError,
    DictionaryService,
    fetch_upstream_entries,
    is_https_remote_allowed,
    normalize_accent,
    normalize_word,
    safe_cache_name,
    sniff_audio_mime,
)

LICENSE = {"name": "CC BY-SA 4.0", "url": "https://creativecommons.org/licenses/by-sa/4.0/"}
WIKTIONARY_SOURCE = ["https://en.wiktionary.org/wiki/example"]
UK_AUDIO = "https://api.dictionaryapi.dev/media/pronunciations/en/example-uk.mp3"
US_AUDIO = "https://upload.wikimedia.org/wikipedia/commons/example-us.ogg"


def upstream_entries(**overrides) -> list[dict]:
    entry: dict = {
        "word": "example",
        "phonetics": [
            {"text": "/ɪɡˈzɑːmpəl/", "audio": ""},
            {"text": "/ɪɡˈzɑːmpəl/", "audio": UK_AUDIO},
            {"text": "/ɪɡˈzɑːmpəl/", "audio": US_AUDIO},
        ],
        "meanings": [
            {
                "partOfSpeech": "noun",
                "definitions": [
                    {"definition": "A thing characteristic of its kind.", "example": "It is a good example."},
                    {"definition": "A person or idea to be imitated."},
                ],
            },
            {
                "partOfSpeech": "verb",
                "definitions": [
                    {"definition": "To be illustrated by an example."}
                ],
            },
        ],
        "sourceUrls": WIKTIONARY_SOURCE,
        "license": LICENSE,
    }
    entry.update(overrides)
    return [entry]


def mp3_payload(size: int = 1024) -> bytes:
    return b"ID3\x04\x00" + b"\x00" * (size - 6)


def fake_headers(content_type: str = "audio/mpeg"):
    return {"Content-Type": content_type}


def make_service() -> tuple[DictionaryService, tempfile.TemporaryDirectory, tempfile.TemporaryDirectory]:
    metadata_dir = tempfile.TemporaryDirectory()
    audio_dir = tempfile.TemporaryDirectory()
    service = DictionaryService(
        metadata_dir=Path(metadata_dir.name),
        audio_dir=Path(audio_dir.name),
    )
    return service, metadata_dir, audio_dir


class WordAndAccentValidationTests(unittest.TestCase):
    def test_legal_words_are_accepted(self) -> None:
        self.assertEqual(normalize_word("Example"), "example")
        self.assertEqual(normalize_word("mother-in-law"), "mother-in-law")
        self.assertEqual(normalize_word("don't"), "don't")

    def test_illegal_or_oversized_words_are_rejected(self) -> None:
        for bad in ["", "   ", "a" * 200, "word1", "../etc/passwd", "two words", "<script>"]:
            with self.assertRaises(DictionaryError) as caught:
                normalize_word(bad)
            self.assertEqual(caught.exception.status, HTTPStatus.BAD_REQUEST)
            self.assertEqual(caught.exception.code, "invalid_word")

    def test_accent_whitelist(self) -> None:
        self.assertEqual(normalize_accent("UK"), "uk")
        for bad in ["", "cn", "gb1", "usa"]:
            with self.assertRaises(DictionaryError) as caught:
                normalize_accent(bad)
            self.assertEqual(caught.exception.code, "invalid_accent")


class RemoteUrlPolicyTests(unittest.TestCase):
    def test_only_whitelisted_https_hosts_are_allowed(self) -> None:
        self.assertTrue(is_https_remote_allowed(UK_AUDIO))
        self.assertTrue(is_https_remote_allowed(US_AUDIO))
        self.assertFalse(is_https_remote_allowed("http://api.dictionaryapi.dev/media/en-uk.mp3"))
        self.assertFalse(is_https_remote_allowed("https://evil.example.com/en-uk.mp3"))
        self.assertFalse(is_https_remote_allowed("https://user:pass@api.dictionaryapi.dev/a.mp3"))
        self.assertFalse(is_https_remote_allowed("https://api.dictionaryapi.dev:8443/a.mp3"))

    def test_sniffed_audio_must_look_like_real_audio(self) -> None:
        self.assertEqual(sniff_audio_mime(mp3_payload(), "audio/mpeg"), "audio/mpeg")
        self.assertEqual(sniff_audio_mime(b"OggS" + b"\x00" * 60, ""), "audio/ogg")
        with self.assertRaises(DictionaryError) as caught:
            sniff_audio_mime(b"<html>not audio</html>", "text/html")
        self.assertEqual(caught.exception.code, "audio_invalid_content")
        with self.assertRaises(DictionaryError) as caught:
            sniff_audio_mime(mp3_payload(), "text/html")
        self.assertEqual(caught.exception.code, "audio_invalid_mime")


class LookupTests(unittest.TestCase):
    def test_valid_lookup_returns_unified_document(self) -> None:
        service, meta_dir, _audio_dir = make_service()
        try:
            with mock.patch.object(dictionary_module, "fetch_upstream_entries", return_value=upstream_entries()):
                document = service.lookup("example")
            self.assertEqual(document["schemaVersion"], "cet-dictionary/1")
            self.assertEqual(document["word"], "example")
            self.assertEqual(document["provider"], "Free Dictionary API")
            accents = [item["accent"] for item in document["phonetics"]]
            self.assertEqual(accents, ["uk", "us"])
            uk = document["phonetics"][0]
            self.assertEqual(uk["ipa"], "/ɪɡˈzɑːmpəl/")
            self.assertEqual(uk["audioUrl"], "/api/pronunciation?word=example&accent=uk")
            self.assertEqual(uk["license"]["name"], "CC BY-SA 4.0")
            self.assertTrue(uk["sourceUrl"].startswith("https://"))
            self.assertEqual([m["partOfSpeech"] for m in document["meanings"]], ["noun", "verb"])
            self.assertEqual(document["meanings"][0]["definitions"][0]["example"], "It is a good example.")
        finally:
            meta_dir.cleanup()
            _audio_dir.cleanup()

    def test_second_lookup_within_ttl_does_not_hit_upstream_again(self) -> None:
        service, meta_dir, _audio_dir = make_service()
        try:
            with mock.patch.object(dictionary_module, "fetch_upstream_entries", return_value=upstream_entries()) as fetch:
                service.lookup("example")
                service.lookup("example")
            self.assertEqual(fetch.call_count, 1)
        finally:
            meta_dir.cleanup()
            _audio_dir.cleanup()

    def test_stale_cache_still_serves_when_upstream_is_down(self) -> None:
        service, meta_dir, _audio_dir = make_service()
        try:
            with mock.patch.object(dictionary_module, "fetch_upstream_entries", return_value=upstream_entries()):
                service.lookup("example")
            stale_path = Path(meta_dir.name) / safe_cache_name("example", ".json")
            document = json.loads(stale_path.read_text(encoding="utf-8"))
            document["fetchedAt"] = time.time() - 10 * 24 * 3600
            stale_path.write_text(json.dumps(document), encoding="utf-8")
            with mock.patch.object(
                dictionary_module,
                "fetch_upstream_entries",
                side_effect=DictionaryError("dictionary service is unavailable", HTTPStatus.BAD_GATEWAY),
            ):
                document = service.lookup("example")
            self.assertEqual(document["schemaVersion"], "cet-dictionary/1")
        finally:
            meta_dir.cleanup()
            _audio_dir.cleanup()

    def test_audio_without_license_never_exposes_a_playback_url(self) -> None:
        service, meta_dir, _audio_dir = make_service()
        try:
            unlicensed = upstream_entries()
            del unlicensed[0]["license"]
            del unlicensed[0]["sourceUrls"]
            with mock.patch.object(dictionary_module, "fetch_upstream_entries", return_value=unlicensed):
                document = service.lookup("example")
            self.assertTrue(all(not item["audioUrl"] for item in document["phonetics"]))
            with self.assertRaises(DictionaryError) as caught:
                service.pronunciation("example", "uk")
            self.assertEqual(caught.exception.status, HTTPStatus.NOT_FOUND)
            self.assertEqual(caught.exception.code, "recording_not_found")
        finally:
            meta_dir.cleanup()
            _audio_dir.cleanup()

    def test_meanings_are_bounded_before_caching(self) -> None:
        service, meta_dir, _audio_dir = make_service()
        try:
            bloated = upstream_entries(
                meanings=[
                    {
                        "partOfSpeech": "noun",
                        "definitions": [
                            {"definition": "x" * 5000, "example": "y" * 5000}
                            for _ in range(20)
                        ],
                    }
                    for _ in range(12)
                ]
            )
            with mock.patch.object(dictionary_module, "fetch_upstream_entries", return_value=bloated):
                document = service.lookup("example")
            self.assertEqual(len(document["meanings"]), dictionary_module.MAX_MEANINGS)
            first_definition = document["meanings"][0]["definitions"][0]
            self.assertLessEqual(len(first_definition["definition"]), dictionary_module.MAX_DEFINITION_CHARS)
            self.assertLessEqual(len(first_definition.get("example", "")), dictionary_module.MAX_EXAMPLE_CHARS)
        finally:
            meta_dir.cleanup()
            _audio_dir.cleanup()


class UpstreamTransportTests(unittest.TestCase):
    def run_fetch(self, url: str):
        return fetch_upstream_entries(url)

    def test_upstream_timeout_maps_to_gateway_timeout(self) -> None:
        with mock.patch.object(dictionary_module, "http_get_bytes", side_effect=(TimeoutError(),)):
            with self.assertRaises(DictionaryError) as caught:
                self.run_fetch(dictionary_module.UPSTREAM_URL_TEMPLATE.format(word="example"))
        self.assertEqual(caught.exception.status, HTTPStatus.GATEWAY_TIMEOUT)
        self.assertEqual(caught.exception.code, "upstream_timeout")

    def test_upstream_connection_error_maps_to_bad_gateway(self) -> None:
        with mock.patch.object(dictionary_module, "http_get_bytes", side_effect=OSError("no route")):
            with self.assertRaises(DictionaryError) as caught:
                self.run_fetch(dictionary_module.UPSTREAM_URL_TEMPLATE.format(word="example"))
        self.assertEqual(caught.exception.status, HTTPStatus.BAD_GATEWAY)

    def test_upstream_404_maps_to_word_not_found(self) -> None:
        error = urllib.error.HTTPError(
            url="https://api.dictionaryapi.dev/x", code=404, msg="Not Found", hdrs=None, fp=None
        )
        with mock.patch.object(dictionary_module, "http_get_bytes", side_effect=error):
            with self.assertRaises(DictionaryError) as caught:
                self.run_fetch(dictionary_module.UPSTREAM_URL_TEMPLATE.format(word="example"))
        self.assertEqual(caught.exception.status, HTTPStatus.NOT_FOUND)
        self.assertEqual(caught.exception.code, "word_not_found")

    def test_corrupt_upstream_json_maps_to_invalid_json(self) -> None:
        with mock.patch.object(dictionary_module, "http_get_bytes", return_value=(b"{definitely-not-json", fake_headers())):
            with self.assertRaises(DictionaryError) as caught:
                self.run_fetch(dictionary_module.UPSTREAM_URL_TEMPLATE.format(word="example"))
        self.assertEqual(caught.exception.code, "upstream_invalid_json")
        self.assertEqual(caught.exception.status, HTTPStatus.BAD_GATEWAY)

    def test_oversized_responses_are_refused(self) -> None:
        class HugeResponse:
            headers = fake_headers()

            def __init__(self, total: int) -> None:
                self.total = total

            def read(self, limit: int) -> bytes:
                return b"x" * min(limit, self.total)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        with mock.patch.object(dictionary_module, "urlopen", return_value=HugeResponse(dictionary_module.MAX_JSON_BYTES + 10)):
            with self.assertRaises(DictionaryError) as caught:
                self.run_fetch(dictionary_module.UPSTREAM_URL_TEMPLATE.format(word="example"))
        self.assertEqual(caught.exception.code, "upstream_too_large")


class PronunciationCacheTests(unittest.TestCase):
    def test_download_then_cache_hit_skips_second_download(self) -> None:
        service, meta_dir, audio_dir = make_service()
        try:
            with mock.patch.object(dictionary_module, "fetch_upstream_entries", return_value=upstream_entries()):
                with mock.patch.object(
                    dictionary_module,
                    "http_get_bytes",
                    return_value=(mp3_payload(), fake_headers("audio/mpeg")),
                ) as download:
                    path, mime = service.pronunciation("example", "uk")
                    path2, mime2 = service.pronunciation("example", "uk")
            self.assertEqual(path, path2)
            self.assertEqual(mime, mime2, "audio/mpeg")
            self.assertEqual(download.call_count, 1)
            self.assertEqual(path.read_bytes(), mp3_payload())
        finally:
            meta_dir.cleanup()
            audio_dir.cleanup()

    def test_concurrent_requests_for_same_key_produce_one_intact_file(self) -> None:
        service, meta_dir, audio_dir = make_service()
        try:
            payload = mp3_payload(2048)
            with mock.patch.object(dictionary_module, "fetch_upstream_entries", return_value=upstream_entries()):
                with mock.patch.object(
                    dictionary_module,
                    "http_get_bytes",
                    return_value=(payload, fake_headers("audio/mpeg")),
                ):
                    barrier = threading.Barrier(8)

                    def worker(_: int) -> tuple[str, int]:
                        barrier.wait()
                        path, _mime = service.pronunciation("example", "uk")
                        return str(path), path.stat().st_size

                    with ThreadPoolExecutor(max_workers=8) as pool:
                        results = list(pool.map(worker, range(8)))
            self.assertTrue(all(size == len(payload) for _, size in results))
            self.assertEqual(len({path for path, _ in results}), 1)
            meta = json.loads(
                (Path(audio_dir.name) / f"pron-{safe_cache_name('example|uk', '')}.meta.json").read_text(encoding="utf-8")
            )
            self.assertEqual(meta["word"], "example")
            self.assertEqual(meta["accent"], "uk")
            self.assertEqual(meta["license"]["name"], "CC BY-SA 4.0")
        finally:
            meta_dir.cleanup()
            audio_dir.cleanup()

    def test_audio_download_size_cap_is_enforced(self) -> None:
        class OversizeResponse:
            headers = fake_headers("audio/mpeg")

            def read(self, limit: int) -> bytes:
                return b"ID3" + b"\x00" * (limit + 5)

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        with mock.patch.object(
            dictionary_module, "urlopen", return_value=OversizeResponse()
        ) as opened:
            opened.return_value.__enter__ = lambda self: self
            with mock.patch.object(dictionary_module, "fetch_upstream_entries", return_value=upstream_entries()):
                service, meta_dir, audio_dir = make_service()
                try:
                    with self.assertRaises(DictionaryError) as caught:
                        # Bypass the service cache lock path and hit the bounded GET directly.
                        dictionary_module.http_get_bytes(UK_AUDIO, 1, dictionary_module.MAX_AUDIO_BYTES)
                finally:
                    meta_dir.cleanup()
                    audio_dir.cleanup()
        self.assertEqual(caught.exception.code, "upstream_too_large")


class SharedModuleAssetsTests(unittest.TestCase):
    """Static guarantees for the shared frontend module on both pages."""

    PROJECT_ROOT = Path(__file__).resolve().parent.parent

    def test_both_pages_load_the_shared_module_and_stylesheet(self) -> None:
        for page in ("reader.html", "practice.html"):
            markup = (self.PROJECT_ROOT / "public" / page).read_text(encoding="utf-8")
            self.assertIn("js/word-lookup.js", markup, page)
            self.assertIn("css/word-lookup.css", markup, page)

    def test_module_keeps_full_fallback_chain_and_race_guard(self) -> None:
        source = (self.PROJECT_ROOT / "public" / "js" / "word-lookup.js").read_text(encoding="utf-8")
        self.assertIn("/api/pronunciation", source)
        self.assertIn("/api/tts", source)
        self.assertIn("speechSynthesis", source)
        self.assertIn("requestIsCurrent", source)
        self.assertIn("本地合成发音", source)

    def test_legacy_popover_markup_was_removed_from_pages(self) -> None:
        reader = (self.PROJECT_ROOT / "public" / "reader.html").read_text(encoding="utf-8")
        practice = (self.PROJECT_ROOT / "public" / "practice.html").read_text(encoding="utf-8")
        self.assertNotIn('id="word-popover"', reader)
        self.assertNotIn('id="word-popover"', practice)

    def test_ai_proxy_routes_are_untouched(self) -> None:
        app_source = (self.PROJECT_ROOT / "server" / "app.py").read_text(encoding="utf-8")
        self.assertIn('"/api/deepseek"', app_source)
        self.assertIn('"/api/chat"', app_source)
        self.assertIn("/api/tts", app_source)


class SingletonSanityTests(unittest.TestCase):
    def test_shared_singleton_uses_repo_cache_dirs(self) -> None:
        self.assertIsInstance(DICTIONARY_SERVICE, DictionaryService)
        self.assertEqual(DICTIONARY_SERVICE.metadata_dir, dictionary_module.DICTIONARY_CACHE_DIR)
        self.assertEqual(DICTIONARY_SERVICE.audio_dir, dictionary_module.PRONUNCIATION_CACHE_DIR)


if __name__ == "__main__":
    unittest.main()
