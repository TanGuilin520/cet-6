"""Explicit, bounded import of the user's public translation study notes.

GET is cache-only. Only an explicit, same-origin POST refresh can download the
one allowlisted public Markdown file. These are personal course notes, never
official exam explanations; the original document stays in private runtime
data rather than being vendored into the application's public assets.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
import socket
import tempfile
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from .retrieval import get_retriever


PROJECT_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = PROJECT_ROOT / "data" / "learning-methods"
SOURCE_ID = "cet6-translation-notes"
SOURCE_REPOSITORY_URL = "https://github.com/TanGuilin520/CET6-Translation-Notes"
SOURCE_PATH = "/TanGuilin520/CET6-Translation-Notes/master/%E7%BF%BB%E8%AF%91.md"
SOURCE_RAW_URL = "https://raw.githubusercontent.com" + SOURCE_PATH
SOURCE_FILE_URL = SOURCE_REPOSITORY_URL + "/blob/master/%E7%BF%BB%E8%AF%91.md"
MAX_SOURCE_BYTES = 256 * 1024
MAX_CACHE_BYTES = 1024 * 1024
DOWNLOAD_TIMEOUT_SECONDS = 8
MAX_REFRESH_REQUEST_BYTES = 1024
API_PATH = "/api/learning-methods/translation-notes"
ATTRIBUTION = "糯糯不爱吃糖根据四六级邹老师授课内容整理；仓库维护：TanGuilin520"
SOURCE_CAUTION = "个人学习笔记与课程整理，不是官方答案解析；例句保留原文，使用时请结合上下文核对。"

# The actual source uses numbered H2 headings, not its H3 examples/types. Also
# accept explicit H1/H2 '第N节/章' headings without guessing missing chapters.
SECTION_HEADING = re.compile(
    r"^#{1,2}[ \t]+(?:第[ \t]*(?P<chapter>[0-9]{1,2})[ \t]*[节章][ \t]*"
    r"|(?P<number>[0-9]{1,2})[ \t]*[.．、]?[ \t]*)(?P<label>[^0-9\s].*)$"
)
ENGLISH_WORD = re.compile(r"\b[A-Za-z][A-Za-z'-]{1,24}\b")
STOP_WORDS = frozenset({
    "the", "and", "for", "are", "was", "were", "that", "this", "which",
    "who", "what", "from", "into", "they", "their", "its", "his", "her",
    "has", "had", "not", "you", "your", "our", "can", "been", "will",
    "would", "there", "such", "one", "some", "than", "then", "also",
})


class LearningMethodsError(Exception):
    """Safe user-facing error; never contains proxy credentials or raw URLs."""

    def __init__(
        self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST,
        code: str = "invalid_request",
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code


def source_metadata() -> dict[str, object]:
    return {
        "id": SOURCE_ID,
        "repositoryUrl": SOURCE_REPOSITORY_URL,
        "fileUrl": SOURCE_FILE_URL,
        "rawUrl": SOURCE_RAW_URL,
        "branch": "master",
        "kind": "personal_notes",
        "attribution": ATTRIBUTION,
        "caution": SOURCE_CAUTION,
    }


def _allowed_source_url(url: str) -> bool:
    parsed = urlparse(url)
    return (
        parsed.scheme == "https"
        and parsed.netloc == "raw.githubusercontent.com"
        and parsed.path == SOURCE_PATH
        and not parsed.query
        and not parsed.fragment
    )


class _AllowedSourceRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        if not _allowed_source_url(new_url):
            raise LearningMethodsError(
                "学习资料下载发生了不允许的跳转，请稍后重试。",
                HTTPStatus.BAD_GATEWAY, "unsafe_redirect",
            )
        return super().redirect_request(request, fp, code, message, headers, new_url)


def _download_source() -> bytes:
    """Fetch the fixed public source, using normal host HTTPS proxy settings.

    No application secrets, API tokens, arbitrary URL, or browser-supplied
    headers are passed. Low-level errors are intentionally not propagated.
    """
    opener = build_opener(ProxyHandler(), _AllowedSourceRedirectHandler())
    request = Request(SOURCE_RAW_URL, headers={
        "Accept": "text/plain",
        "User-Agent": "CET-Learning-Methods/1.0",
    }, method="GET")
    deadline = time.monotonic() + DOWNLOAD_TIMEOUT_SECONDS
    try:
        with opener.open(request, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            if not _allowed_source_url(response.geturl()):
                raise LearningMethodsError(
                    "学习资料来源校验失败，未导入内容。",
                    HTTPStatus.BAD_GATEWAY, "unsafe_source",
                )
            if response.getcode() != HTTPStatus.OK:
                raise LearningMethodsError(
                    "公开学习资料暂时无法下载，请稍后重试。",
                    HTTPStatus.BAD_GATEWAY, "download_failed",
                )
            raw_length = response.headers.get("Content-Length")
            if raw_length is not None:
                try:
                    length = int(raw_length)
                except (TypeError, ValueError):
                    raise LearningMethodsError(
                        "资料服务器返回了无效文件信息。",
                        HTTPStatus.BAD_GATEWAY, "invalid_response",
                    ) from None
                if length < 0 or length > MAX_SOURCE_BYTES:
                    raise LearningMethodsError(
                        "学习资料超过 256 KB 导入上限，未更新已有内容。",
                        HTTPStatus.BAD_GATEWAY, "source_too_large",
                    )
            chunks: list[bytes] = []
            size = 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError
                # HTTPResponse.read1 returns after one socket read. Tighten the
                # socket timeout so several chunks cannot each consume 8 sec.
                raw_socket = getattr(getattr(getattr(response, "fp", None), "raw", None), "_sock", None)
                if raw_socket is not None:
                    raw_socket.settimeout(remaining)
                read = getattr(response, "read1", response.read)
                chunk = read(min(64 * 1024, MAX_SOURCE_BYTES + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > MAX_SOURCE_BYTES:
                    raise LearningMethodsError(
                        "学习资料超过 256 KB 导入上限，未更新已有内容。",
                        HTTPStatus.BAD_GATEWAY, "source_too_large",
                    )
            if raw_length is not None and size != length:
                raise LearningMethodsError(
                    "学习资料下载不完整，未更新已有内容，请重试。",
                    HTTPStatus.BAD_GATEWAY, "incomplete_download",
                )
            return b"".join(chunks)
    except LearningMethodsError:
        raise
    except (TimeoutError, socket.timeout):
        raise LearningMethodsError(
            "下载学习资料超时（8 秒），请检查网络后重试。",
            HTTPStatus.GATEWAY_TIMEOUT, "download_timeout",
        ) from None
    except URLError as error:
        timed_out = isinstance(error.reason, (TimeoutError, socket.timeout))
        raise LearningMethodsError(
            "下载学习资料超时（8 秒），请检查网络后重试。" if timed_out
            else "暂时无法连接公开学习资料，请检查网络后重试；已有资料仍可使用。",
            HTTPStatus.GATEWAY_TIMEOUT if timed_out else HTTPStatus.BAD_GATEWAY,
            "download_timeout" if timed_out else "download_failed",
        ) from None
    except (HTTPError, HTTPException, OSError, ValueError):
        raise LearningMethodsError(
            "公开学习资料暂时无法下载，请稍后重试；已有资料仍可使用。",
            HTTPStatus.BAD_GATEWAY, "download_failed",
        ) from None


def _category(title: str) -> str:
    if any(word in title for word in ("时态", "被动")):
        return "时态语态"
    if any(word in title for word in ("数字", "时间", "朝代")):
        return "数字与时间"
    if any(word in title for word in ("单词", "词组", "词汇")):
        return "词汇表达"
    if any(word in title for word in ("语序", "提后", "删减", "长名词", "无主语", "无动词", "双动词")):
        return "语序与信息处理"
    return "句型结构"


def _keywords(title: str, body: str) -> list[str]:
    """Deterministic search hints from actual text, not LLM-made methods."""
    quoted = re.findall(r"[“\"‘]([^”\"’]{1,20})[”\"’]", title)
    words: dict[str, int] = {}
    for token in ENGLISH_WORD.findall(body):
        word = token.lower()
        if word not in STOP_WORDS:
            words[word] = words.get(word, 0) + 1
    frequent = sorted(words, key=lambda word: (-words[word], word))[:12]
    return list(dict.fromkeys([*quoted, title, *frequent]))


def parse_translation_markdown(markdown: str) -> list[dict[str, object]]:
    """Split real numbered chapters, retaining all original examples verbatim."""
    if not isinstance(markdown, str) or "\x00" in markdown:
        raise LearningMethodsError("学习资料不是有效文本。", HTTPStatus.BAD_GATEWAY, "invalid_source")
    if len(markdown.encode("utf-8")) > MAX_SOURCE_BYTES:
        raise LearningMethodsError("学习资料超过 256 KB 导入上限。", HTTPStatus.BAD_GATEWAY, "source_too_large")
    cards: list[dict[str, object]] = []
    seen: set[int] = set()
    current: tuple[int, str] | None = None
    body_lines: list[str] = []
    fence: tuple[str, int] | None = None

    def finish() -> None:
        if current is None:
            return
        number, title = current
        body = "".join(body_lines).strip("\r\n")
        if not body.strip():
            raise LearningMethodsError(
                "学习资料存在空章节，请检查源文件后重试。",
                HTTPStatus.BAD_GATEWAY, "invalid_sections",
            )
        cards.append({
            "id": f"cet6-translation-section-{number:02d}",
            "title": title,
            "category": _category(title),
            "bodyMarkdown": body,
            "keywords": _keywords(title, body),
        })

    for line in markdown.splitlines(keepends=True):
        clean_line = line.rstrip("\r\n")
        fence_line = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", clean_line)
        in_fence = fence is not None
        if fence_line:
            delimiter, tail = fence_line.groups()
            if fence is None:
                fence = (delimiter[0], len(delimiter))
                in_fence = True
            elif delimiter[0] == fence[0] and len(delimiter) >= fence[1] and not tail.strip():
                fence = None
        heading = None if in_fence or fence_line else SECTION_HEADING.fullmatch(clean_line)
        if heading:
            number = int(heading.group("chapter") or heading.group("number"))
            if number == 0 or number in seen:
                raise LearningMethodsError(
                    "学习资料的章节编号无效或重复，未更新已有内容。",
                    HTTPStatus.BAD_GATEWAY, "invalid_sections",
                )
            finish()
            seen.add(number)
            title = re.sub(r"^#{1,2}[ \t]+", "", clean_line).strip()
            current = (number, title)
            body_lines = []
        elif current is not None:
            body_lines.append(line)
    finish()
    if not cards:
        raise LearningMethodsError(
            "没有找到资料中的编号章节，未猜测或补写学习方法。",
            HTTPStatus.BAD_GATEWAY, "invalid_sections",
        )
    return cards


def _retrieval_tokens(value: str) -> set[str]:
    english = {token.lower() for token in ENGLISH_WORD.findall(value) if token.lower() not in STOP_WORDS}
    chinese: set[str] = set()
    for segment in re.findall(r"[\u3400-\u9fff]{2,}", value):
        chinese.update(segment[index:index + 2] for index in range(len(segment) - 1))
    return english | chinese


def _hash_vector(tokens: set[str]) -> list[float]:
    vector = [0.0] * 256
    for token in sorted(tokens):
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        vector[int.from_bytes(digest[:2], "big") % len(vector)] += 1.0 if digest[2] & 1 else -1.0
    magnitude = math.sqrt(sum(value * value for value in vector))
    return [value / magnitude if magnitude else 0.0 for value in vector]


class LearningMethodsService:
    def __init__(self, cache_dir: Path | None = None) -> None:
        self.cache_dir = Path(cache_dir) if cache_dir is not None else CACHE_DIR
        self.cache_path = self.cache_dir / "translation-notes.json"
        self._refresh_lock = threading.Lock()

    def cached_document(self) -> dict[str, object]:
        empty = {"status": "not_imported", "source": source_metadata(), "cards": [], "count": 0}
        try:
            with self.cache_path.open("rb") as source_file:
                raw = source_file.read(MAX_CACHE_BYTES + 1)
            if len(raw) > MAX_CACHE_BYTES:
                raise ValueError
            cached = json.loads(raw.decode("utf-8"))
            if not isinstance(cached, dict) or cached.get("schemaVersion") != 1:
                raise ValueError
            source = cached.get("source")
            markdown = cached.get("sourceMarkdown")
            if not isinstance(source, dict) or not isinstance(markdown, str):
                raise ValueError
            source_bytes = markdown.encode("utf-8")
            if len(source_bytes) > MAX_SOURCE_BYTES:
                raise ValueError
            digest = hashlib.sha256(source_bytes).hexdigest()
            if source.get("sha256") != digest or source.get("rawUrl") != SOURCE_RAW_URL:
                raise ValueError
            fetched_at = source.get("fetchedAt")
            if not isinstance(fetched_at, str) or len(fetched_at) > 40:
                raise ValueError
            stamp = datetime.fromisoformat(fetched_at.replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                raise ValueError
            cards = parse_translation_markdown(markdown)
            metadata = {**source_metadata(), "fetchedAt": fetched_at, "sha256": digest}
            return {"status": "ready", "source": metadata, "cards": cards, "count": len(cards)}
        except FileNotFoundError:
            return empty
        except (OSError, ValueError, UnicodeError, LearningMethodsError):
            # Reading a broken cache must neither overwrite it nor fetch online.
            return {**empty, "errorCode": "cache_unavailable", "error": "本地资料缓存不可用，请重新从 GitHub 加载。"}

    def retrieve(self, query: str, method_ids: list[str], maximum: int = 4) -> list[dict[str, object]]:
        """Read-only hybrid retrieval from the validated cache; never downloads.

        Exact selected IDs precede BM25/hash-lexical supplements, plus optional
        offline local semantic evidence when explicitly configured and ready.
        The namespace pins the validated public-source fingerprint. These
        records are personal study notes, never official answer evidence.
        """
        document = self.cached_document()
        cards = document.get("cards", [])
        if document.get("status") in {"not_imported", "cache_unavailable"} or not isinstance(cards, list):
            return []
        corpus: list[dict[str, object]] = []
        for card in cards:
            if not isinstance(card, dict):
                continue
            method_id = str(card.get("id") or "")
            title = str(card.get("title") or "")
            body = str(card.get("bodyMarkdown") or "")
            corpus.append({"id": method_id, "title": title[:160], "kind": "learning_method",
                           "text": (title + "\n" + body)[:4_000], "body": body[:4_000], "sourceUrl": SOURCE_FILE_URL})
        source = document.get("source", {})
        revision = str(source.get("sha256") or hashlib.sha256(json.dumps(cards, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest())
        result = get_retriever().rank(query[:8_000], corpus, namespace=f"methods:{SOURCE_ID}:{revision}",
                                      exact_ids=method_ids, top_k=max(1, min(20, maximum)))
        return [{"id": item["id"], "title": item["title"], "kind": item["kind"], "text": item["body"],
                 "sourceUrl": item["sourceUrl"], "exact": item["exact"], "score": item["score"]}
                for item in result["documents"]][:maximum]

    def refresh(self) -> dict[str, object]:
        if not self._refresh_lock.acquire(blocking=False):
            raise LearningMethodsError("学习资料正在更新，请稍候。", HTTPStatus.CONFLICT, "refresh_in_progress")
        try:
            raw = _download_source()
            if not raw or len(raw) > MAX_SOURCE_BYTES:
                raise LearningMethodsError(
                    "公开学习资料为空或超过 256 KB 上限。", HTTPStatus.BAD_GATEWAY, "invalid_source",
                )
            try:
                markdown = raw.decode("utf-8", errors="strict")
            except UnicodeError:
                raise LearningMethodsError(
                    "学习资料不是有效 UTF-8 文本，未更新已有内容。",
                    HTTPStatus.BAD_GATEWAY, "invalid_encoding",
                ) from None
            cards = parse_translation_markdown(markdown)
            metadata = {
                **source_metadata(),
                "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "sha256": hashlib.sha256(raw).hexdigest(),
            }
            cached = {"schemaVersion": 1, "source": metadata, "sourceMarkdown": markdown, "cards": cards}
            self._write_cache(cached)
            return {"status": "ready", "source": metadata, "cards": cards, "count": len(cards)}
        finally:
            self._refresh_lock.release()

    def _write_cache(self, document: dict[str, object]) -> None:
        temporary_path: Path | None = None
        try:
            payload = json.dumps(document, ensure_ascii=False).encode("utf-8")
            if len(payload) > MAX_CACHE_BYTES:
                raise OSError
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(mode="wb", prefix=".translation-notes-", suffix=".tmp", dir=self.cache_dir, delete=False) as output:
                temporary_path = Path(output.name)
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary_path, self.cache_path)
            temporary_path = None
        except OSError:
            raise LearningMethodsError(
                "学习资料已读取，但本地保存失败；已有资料未被替换。",
                HTTPStatus.INTERNAL_SERVER_ERROR, "cache_write_failed",
            ) from None
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    pass


class LearningMethodsAPI:
    def __init__(self, service: LearningMethodsService | None = None) -> None:
        self.service = service or LearningMethodsService()

    @staticmethod
    def _is_our_route(parsed) -> bool:
        return parsed.path == "/api/learning-methods" or parsed.path.startswith("/api/learning-methods/")

    def handle_get(self, handler, parsed, include_body: bool = True) -> bool:
        if not self._is_our_route(parsed):
            return False
        if parsed.query:
            self._error(handler, LearningMethodsError("学习资料接口不接受查询参数。"), include_body)
        elif parsed.path.rstrip("/") == API_PATH:
            handler._json_response(HTTPStatus.OK, self.service.cached_document(), include_body=include_body)
        elif parsed.path.rstrip("/") == API_PATH + "/refresh":
            self._error(handler, LearningMethodsError("请点击加载按钮更新资料。", HTTPStatus.METHOD_NOT_ALLOWED, "method_not_allowed"), include_body)
        else:
            self._error(handler, LearningMethodsError("学习资料接口不存在。", HTTPStatus.NOT_FOUND, "not_found"), include_body)
        return True

    def handle_post(self, handler, parsed) -> bool:
        if not self._is_our_route(parsed):
            return False
        try:
            if parsed.query:
                raise LearningMethodsError("学习资料接口不接受查询参数。")
            if parsed.path.rstrip("/") != API_PATH + "/refresh":
                raise LearningMethodsError("学习资料接口不存在。", HTTPStatus.NOT_FOUND, "not_found")
            if not handler._request_is_same_origin():
                raise LearningMethodsError("不允许跨站更新学习资料。", HTTPStatus.FORBIDDEN, "cross_origin")
            self._read_empty_body(handler)
            handler._json_response(HTTPStatus.OK, self.service.refresh())
        except LearningMethodsError as error:
            self._error(handler, error)
        return True

    @staticmethod
    def _read_empty_body(handler) -> None:
        if handler.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise LearningMethodsError("请求需要 JSON 格式。", HTTPStatus.UNSUPPORTED_MEDIA_TYPE)
        raw_length = handler.headers.get("Content-Length")
        if raw_length is None:
            raise LearningMethodsError("请求缺少正文长度。", HTTPStatus.LENGTH_REQUIRED)
        try:
            length = int(raw_length)
        except ValueError:
            raise LearningMethodsError("请求正文长度无效。") from None
        if length <= 0:
            raise LearningMethodsError("请发送空 JSON 对象。")
        if length > MAX_REFRESH_REQUEST_BYTES:
            raise LearningMethodsError("请求过大。", HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
        raw = handler.rfile.read(length)
        if len(raw) != length:
            raise LearningMethodsError("请求正文不完整。")
        try:
            document = json.loads(raw.decode("utf-8", errors="strict"))
        except (ValueError, UnicodeError):
            raise LearningMethodsError("请求需要有效 UTF-8 JSON。") from None
        if not isinstance(document, dict) or document:
            raise LearningMethodsError("此接口只接受空 JSON 对象，不允许指定网址或其他参数。")

    def _error(self, handler, error: LearningMethodsError, include_body: bool = True) -> None:
        handler._json_response(error.status, {
            "error": error.message,
            "errorCode": error.code,
            "cachedAvailable": self.service.cached_document()["status"] == "ready",
        }, include_body=include_body)


LEARNING_METHODS_API = LearningMethodsAPI()
