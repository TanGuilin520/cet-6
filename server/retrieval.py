"""Bounded hybrid retrieval with an optional, loopback-only local encoder.

The default is explicitly lexical/hash retrieval, NOT semantic embeddings. ML
dependencies live in a separate optional service. Neither this module nor that
service downloads models. The vector cache contains hashes/vectors, never text,
and is partitioned by caller-supplied exam revision or public-method revision.
"""

from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import os
import re
import sqlite3
import threading
import time
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


MAX_DOCUMENTS = 10_000
MAX_TEXT_CHARS = 4_000
MAX_QUERY_CHARS = 8_000
MAX_NEW_DOCUMENTS = 128
MAX_DIMENSION = 4_096
SEMANTIC_BUDGET_SECONDS = 8.0
TOKEN = re.compile(r"[a-zA-Z][a-zA-Z'-]{1,30}|[0-9]+|[\u3400-\u9fff]+")
NAMESPACE = re.compile(r"(?:exam|methods):[A-Za-z0-9_.-]{1,120}:[A-Za-z0-9_.-]{1,128}\Z")
STOP_WORDS = frozenset({"the", "a", "an", "and", "or", "is", "are", "was", "were", "of", "to", "for", "in", "on", "it", "this", "that", "with"})
PROJECT_ROOT = Path(__file__).resolve().parent.parent


class RetrievalError(ValueError):
    """Safe retrieval/protocol error, containing no URLs, credentials or text."""


def tokens(text: str) -> list[str]:
    result: list[str] = []
    for token in TOKEN.findall(text.lower()):
        if re.fullmatch(r"[\u3400-\u9fff]+", token):
            if len(token) == 1:
                result.append(token)
            else:
                result.extend(token[index:index + 2] for index in range(len(token) - 1))
        elif token not in STOP_WORDS:
            result.append(token)
    return result


def _normalized(vector: object, dimension: int) -> list[float]:
    if not isinstance(vector, list) or len(vector) != dimension:
        raise RetrievalError("invalid embedding dimension")
    values: list[float] = []
    for value in vector:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise RetrievalError("invalid embedding value")
        values.append(float(value))
    magnitude = math.sqrt(sum(value * value for value in values))
    if not math.isfinite(magnitude) or magnitude <= 0:
        raise RetrievalError("empty embedding")
    return [value / magnitude for value in values]


def _hash_vector(words: list[str], dimension: int = 256) -> list[float]:
    vector = [0.0] * dimension
    for token, count in Counter(words).items():
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        vector[int.from_bytes(digest[:2], "big") % dimension] += (1 if digest[2] & 1 else -1) * math.log1p(count)
    magnitude = math.sqrt(sum(value * value for value in vector))
    return [value / magnitude if magnitude else 0.0 for value in vector]


def _cosine(left: list[float], right: list[float]) -> float:
    return max(-1.0, min(1.0, sum(a * b for a, b in zip(left, right))))


def reciprocal_rank_fusion(rankings: list[list[str]], constant: int = 60) -> dict[str, float]:
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, identifier in enumerate(dict.fromkeys(ranking), 1):
            scores[identifier] = scores.get(identifier, 0.0) + 1.0 / (constant + rank)
    return scores


def _lexical(query: str, documents: list[dict[str, object]]) -> tuple[list[str], list[str]]:
    corpus = {str(document["id"]): tokens(str(document["text"])[:MAX_TEXT_CHARS]) for document in documents}
    lengths = [len(value) for value in corpus.values()]
    average = sum(lengths) / max(1, len(lengths)) or 1.0
    query_words = set(tokens(query))
    frequencies = Counter(token for words in corpus.values() for token in set(words) & query_words)
    query_hash = _hash_vector(list(query_words))
    bm25: list[tuple[float, str]] = []
    hashed: list[tuple[float, str]] = []
    for identifier, words in corpus.items():
        counts = Counter(words)
        score = 0.0
        for word in query_words:
            frequency = counts[word]
            if frequency:
                inverse = math.log(1 + (len(corpus) - frequencies[word] + 0.5) / (frequencies[word] + 0.5))
                score += inverse * frequency * 2.5 / (frequency + 1.5 * (0.25 + 0.75 * len(words) / average))
        if score > 0:
            bm25.append((score, identifier))
            # Hashes supplement lexical evidence only. A hash collision alone
            # must not count as a relevant or semantic hit.
            hash_score = _cosine(query_hash, _hash_vector(words))
            if hash_score >= 0.12:
                hashed.append((hash_score, identifier))
    bm25.sort(key=lambda row: (-row[0], row[1]))
    hashed.sort(key=lambda row: (-row[0], row[1]))
    return [identifier for _, identifier in bm25], [identifier for _, identifier in hashed]


def _loopback_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        address = ipaddress.ip_address(parsed.hostname or "")
        port = parsed.port
    except (ValueError, TypeError):
        raise RetrievalError("embedding service must use a numeric loopback HTTP address") from None
    if (
        parsed.scheme != "http" or not address.is_loopback
        or parsed.hostname not in {"127.0.0.1", "::1"}
        or port is None or not 1024 <= port <= 65535
        or parsed.username is not None or parsed.password is not None
        or parsed.path not in {"", "/"} or parsed.query or parsed.fragment
    ):
        raise RetrievalError("embedding service must use a numeric loopback HTTP address")
    return value.rstrip("/")


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise RetrievalError("embedding service redirect rejected")


class LocalEmbeddingClient:
    """Bounded local HTTP protocol; ignores proxies and rejects redirects."""

    def __init__(self, url: str, token: str = "", timeout: float = 4.0) -> None:
        self.url = _loopback_url(url)
        self.token = token
        self.timeout = min(10.0, max(0.2, float(timeout)))
        self._opener = build_opener(ProxyHandler({}), _NoRedirects())

    def _request(self, path: str, payload: dict[str, object] | None = None) -> dict[str, object]:
        raw = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers = {"Accept": "application/json"}
        if raw is not None:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = Request(self.url + path, data=raw, headers=headers, method="GET" if raw is None else "POST")
        maximum = 16_384 if path == "/healthz" else 8 * 1024 * 1024
        try:
            with self._opener.open(request, timeout=min(1.0, self.timeout) if raw is None else self.timeout) as response:
                if response.geturl() != self.url + path or response.status != 200:
                    raise RetrievalError("embedding service response rejected")
                body = response.read(maximum + 1)
            if len(body) > maximum:
                raise RetrievalError("embedding service response too large")
            result = json.loads(body.decode("utf-8"))
            if not isinstance(result, dict) or result.get("schemaVersion") != 1:
                raise RetrievalError("embedding service protocol mismatch")
            return result
        except RetrievalError:
            raise
        except (OSError, ValueError, UnicodeError):
            raise RetrievalError("local embedding service unavailable") from None

    def health(self) -> dict[str, object]:
        result = self._request("/healthz")
        model = result.get("model")
        fingerprint = result.get("modelFingerprint")
        dimension = result.get("dimension")
        if result.get("ready") is not True:
            return {"ready": False, "reason": "local_model_not_ready"}
        if (
            not isinstance(model, str) or not model or len(model) > 160
            or not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
            or isinstance(dimension, bool) or not isinstance(dimension, int) or not 1 <= dimension <= MAX_DIMENSION
        ):
            raise RetrievalError("local embedding model metadata invalid")
        return {"ready": True, "model": model, "modelFingerprint": fingerprint, "dimension": dimension,
                "rerankerReady": result.get("rerankerReady") is True}

    def embed(self, texts: list[str], model: dict[str, object]) -> list[list[float]]:
        if not texts or len(texts) > MAX_NEW_DOCUMENTS or any(not isinstance(value, str) or not value or len(value) > MAX_TEXT_CHARS for value in texts):
            raise RetrievalError("embedding batch outside limits")
        result = self._request("/v1/embed", {"texts": texts, "modelFingerprint": model["modelFingerprint"]})
        if result.get("modelFingerprint") != model["modelFingerprint"] or result.get("dimension") != model["dimension"]:
            raise RetrievalError("local embedding model changed during request")
        vectors = result.get("vectors")
        if not isinstance(vectors, list) or len(vectors) != len(texts):
            raise RetrievalError("local embedding count mismatch")
        return [_normalized(vector, int(model["dimension"])) for vector in vectors]

    def rerank(self, query: str, texts: list[str], model: dict[str, object]) -> list[float]:
        result = self._request("/v1/rerank", {"query": query[:MAX_TEXT_CHARS], "texts": texts[:20], "modelFingerprint": model["modelFingerprint"]})
        scores = result.get("scores")
        if result.get("modelFingerprint") != model["modelFingerprint"] or not isinstance(scores, list) or len(scores) != min(20, len(texts)):
            raise RetrievalError("local reranker protocol mismatch")
        if any(isinstance(score, bool) or not isinstance(score, (float, int)) or not math.isfinite(score) for score in scores):
            raise RetrievalError("local reranker score invalid")
        return [float(score) for score in scores]


class SemanticCache:
    """Append/update only validated entries; damaged caches remain untouched."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = threading.Lock()

    @staticmethod
    def _key(namespace: str, document: dict[str, object], model: dict[str, object]) -> tuple[str, str, str, str, int]:
        digest = lambda text: hashlib.sha256(text.encode("utf-8")).hexdigest()
        return (digest(namespace), digest(str(document["id"])), digest(str(document["text"])), str(model["modelFingerprint"]), int(model["dimension"]))

    def _connect(self) -> sqlite3.Connection:
        existing = self.path.exists()
        if existing and (not self.path.is_file() or self.path.stat().st_size > 256 * 1024 * 1024):
            raise RetrievalError("semantic cache unavailable")
        if existing:
            connection = sqlite3.connect(f"file:{self.path}?mode=rw", uri=True, timeout=1)
            try:
                if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise RetrievalError("semantic cache damaged")
                columns = [row[1] for row in connection.execute("PRAGMA table_info(vectors)")]
                if columns != ["namespace_hash", "document_hash", "text_hash", "model_hash", "dimension", "vector"]:
                    raise RetrievalError("semantic cache schema mismatch")
                if connection.execute("PRAGMA user_version").fetchone()[0] != 1:
                    raise RetrievalError("semantic cache version mismatch")
            except Exception:
                connection.close()
                raise
        else:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            connection = sqlite3.connect(self.path, timeout=1)
            connection.execute("CREATE TABLE IF NOT EXISTS vectors(namespace_hash TEXT NOT NULL, document_hash TEXT NOT NULL, text_hash TEXT NOT NULL, model_hash TEXT NOT NULL, dimension INTEGER NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(namespace_hash,document_hash,text_hash,model_hash,dimension))")
            connection.execute("PRAGMA user_version=1")
            connection.commit()
            try:
                self.path.chmod(0o600)
            except OSError:
                pass
        return connection

    def read(self, namespace: str, documents: list[dict[str, object]], model: dict[str, object]) -> dict[str, list[float]]:
        if not self.path.exists():
            return {}
        with self._lock:
            connection = self._connect()
            try:
                result: dict[str, list[float]] = {}
                for document in documents:
                    row = connection.execute("SELECT vector FROM vectors WHERE namespace_hash=? AND document_hash=? AND text_hash=? AND model_hash=? AND dimension=?", self._key(namespace, document, model)).fetchone()
                    if row:
                        # Do not replace a corrupt row with a new embedding.
                        result[str(document["id"])] = _normalized(json.loads(row[0]), int(model["dimension"]))
                return result
            finally:
                connection.close()

    def write(self, namespace: str, documents: list[dict[str, object]], model: dict[str, object], vectors: dict[str, list[float]]) -> None:
        with self._lock:
            connection = self._connect()
            try:
                with connection:
                    for document in documents:
                        identifier = str(document["id"])
                        if identifier in vectors:
                            vector = _normalized(vectors[identifier], int(model["dimension"]))
                            connection.execute("INSERT OR IGNORE INTO vectors VALUES (?,?,?,?,?,?)", (*self._key(namespace, document, model), json.dumps(vector, separators=(",", ":"))))
            finally:
                connection.close()


class HybridRetriever:
    def __init__(self, client: LocalEmbeddingClient | None = None, cache_path: Path | None = None, configuration_error: bool = False) -> None:
        self.client = client
        self.cache = SemanticCache(cache_path or PROJECT_ROOT / "data" / "retrieval" / "semantic.sqlite3")
        self.configuration_error = configuration_error
        self._health: dict[str, object] | None = None
        self._health_at = 0.0
        self._health_lock = threading.Lock()

    def status(self, refresh: bool = False) -> dict[str, object]:
        if self.client is None:
            return {"configured": False, "semanticReady": False, "reason": "invalid_loopback_configuration" if self.configuration_error else "not_configured", "mode": "lexical_hash"}
        with self._health_lock:
            if refresh or self._health is None or time.monotonic() - self._health_at > 10:
                try:
                    self._health = self.client.health()
                except (RetrievalError, OSError, ValueError):
                    self._health = {"ready": False, "reason": "local_service_unavailable"}
                self._health_at = time.monotonic()
            health = dict(self._health)
        return {"configured": True, "semanticReady": health.pop("ready", False), "mode": "hybrid_semantic" if self._health.get("ready") else "lexical_hash", **health}

    def rank(self, query: str, documents: list[dict[str, object]], *, namespace: str, top_k: int = 4, exact_ids: list[str] | None = None, required_metadata: dict[str, object] | None = None, persist: bool = True) -> dict[str, object]:
        if not isinstance(query, str) or len(query) > MAX_QUERY_CHARS or "\x00" in query:
            raise RetrievalError("invalid retrieval query")
        if not isinstance(namespace, str) or not NAMESPACE.fullmatch(namespace):
            raise RetrievalError("retrieval requires a revision-pinned exam or method namespace")
        if not isinstance(documents, list) or len(documents) > MAX_DOCUMENTS:
            raise RetrievalError("retrieval corpus outside limits")
        if isinstance(top_k, bool) or not isinstance(top_k, int) or not 1 <= top_k <= 20:
            raise RetrievalError("retrieval limit outside limits")
        required = required_metadata or {}
        selected: set[str] = set(exact_ids or [])
        corpus: list[dict[str, object]] = []
        seen: set[str] = set()
        for document in documents:
            if not isinstance(document, dict) or any(document.get(key) != value for key, value in required.items()):
                continue
            identifier, text = document.get("id"), document.get("text")
            if not isinstance(identifier, str) or not identifier or len(identifier) > 256 or "\x00" in identifier or not isinstance(text, str) or not text.strip() or "\x00" in text:
                continue
            if identifier in seen:
                raise RetrievalError("duplicate retrieval document ID")
            seen.add(identifier)
            corpus.append(dict(document))
        exact = [document for document in corpus if document["id"] in selected]
        exact.sort(key=lambda document: (list(exact_ids or []).index(str(document["id"])), str(document["id"])))
        lexical, hashed = _lexical(query, corpus)
        rankings = [lexical, hashed]
        sources = {identifier: [name for name, ranking in (("bm25", lexical), ("hash_lexical", hashed)) if identifier in ranking] for identifier in seen}
        status = self.status()
        status.update({"cacheStatus": "not_used", "indexedDocuments": 0, "corpusDocuments": len(corpus), "privatePersistence": False})
        semantic: list[str] = []
        if status.get("semanticReady") and self.client and corpus:
            deadline = time.monotonic() + SEMANTIC_BUDGET_SECONDS
            model = {"model": status["model"], "modelFingerprint": status["modelFingerprint"], "dimension": status["dimension"]}
            vectors: dict[str, list[float]] = {}
            cache_allowed = persist is True
            cache_failed = False
            try:
                if cache_allowed:
                    try:
                        vectors = self.cache.read(namespace, corpus, model)
                        status["cacheStatus"] = "ready"
                    except (OSError, ValueError, sqlite3.Error):
                        cache_failed = True
                        status["cacheStatus"] = "unavailable_preserved"
                else:
                    status["cacheStatus"] = "disabled_for_private_context"
                by_id = {str(document["id"]): document for document in corpus}
                # Index at most 128 new chunks per invocation. Cached vectors
                # remain searchable across the whole pinned corpus; when new
                # content exceeds this budget, report partial coverage honestly.
                candidate_ids = list(dict.fromkeys([*(str(document["id"]) for document in exact), *lexical, *sorted(by_id)]))
                missing = [by_id[identifier] for identifier in candidate_ids if identifier not in vectors][:MAX_NEW_DOCUMENTS]
                query_vectors = self.client.embed([query[:MAX_TEXT_CHARS] or " "], model)
                additions: dict[str, list[float]] = {}
                timed_out = False
                for offset in range(0, len(missing), 32):
                    if time.monotonic() > deadline:
                        timed_out = True
                        break
                    batch = missing[offset:offset + 32]
                    batch_vectors = self.client.embed([str(document["text"])[:MAX_TEXT_CHARS] for document in batch], model)
                    additions.update((str(document["id"]), vector) for document, vector in zip(batch, batch_vectors))
                vectors.update(additions)
                if cache_allowed and additions and not cache_failed:
                    try:
                        self.cache.write(namespace, missing, model, additions)
                    except (OSError, ValueError, sqlite3.Error):
                        status["cacheStatus"] = "unavailable_preserved"
                dense = [(_cosine(query_vectors[0], vector), identifier) for identifier, vector in vectors.items()]
                dense = [row for row in dense if row[0] >= 0.20]
                dense.sort(key=lambda row: (-row[0], row[1]))
                semantic = [identifier for _, identifier in dense]
                rankings.append(semantic)
                for identifier in semantic:
                    sources[identifier].append("dense_local")
                status["indexedDocuments"] = len(vectors)
                status["mode"] = "hybrid_semantic" if len(vectors) == len(corpus) else "hybrid_semantic_partial"
                status["reason"] = "ready" if len(vectors) == len(corpus) else "semantic_time_budget_exceeded" if timed_out else "new_document_budget_exceeded"
            except (RetrievalError, OSError, ValueError):
                # No stale vectors from a different model/dimension are used.
                status.update({"semanticReady": False, "mode": "lexical_hash", "reason": "local_embedding_failed"})
        scores = reciprocal_rank_fusion(rankings)
        by_id = {str(document["id"]): document for document in corpus}
        supplemental = sorted((identifier for identifier in scores if identifier not in selected), key=lambda identifier: (-scores[identifier], identifier))
        if status.get("semanticReady") and status.get("rerankerReady") and supplemental and self.client:
            candidates = supplemental[:20]
            try:
                rerank_scores = self.client.rerank(query, [str(by_id[identifier]["text"])[:MAX_TEXT_CHARS] for identifier in candidates], model)
                candidates.sort(key=lambda identifier: (-rerank_scores[supplemental[:20].index(identifier)], -scores[identifier], identifier))
                supplemental = candidates + supplemental[20:]
                status["rerankerUsed"] = True
                for identifier in candidates:
                    sources[identifier].append("reranker_local")
            except (RetrievalError, OSError, ValueError):
                status["rerankerUsed"] = False
                status["rerankerReason"] = "local_reranker_failed"
        ranked = [*exact, *(by_id[identifier] for identifier in supplemental)][:top_k]
        result = [{**document, "score": 1.0 if str(document["id"]) in selected else round(scores.get(str(document["id"]), 0.0), 6), "exact": str(document["id"]) in selected,
                   "retrievalSources": ["exact_id"] if str(document["id"]) in selected else sources[str(document["id"])]} for document in ranked]
        return {"documents": result, "mode": status["mode"], "status": status}


_DEFAULT: HybridRetriever | None = None
_DEFAULT_CONFIGURATION: tuple[str, str] | None = None
_DEFAULT_LOCK = threading.Lock()


def get_retriever() -> HybridRetriever:
    """Configuration remains optional; bad URLs cannot trigger a network call."""
    global _DEFAULT, _DEFAULT_CONFIGURATION
    configuration = (os.environ.get("CET_EMBEDDING_URL", "").strip(), os.environ.get("CET_EMBEDDING_TOKEN", ""))
    with _DEFAULT_LOCK:
        if _DEFAULT is None or _DEFAULT_CONFIGURATION != configuration:
            client = None
            invalid = False
            if configuration[0]:
                try:
                    client = LocalEmbeddingClient(*configuration)
                except RetrievalError:
                    invalid = True
            _DEFAULT = HybridRetriever(client, configuration_error=invalid)
            _DEFAULT_CONFIGURATION = configuration
        return _DEFAULT
