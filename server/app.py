#!/usr/bin/env python3
"""Local development server for the Reading Lab prototype.

Besides static files, it exposes two same-origin endpoints:

* ``/api/tts?word=WORD`` creates and caches a short WAV pronunciation with
  the local ``flite`` engine.
* ``POST /api/deepseek`` proxies bounded chat requests to DeepSeek without
  exposing the API key to browser code.

The DeepSeek key and model are read from the process environment or a local
``.env`` file.  The upstream URL is deliberately fixed in this module so a
browser request cannot turn the proxy into an arbitrary URL fetcher.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

from .dictionary import DICTIONARY_SERVICE, DictionaryError
from .platform import PLATFORM_API

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = PROJECT_ROOT / "public"
CACHE_DIR = PUBLIC_DIR / "assets" / "audio" / "cache"
VALID_WORD = re.compile(r"^[A-Za-z](?:[A-Za-z'-]{0,78}[A-Za-z])?$")
VALID_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions"
DEEPSEEK_SYSTEM_PROMPT = (
    "You are a concise CET English learning assistant. Help the learner "
    "understand vocabulary, grammar, passages, and questions. Reply in the "
    "language used by the learner and clearly distinguish quoted evidence "
    "from your explanation."
)
MAX_CHAT_REQUEST_BYTES = 64 * 1024
MAX_CHAT_MESSAGES = 24
# A contextual user turn can contain a passage plus the learner's question and
# short section labels while remaining bounded for the upstream request.
MAX_CHAT_MESSAGE_CHARS = 12_000
MAX_CHAT_TOTAL_CHARS = 32_000
DEEPSEEK_TIMEOUT_SECONDS = 60
ALLOWED_DEEPSEEK_MODELS = frozenset({"deepseek-chat", "deepseek-reasoner"})
DEEPSEEK_KEY_PLACEHOLDERS = frozenset(
    {"YOUR_DEEPSEEK_API_KEY", "PASTE_YOUR_DEEPSEEK_API_KEY_HERE"}
)


def load_project_env(path: Path) -> None:
    """Load a small, dependency-free subset of dotenv syntax.

    Existing process variables always win.  This parser intentionally accepts
    only simple ``NAME=value`` assignments; it does not execute shell syntax or
    expand variables from the file.
    """

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return
    except OSError as error:
        print(f"Warning: could not read {path.name}: {error}", file=sys.stderr)
        return

    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        if "=" not in line:
            continue
        name, value = line.split("=", 1)
        name = name.strip()
        if not VALID_ENV_NAME.fullmatch(name):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        os.environ.setdefault(name, value)


load_project_env(PROJECT_ROOT / ".env")


def configured_deepseek_key() -> str:
    """Return the configured secret, or an empty string for template values."""

    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    return "" if api_key in DEEPSEEK_KEY_PLACEHOLDERS else api_key


class ReadingLabHandler(SimpleHTTPRequestHandler):
    """Serve the local prototype, pronunciation, and DeepSeek proxy."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def end_headers(self) -> None:
        # This is a local development server: HTML, JavaScript and CSS change
        # frequently and must never leave a tab running a mixed old/new UI.
        # Paper images and generated audio keep their normal cache behavior.
        static_path = urlparse(self.path).path
        if static_path == "/" or Path(static_path).suffix.lower() in {".html", ".js", ".css"}:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format: str, *args) -> None:
        # Keep the development console focused on startup and genuine errors.
        if self.path.startswith((
            "/api/tts",
            "/api/deepseek",
            "/api/chat",
            "/api/exams",
            "/api/papers",
            "/api/dictionary",
            "/api/pronunciation",
        )):
            return
        super().log_message(format, *args)

    def do_GET(self) -> None:  # noqa: N802 - inherited stdlib API
        parsed = urlparse(self.path)
        if PLATFORM_API.handle_get(self, parsed, include_body=True):
            return
        if parsed.path == "/api/tts":
            self._serve_tts(parse_qs(parsed.query), include_body=True)
            return
        if parsed.path == "/api/dictionary":
            self._serve_dictionary(parse_qs(parsed.query), include_body=True)
            return
        if parsed.path == "/api/pronunciation":
            self._serve_pronunciation(parse_qs(parsed.query), include_body=True)
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802 - inherited stdlib API
        parsed = urlparse(self.path)
        if PLATFORM_API.handle_get(self, parsed, include_body=False):
            return
        if parsed.path == "/api/tts":
            self._serve_tts(parse_qs(parsed.query), include_body=False)
            return
        if parsed.path == "/api/dictionary":
            self._serve_dictionary(parse_qs(parsed.query), include_body=False)
            return
        if parsed.path == "/api/pronunciation":
            self._serve_pronunciation(parse_qs(parsed.query), include_body=False)
            return
        super().do_HEAD()

    def do_POST(self) -> None:  # noqa: N802 - inherited stdlib API
        parsed = urlparse(self.path)
        if PLATFORM_API.handle_post(self, parsed):
            return
        if parsed.path in {"/api/deepseek", "/api/chat"}:
            if parsed.query:
                self._json_error(HTTPStatus.BAD_REQUEST, "query parameters are not supported")
                return
            self._serve_deepseek()
            return
        self._json_error(HTTPStatus.NOT_FOUND, "API endpoint not found")

    def do_PATCH(self) -> None:  # noqa: N802 - inherited stdlib API
        parsed = urlparse(self.path)
        if PLATFORM_API.handle_patch(self, parsed):
            return
        self._json_error(HTTPStatus.NOT_FOUND, "API endpoint not found")

    def _json_response(
        self,
        status: HTTPStatus,
        body: dict[str, object],
        include_body: bool = True,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if include_body:
            self.wfile.write(payload)

    def _json_error(self, status: HTTPStatus, message: str) -> None:
        self._json_response(status, {"error": message})

    def _request_is_same_origin(self) -> bool:
        """Allow browser calls only from the host serving this page.

        Command-line clients generally omit ``Origin`` and remain supported.
        Requiring the browser origin to match prevents an unrelated web page
        from silently spending the API key configured on this local server.
        """

        origin = self.headers.get("Origin")
        if not origin:
            return True
        parsed_origin = urlparse(origin)
        request_host = self.headers.get("Host", "").strip().lower()
        return (
            parsed_origin.scheme in {"http", "https"}
            and bool(request_host)
            and parsed_origin.netloc.lower() == request_host
        )

    def _read_chat_request(self) -> tuple[str, list[dict[str, str]]] | None:
        content_type = self.headers.get("Content-Type", "")
        media_type = content_type.split(";", 1)[0].strip().lower()
        if media_type != "application/json":
            self._json_error(
                HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                "Content-Type must be application/json",
            )
            return None

        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            self._json_error(HTTPStatus.LENGTH_REQUIRED, "Content-Length is required")
            return None
        try:
            content_length = int(raw_length)
        except ValueError:
            self._json_error(HTTPStatus.BAD_REQUEST, "invalid Content-Length")
            return None
        if content_length <= 0:
            self._json_error(HTTPStatus.BAD_REQUEST, "request body must not be empty")
            return None
        if content_length > MAX_CHAT_REQUEST_BYTES:
            self._json_error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body is too large")
            return None

        body = self.rfile.read(content_length)
        if len(body) != content_length:
            self._json_error(HTTPStatus.BAD_REQUEST, "incomplete request body")
            return None
        try:
            document = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._json_error(HTTPStatus.BAD_REQUEST, "request body must be valid UTF-8 JSON")
            return None

        if not isinstance(document, dict):
            self._json_error(HTTPStatus.BAD_REQUEST, "request body must be a JSON object")
            return None
        if set(document) - {"messages", "model"}:
            self._json_error(HTTPStatus.BAD_REQUEST, "request contains unsupported fields")
            return None

        configured_model = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat").strip()
        model = document.get("model", configured_model)
        if not isinstance(model, str) or model not in ALLOWED_DEEPSEEK_MODELS:
            self._json_error(
                HTTPStatus.BAD_REQUEST,
                "model must be deepseek-chat or deepseek-reasoner",
            )
            return None

        messages = document.get("messages")
        if not isinstance(messages, list) or not messages:
            self._json_error(HTTPStatus.BAD_REQUEST, "messages must be a non-empty array")
            return None
        if len(messages) > MAX_CHAT_MESSAGES:
            self._json_error(
                HTTPStatus.BAD_REQUEST,
                f"messages may contain at most {MAX_CHAT_MESSAGES} items",
            )
            return None

        cleaned_messages: list[dict[str, str]] = []
        total_characters = 0
        for index, message in enumerate(messages):
            if not isinstance(message, dict):
                self._json_error(HTTPStatus.BAD_REQUEST, f"messages[{index}] must be an object")
                return None
            if set(message) != {"role", "content"}:
                self._json_error(
                    HTTPStatus.BAD_REQUEST,
                    f"messages[{index}] must contain only role and content",
                )
                return None
            role = message.get("role")
            content = message.get("content")
            if role not in {"user", "assistant"}:
                self._json_error(
                    HTTPStatus.BAD_REQUEST,
                    f"messages[{index}].role must be user or assistant",
                )
                return None
            if not isinstance(content, str) or not content.strip():
                self._json_error(
                    HTTPStatus.BAD_REQUEST,
                    f"messages[{index}].content must be a non-empty string",
                )
                return None
            content = content.strip()
            if len(content) > MAX_CHAT_MESSAGE_CHARS:
                self._json_error(
                    HTTPStatus.BAD_REQUEST,
                    f"messages[{index}].content is too long",
                )
                return None
            total_characters += len(content)
            if total_characters > MAX_CHAT_TOTAL_CHARS:
                self._json_error(HTTPStatus.BAD_REQUEST, "combined message content is too long")
                return None
            cleaned_messages.append({"role": role, "content": content})

        if cleaned_messages[-1]["role"] != "user":
            self._json_error(HTTPStatus.BAD_REQUEST, "the final message must have role user")
            return None
        return model, cleaned_messages

    def _serve_deepseek(self) -> None:
        if not self._request_is_same_origin():
            self._json_error(HTTPStatus.FORBIDDEN, "cross-origin requests are not allowed")
            return

        chat_request = self._read_chat_request()
        if chat_request is None:
            return
        model, messages = chat_request

        api_key = configured_deepseek_key()
        if not api_key:
            self._json_error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "DeepSeek is not configured; set DEEPSEEK_API_KEY in .env and restart the server",
            )
            return

        upstream_body = json.dumps(
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": DEEPSEEK_SYSTEM_PROMPT},
                    *messages,
                ],
                "stream": False,
                "temperature": 0.4,
                "max_tokens": 1_200,
            },
            ensure_ascii=False,
        ).encode("utf-8")
        upstream_request = Request(
            DEEPSEEK_API_URL,
            data=upstream_body,
            method="POST",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "ReadingLab/1.0",
            },
        )

        try:
            with urlopen(upstream_request, timeout=DEEPSEEK_TIMEOUT_SECONDS) as response:
                response_body = response.read(MAX_CHAT_REQUEST_BYTES + 1)
        except HTTPError as error:
            # Consume a small amount so the connection can be cleaned up, but
            # never forward provider diagnostics or credentials to the browser.
            try:
                error.read(4_096)
            except OSError:
                pass
            if error.code == HTTPStatus.TOO_MANY_REQUESTS:
                self._json_error(HTTPStatus.TOO_MANY_REQUESTS, "DeepSeek rate limit reached; try again later")
            elif error.code in {HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN}:
                self._json_error(HTTPStatus.BAD_GATEWAY, "DeepSeek rejected the server credentials")
            else:
                self._json_error(HTTPStatus.BAD_GATEWAY, "DeepSeek request failed")
            return
        except (TimeoutError, socket.timeout):
            self._json_error(HTTPStatus.GATEWAY_TIMEOUT, "DeepSeek request timed out")
            return
        except (URLError, OSError):
            self._json_error(HTTPStatus.BAD_GATEWAY, "DeepSeek is currently unavailable")
            return

        if len(response_body) > MAX_CHAT_REQUEST_BYTES:
            self._json_error(HTTPStatus.BAD_GATEWAY, "DeepSeek response is too large")
            return
        try:
            upstream_document = json.loads(response_body.decode("utf-8"))
            reply = upstream_document["choices"][0]["message"]["content"]
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError):
            self._json_error(HTTPStatus.BAD_GATEWAY, "DeepSeek returned an invalid response")
            return
        if not isinstance(reply, str) or not reply.strip():
            self._json_error(HTTPStatus.BAD_GATEWAY, "DeepSeek returned an empty response")
            return

        self._json_response(HTTPStatus.OK, {"reply": reply.strip()})

    def _serve_tts(self, query: dict[str, list[str]], include_body: bool) -> None:
        words = query.get("word") or []
        raw_word = words[0].strip() if len(words) == 1 else ""
        if not VALID_WORD.fullmatch(raw_word):
            self._json_error(HTTPStatus.BAD_REQUEST, "word must be a short English word")
            return

        flite = shutil.which("flite")
        if not flite:
            self._json_error(HTTPStatus.SERVICE_UNAVAILABLE, "local flite engine is not installed")
            return

        normalized = raw_word.lower()
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:24]
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        output = CACHE_DIR / f"{digest}.wav"

        def is_valid_wav(path: Path) -> bool:
            try:
                size = path.stat().st_size
                with path.open("rb") as audio_file:
                    header = audio_file.read(12)
                return 44 <= size <= 2_000_000 and header[:4] == b"RIFF" and header[8:12] == b"WAVE"
            except OSError:
                return False

        if not is_valid_wav(output):
            temporary = CACHE_DIR / f".{digest}.{id(self)}.wav"
            try:
                result = subprocess.run(
                    [flite, "-t", normalized, "-o", str(temporary)],
                    check=False,
                    capture_output=True,
                    timeout=12,
                )
                if result.returncode != 0 or not is_valid_wav(temporary):
                    temporary.unlink(missing_ok=True)
                    self._json_error(HTTPStatus.INTERNAL_SERVER_ERROR, "could not generate pronunciation audio")
                    return
                temporary.replace(output)
            except (OSError, subprocess.TimeoutExpired):
                temporary.unlink(missing_ok=True)
                self._json_error(HTTPStatus.INTERNAL_SERVER_ERROR, "could not generate pronunciation audio")
                return

        payload = output.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if include_body:
            self.wfile.write(payload)

    @staticmethod
    def _single_query_value(query: dict[str, list[str]], name: str) -> str:
        values = query.get(name) or []
        return values[0].strip() if len(values) == 1 else ""

    def _serve_dictionary(self, query: dict[str, list[str]], include_body: bool) -> None:
        raw_word = self._single_query_value(query, "word")
        try:
            payload = DICTIONARY_SERVICE.lookup(raw_word)
        except DictionaryError as error:
            self._json_error(error.status, error.message)
            return
        except Exception:  # never let one lookup take the whole server down
            self._json_error(HTTPStatus.INTERNAL_SERVER_ERROR, "dictionary lookup failed unexpectedly")
            return
        self._json_response(HTTPStatus.OK, payload, include_body=include_body)

    def _serve_pronunciation(self, query: dict[str, list[str]], include_body: bool) -> None:
        raw_word = self._single_query_value(query, "word")
        raw_accent = self._single_query_value(query, "accent")
        try:
            audio_path, mime = DICTIONARY_SERVICE.pronunciation(raw_word, raw_accent)
        except DictionaryError as error:
            self._json_error(error.status, error.message)
            return
        except Exception:
            self._json_error(HTTPStatus.INTERNAL_SERVER_ERROR, "pronunciation lookup failed unexpectedly")
            return
        try:
            payload = audio_path.read_bytes()
        except OSError:
            self._json_error(HTTPStatus.INTERNAL_SERVER_ERROR, "cached pronunciation is unreadable")
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if include_body:
            self.wfile.write(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve Reading Lab with local TTS and a DeepSeek proxy.")
    parser.add_argument("--host", default="127.0.0.1", help="host interface (default: 127.0.0.1)")
    parser.add_argument("--port", default=4173, type=int, help="TCP port (default: 4173)")
    args = parser.parse_args()

    with ThreadingHTTPServer((args.host, args.port), ReadingLabHandler) as server:
        print(f"Reading Lab is running at http://{args.host}:{args.port}")
        print("Word pronunciation endpoint: /api/tts?word=example")
        print("DeepSeek chat endpoint: POST /api/deepseek")
        if not configured_deepseek_key():
            print("DeepSeek is disabled until DEEPSEEK_API_KEY is set in .env or the environment.")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
