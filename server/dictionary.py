#!/usr/bin/env python3
"""Open-dictionary lookup and licensed human-pronunciation proxy.

Two same-origin endpoints are backed by this module:

* ``GET /api/dictionary?word=WORD`` returns the unified ``cet-dictionary/1``
  document built from the Free Dictionary API
  (https://api.dictionaryapi.dev) with UK/US IPA transcriptions, parts of
  speech, English definitions, examples, and licensed human-audio metadata.
* ``GET /api/pronunciation?word=WORD&accent=uk|us|au`` streams the cached
  human recording for one accent.  Audio is only downloaded and kept when the
  upstream entry carries an explicit license name, license URL, and source
  URL, and only from a fixed HTTPS host whitelist.

Security boundaries mirror ``server/app.py``: the upstream URL is fixed here
so browser input can never turn the proxy into an arbitrary URL fetcher
(SSRF), every remote read has connect/read timeouts and a strict size cap,
and cache writes land through unique temporary files plus atomic renames so
concurrent requests can never observe a partially written artifact.

Both caches are runtime artifacts and stay out of Git:

* ``data/dictionary-cache/``       - normalized dictionary JSON metadata.
* ``public/assets/audio/cache/dictionary/`` - licensed human recordings plus
  their sidecar ``.meta.json`` provenance files.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import tempfile
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DICTIONARY_CACHE_DIR = PROJECT_ROOT / "data" / "dictionary-cache"
PRONUNCIATION_CACHE_DIR = PROJECT_ROOT / "public" / "assets" / "audio" / "cache" / "dictionary"

# A single leading letter, optionally hyphenated/apostrophised interior, and a
# trailing letter keep path traversal and query smuggling out of both the
# upstream URL template and the cache file naming scheme.
VALID_WORD = re.compile(r"^[A-Za-z](?:[A-Za-z'-]{0,78}[A-Za-z])?$")
VALID_ACCENTS = frozenset({"uk", "us", "au"})
ACCENT_ORDER = ("uk", "us", "au")

SCHEMA_VERSION = "cet-dictionary/1"
PROVIDER_NAME = "Free Dictionary API"
UPSTREAM_URL_TEMPLATE = "https://api.dictionaryapi.dev/api/v2/entries/en/{word}"

# Remote access is restricted to these exact HTTPS hosts.  Anything else in
# upstream JSON - including look-alike hosts - is refused before connecting.
ALLOWED_REMOTE_HOSTS = frozenset(
    {
        "api.dictionaryapi.dev",
        "upload.wikimedia.org",
        "commons.wikimedia.org",
    }
)

UPSTREAM_TIMEOUT_SECONDS = 8
AUDIO_TIMEOUT_SECONDS = 12
MAX_JSON_BYTES = 512 * 1024
MAX_AUDIO_BYTES = 3 * 1024 * 1024
MIN_AUDIO_BYTES = 512
MAX_MEANINGS = 6
MAX_DEFINITIONS_PER_MEANING = 8
MAX_DEFINITION_CHARS = 600
MAX_EXAMPLE_CHARS = 400
MAX_IPA_CHARS = 80
CACHE_TTL_SECONDS = 24 * 60 * 60

AUDIO_MIME_BY_EXTENSION = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".m4a": "audio/mp4",
}
ALLOWED_AUDIO_MIME = frozenset(set(AUDIO_MIME_BY_EXTENSION.values()))


class DictionaryError(Exception):
    """Structured, user-safe failure carrying an HTTP status."""

    def __init__(self, message: str, status: HTTPStatus, code: str = "dictionary_error") -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


@dataclass(frozen=True)
class ResolvedPhonetic:
    """One accent slot with optional IPA and/or licensed human audio."""

    accent: str
    ipa: str
    audio_url: str  # absolute HTTPS URL, "" when no licensed recording
    source_url: str
    license_name: str
    license_url: str


def normalize_word(raw: object) -> str:
    """Validate and normalize a lookup word supplied over HTTP."""

    word = str(raw or "").strip().lower()
    if not word:
        raise DictionaryError("word parameter is required", HTTPStatus.BAD_REQUEST, "invalid_word")
    if len(word) > 80 or not VALID_WORD.fullmatch(word):
        raise DictionaryError("word must be a short English word", HTTPStatus.BAD_REQUEST, "invalid_word")
    return word


def normalize_accent(raw: object) -> str:
    accent = str(raw or "").strip().lower()
    if accent not in VALID_ACCENTS:
        raise DictionaryError(
            "accent must be one of uk, us, au",
            HTTPStatus.BAD_REQUEST,
            "invalid_accent",
        )
    return accent


def safe_cache_name(word: str, suffix: str) -> str:
    digest = hashlib.sha256(word.encode("utf-8")).hexdigest()[:32]
    return f"{digest}{suffix}"


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    """Write via a unique temp file in the same directory, then rename once.

    ``Path.replace`` is atomic on POSIX and Windows, so concurrent readers see
    either the previous complete file or the new complete file - never a torn
    write - even when several threads regenerate the same key simultaneously.
    """

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except OSError:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def atomic_write_json(path: Path, document: dict[str, object]) -> None:
    atomic_write_bytes(path, json.dumps(document, ensure_ascii=False).encode("utf-8"))


def read_json(path: Path) -> dict[str, object] | None:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return document if isinstance(document, dict) else None


def is_https_remote_allowed(url: str) -> bool:
    """Gate every remote URL before any connection is attempted (anti-SSRF)."""

    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    return (
        parsed.scheme == "https"
        and parsed.hostname in ALLOWED_REMOTE_HOSTS
        and parsed.username is None
        and parsed.password is None
        and parsed.port in (None, 443)
        and not parsed.fragment
        and len(url) <= 600
    )


def http_get_bytes(url: str, timeout: float, max_bytes: int) -> tuple[bytes, object]:
    """Bounded GET used for both upstream JSON and pronunciation audio."""

    request = Request(
        url,
        method="GET",
        headers={
            "User-Agent": "CETReadingLab/1.0 (local study tool)",
            "Accept": "*/*",
            "Accept-Encoding": "identity",
        },
    )
    with urlopen(request, timeout=timeout) as response:
        payload = response.read(max_bytes + 1)
        headers = response.headers
    if len(payload) > max_bytes:
        raise DictionaryError(
            "upstream response is too large",
            HTTPStatus.BAD_GATEWAY,
            "upstream_too_large",
        )
    return payload, headers


def fetch_upstream_entries(url: str) -> list[dict[str, object]]:
    if not is_https_remote_allowed(url):  # defensive; URL comes from a fixed template
        raise DictionaryError(
            "upstream host is not allowed",
            HTTPStatus.BAD_GATEWAY,
            "remote_host_not_allowed",
        )
    try:
        payload, _headers = http_get_bytes(url, UPSTREAM_TIMEOUT_SECONDS, MAX_JSON_BYTES)
    except HTTPError as error:
        if error.code == HTTPStatus.NOT_FOUND:
            raise DictionaryError(
                "no dictionary entry was found for this word",
                HTTPStatus.NOT_FOUND,
                "word_not_found",
            ) from error
        raise DictionaryError(
            "dictionary service request failed",
            HTTPStatus.BAD_GATEWAY,
            "upstream_status",
        ) from error
    except (TimeoutError, socket.timeout):
        raise DictionaryError(
            "dictionary service timed out",
            HTTPStatus.GATEWAY_TIMEOUT,
            "upstream_timeout",
        ) from None
    except (URLError, OSError):
        raise DictionaryError(
            "dictionary service is unavailable",
            HTTPStatus.BAD_GATEWAY,
            "upstream_unavailable",
        ) from None
    try:
        document = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise DictionaryError(
            "dictionary service returned invalid JSON",
            HTTPStatus.BAD_GATEWAY,
            "upstream_invalid_json",
        ) from None
    if not isinstance(document, list):
        raise DictionaryError(
            "dictionary service returned an unexpected document",
            HTTPStatus.BAD_GATEWAY,
            "upstream_invalid_document",
        )
    return [entry for entry in document if isinstance(entry, dict)]


def sniff_audio_mime(payload: bytes, declared_type: str) -> str:
    """Return a canonical MIME type only for payloads with real audio magic."""

    head = payload[:16]
    sniffed = ""
    if head.startswith(b"ID3") or (len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0):
        sniffed = "audio/mpeg"
    elif head.startswith(b"OggS"):
        sniffed = "audio/ogg"
    elif head.startswith(b"RIFF") and payload[8:12] == b"WAVE":
        sniffed = "audio/wav"
    elif len(head) >= 12 and head[4:8] == b"ftyp":
        sniffed = "audio/mp4"
    if not sniffed:
        raise DictionaryError(
            "downloaded audio failed content validation",
            HTTPStatus.BAD_GATEWAY,
            "audio_invalid_content",
        )
    declared = declared_type.split(";", 1)[0].strip().lower()
    if declared and declared not in ALLOWED_AUDIO_MIME:
        raise DictionaryError(
            "downloaded audio has an unsupported content type",
            HTTPStatus.BAD_GATEWAY,
            "audio_invalid_mime",
        )
    return sniffed


def _clean_text(value: object, limit: int) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def _clean_url(value: object) -> str:
    url = str(value or "").strip()
    return url if url.startswith("https://") and len(url) <= 600 else ""


def _license_from(source: dict[str, object]) -> tuple[str, str]:
    license_info = source.get("license")
    if not isinstance(license_info, dict):
        return "", ""
    return (
        _clean_text(license_info.get("name"), 120),
        _clean_url(license_info.get("url")),
    )


def _detect_accent(audio_url: str) -> str:
    basename = urlparse(audio_url).path.rsplit("/", 1)[-1].lower()
    marker = re.search(r"(?:^|[^a-z])(uk|us|au|gb)(?:[^a-z]|$)", basename)
    if not marker:
        return ""
    accent = marker.group(1)
    return "uk" if accent == "gb" else accent


class DictionaryService:
    """Cached Free Dictionary API facade shared by both HTTP endpoints."""

    def __init__(
        self,
        metadata_dir: Path = DICTIONARY_CACHE_DIR,
        audio_dir: Path = PRONUNCIATION_CACHE_DIR,
        clock=time.time,
    ) -> None:
        self.metadata_dir = Path(metadata_dir)
        self.audio_dir = Path(audio_dir)
        self.clock = clock
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _key_lock(self, key: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock

    # -- metadata ---------------------------------------------------------

    def _metadata_path(self, word: str) -> Path:
        return self.metadata_dir / safe_cache_name(word, ".json")

    def _load_metadata(self, word: str) -> dict[str, object] | None:
        document = read_json(self._metadata_path(word))
        if not document or document.get("version") != 1 or document.get("word") != word:
            return None
        return document

    def _store_metadata(self, word: str, entries: list[dict[str, object]]) -> dict[str, object]:
        document: dict[str, object] = {
            "version": 1,
            "word": word,
            "provider": PROVIDER_NAME,
            "fetchedAt": self.clock(),
            "meanings": self._normalize_meanings(entries),
            "phonetics": [self._cached_phonetic(item) for item in self._resolve_phonetics(entries)],
        }
        atomic_write_json(self._metadata_path(word), document)
        return document

    @staticmethod
    def _resolve_phonetics(entries: list[dict[str, object]]) -> list[ResolvedPhonetic]:
        resolved: list[ResolvedPhonetic] = []
        seen_accents: set[str] = set()
        for entry in entries:
            phonetics = [item for item in entry.get("phonetics") or [] if isinstance(item, dict)]
            fallback_ipa = ""
            for phonetic in phonetics:
                if not fallback_ipa and str(phonetic.get("text") or "").strip():
                    fallback_ipa = _clean_text(phonetic.get("text"), MAX_IPA_CHARS)
                    break
            entry_license_name, entry_license_url = _license_from(entry)
            entry_source_url = ""
            source_urls = entry.get("sourceUrls")
            if isinstance(source_urls, list):
                entry_source_url = _clean_url(next((url for url in source_urls if isinstance(url, str)), ""))
            for accent in ACCENT_ORDER:
                if accent in seen_accents:
                    continue
                matching = [
                    phonetic
                    for phonetic in phonetics
                    if str(phonetic.get("audio") or "").strip()
                    and _detect_accent(str(phonetic.get("audio"))) == accent
                ]
                if not matching:
                    continue
                ipa = next(
                    (_clean_text(item.get("text"), MAX_IPA_CHARS) for item in matching if str(item.get("text") or "").strip()),
                    "",
                )
                audio_url = ""
                source_url = ""
                license_name = ""
                license_url = ""
                for candidate in matching:
                    candidate_url = str(candidate.get("audio") or "").strip()
                    if not is_https_remote_allowed(candidate_url):
                        continue
                    candidate_license_name, candidate_license_url = _license_from(candidate)
                    if not candidate_license_name or not candidate_license_url:
                        candidate_license_name, candidate_license_url = entry_license_name, entry_license_url
                    candidate_source = _clean_url(candidate.get("sourceUrl")) or entry_source_url
                    # A human recording may only be cached and served with an
                    # explicit license name, license URL, and source URL.
                    if not (candidate_license_name and candidate_license_url and candidate_source):
                        continue
                    audio_url = candidate_url
                    source_url = candidate_source
                    license_name = candidate_license_name
                    license_url = candidate_license_url
                    break
                if not (ipa or audio_url):
                    continue
                seen_accents.add(accent)
                resolved.append(
                    ResolvedPhonetic(
                        accent=accent,
                        ipa=ipa or fallback_ipa,
                        audio_url=audio_url,
                        source_url=source_url,
                        license_name=license_name,
                        license_url=license_url,
                    )
                )
        return resolved

    @staticmethod
    def _normalize_meanings(entries: list[dict[str, object]]) -> list[dict[str, object]]:
        meanings: list[dict[str, object]] = []
        for entry in entries:
            for meaning in entry.get("meanings") or []:
                if not isinstance(meaning, dict) or len(meanings) >= MAX_MEANINGS:
                    continue
                definitions: list[dict[str, object]] = []
                for definition in meaning.get("definitions") or []:
                    if not isinstance(definition, dict) or len(definitions) >= MAX_DEFINITIONS_PER_MEANING:
                        continue
                    text = _clean_text(definition.get("definition"), MAX_DEFINITION_CHARS)
                    if not text:
                        continue
                    item: dict[str, object] = {"definition": text}
                    example = _clean_text(definition.get("example"), MAX_EXAMPLE_CHARS)
                    if example:
                        item["example"] = example
                    definitions.append(item)
                if not definitions:
                    continue
                meanings.append(
                    {
                        "partOfSpeech": _clean_text(meaning.get("partOfSpeech"), 40),
                        "definitions": definitions,
                    }
                )
        return meanings

    @staticmethod
    def _cached_phonetic(item: ResolvedPhonetic) -> dict[str, object]:
        # The absolute upstream URL is kept only inside the server-side cache
        # document; the public view never exposes it.
        return {
            "accent": item.accent,
            "ipa": item.ipa,
            "remoteUrl": item.audio_url,
            "sourceUrl": item.source_url,
            "license": {"name": item.license_name, "url": item.license_url},
        }

    def lookup(self, raw_word: object) -> dict[str, object]:
        """Return the unified ``cet-dictionary/1`` view for one word."""

        word = normalize_word(raw_word)
        cached = self._load_metadata(word)
        if cached and (self.clock() - float(cached.get("fetchedAt") or 0)) < CACHE_TTL_SECONDS:
            return self.public_view(cached)
        try:
            entries = fetch_upstream_entries(UPSTREAM_URL_TEMPLATE.format(word=quote(word)))
            document = self._store_metadata(word, entries)
        except DictionaryError:
            # The dictionary service being unreachable never invalidates an
            # existing cache: stale metadata remains servable offline.
            if cached:
                return self.public_view(cached)
            raise
        return self.public_view(document)

    def public_view(self, document: dict[str, object]) -> dict[str, object]:
        word = normalize_word(document.get("word"))
        phonetics: list[dict[str, object]] = []
        for item in document.get("phonetics") or []:
            if not isinstance(item, dict) or item.get("accent") not in VALID_ACCENTS:
                continue
            license_info = item.get("license")
            phonetics.append(
                {
                    "accent": item["accent"],
                    "ipa": _clean_text(item.get("ipa"), MAX_IPA_CHARS),
                    # Only accents with a verified licensed recording expose a
                    # playable endpoint; the rest stay display-only.
                    "audioUrl": (
                        f"/api/pronunciation?word={quote(word)}&accent={quote(str(item['accent']))}"
                        if _clean_url(item.get("remoteUrl"))
                        else ""
                    ),
                    "sourceUrl": _clean_url(item.get("sourceUrl")),
                    "license": {
                        "name": _clean_text(license_info.get("name"), 120) if isinstance(license_info, dict) else "",
                        "url": _clean_url(license_info.get("url")) if isinstance(license_info, dict) else "",
                    },
                }
            )
        return {
            "schemaVersion": SCHEMA_VERSION,
            "word": word,
            "phonetics": phonetics,
            "meanings": document.get("meanings") if isinstance(document.get("meanings"), list) else [],
            "provider": PROVIDER_NAME,
        }

    # -- audio ------------------------------------------------------------

    def _audio_paths(self, word: str, accent: str) -> tuple[Path, Path]:
        base = safe_cache_name(f"{word}|{accent}", "")
        return (
            self.audio_dir / f"pron-{base}.audio",
            self.audio_dir / f"pron-{base}.meta.json",
        )

    def _read_cached_audio(self, word: str, accent: str) -> tuple[Path, str] | None:
        audio_path, meta_path = self._audio_paths(word, accent)
        meta = read_json(meta_path)
        if not meta or meta.get("word") != word or meta.get("accent") != accent:
            return None
        try:
            size = audio_path.stat().st_size
        except OSError:
            return None
        if not MIN_AUDIO_BYTES <= size <= MAX_AUDIO_BYTES:
            return None
        mime = str(meta.get("mimeType") or "")
        if mime not in ALLOWED_AUDIO_MIME:
            return None
        return audio_path, mime

    def pronunciation(self, raw_word: object, raw_accent: object) -> tuple[Path, str]:
        """Resolve one licensed human recording, downloading on cache miss."""

        word = normalize_word(raw_word)
        accent = normalize_accent(raw_accent)
        cached = self._read_cached_audio(word, accent)
        if cached:
            return cached
        phonetic = self._cached_phonetic_for_accent(word, accent)
        remote_url = str(phonetic.get("remoteUrl") or "")
        if not _clean_url(remote_url) or not is_https_remote_allowed(remote_url):
            raise DictionaryError(
                "no licensed human recording exists for this accent",
                HTTPStatus.NOT_FOUND,
                "recording_not_found",
            )
        with self._key_lock(f"{word}|{accent}"):
            cached = self._read_cached_audio(word, accent)
            if cached:
                return cached
            return self._download_and_cache(word, accent, phonetic)

    def _cached_phonetic_for_accent(self, word: str, accent: str) -> dict[str, object]:
        self.lookup(word)
        document = self._load_metadata(word)
        if document:
            for item in document.get("phonetics") or []:
                if isinstance(item, dict) and item.get("accent") == accent:
                    return item
        return {}

    def _download_and_cache(
        self,
        word: str,
        accent: str,
        phonetic: dict[str, object],
    ) -> tuple[Path, str]:
        remote_url = str(phonetic.get("remoteUrl") or "")
        try:
            payload, headers = http_get_bytes(remote_url, AUDIO_TIMEOUT_SECONDS, MAX_AUDIO_BYTES)
        except HTTPError as error:
            raise DictionaryError(
                "pronunciation download failed",
                HTTPStatus.BAD_GATEWAY,
                "audio_download_failed",
            ) from error
        except (TimeoutError, socket.timeout):
            raise DictionaryError(
                "pronunciation download timed out",
                HTTPStatus.GATEWAY_TIMEOUT,
                "audio_download_timeout",
            ) from None
        except (URLError, OSError):
            raise DictionaryError(
                "pronunciation download failed",
                HTTPStatus.BAD_GATEWAY,
                "audio_download_failed",
            ) from None
        mime = sniff_audio_mime(payload, str(headers.get("Content-Type") or ""))
        audio_path, meta_path = self._audio_paths(word, accent)
        atomic_write_bytes(audio_path, payload)
        atomic_write_json(
            meta_path,
            {
                "version": 1,
                "word": word,
                "accent": accent,
                "mimeType": mime,
                "bytes": len(payload),
                "sourceUrl": phonetic.get("sourceUrl") or "",
                "license": {
                    "name": (phonetic.get("license") or {}).get("name", "")
                    if isinstance(phonetic.get("license"), dict)
                    else "",
                    "url": (phonetic.get("license") or {}).get("url", "")
                    if isinstance(phonetic.get("license"), dict)
                    else "",
                },
                "provider": PROVIDER_NAME,
                "cachedAt": self.clock(),
            },
        )
        return audio_path, mime


DICTIONARY_SERVICE = DictionaryService()
