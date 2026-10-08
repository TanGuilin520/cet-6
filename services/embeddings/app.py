"""Loopback-only semantic embeddings/reranking from explicitly local artifacts.

No model-name URL, model download, third-party API, or remote custom code is
accepted. Importing this module does not import torch/sentence-transformers.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import ipaddress
import json
import math
import os
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_TEXT_CHARS = 4_000
MAX_TEXTS = 128
MAX_DIMENSION = 4_096
MODEL_MODULES = frozenset({"sentence_transformers.models.Transformer", "sentence_transformers.models.Pooling", "sentence_transformers.models.Dense", "sentence_transformers.models.Normalize", "sentence_transformers.models.WeightedLayerPooling"})


class RequestError(ValueError):
    pass


def local_model_directory(value: str) -> Path:
    if not value or "://" in value or not Path(value).is_absolute():
        raise RequestError("model must be an absolute local directory")
    path = Path(value).resolve()
    if not path.is_dir() or not (path / "config.json").is_file():
        raise RequestError("local model artifacts are missing")
    files = list(path.rglob("*"))
    if len(files) > 1_024 or not any(item.suffix == ".safetensors" and item.is_file() for item in files):
        raise RequestError("local model needs safetensors weights")
    for item in files:
        if item.is_symlink() or not item.resolve().is_relative_to(path):
            raise RequestError("model artifacts must remain inside the local directory")
    modules = path / "modules.json"
    if modules.is_file():
        if modules.stat().st_size > 32_768:
            raise RequestError("model module configuration outside limits")
        try:
            values = json.loads(modules.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise RequestError("model module configuration invalid") from None
        if not isinstance(values, list) or len(values) > 16:
            raise RequestError("model module configuration invalid")
        for module in values:
            if not isinstance(module, dict) or module.get("type") not in MODEL_MODULES:
                raise RequestError("custom model modules are not permitted")
            relative = module.get("path", "")
            if not isinstance(relative, str) or Path(relative).is_absolute() or ".." in Path(relative).parts:
                raise RequestError("model module path invalid")
    return path


def model_fingerprint(path: Path) -> str:
    """Hash artifact contents once, not their mutable display name."""
    digest = hashlib.sha256()
    total = 0
    for item in sorted((item for item in path.rglob("*") if item.is_file()), key=lambda item: str(item.relative_to(path))):
        if item.suffix not in {".json", ".safetensors", ".txt", ".model"}:
            continue
        total += item.stat().st_size
        if total > 10 * 1024 * 1024 * 1024:
            raise RequestError("local model artifacts outside size limit")
        digest.update(str(item.relative_to(path)).encode("utf-8"))
        digest.update(b"\x00")
        with item.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    return digest.hexdigest()


def _texts(value: object, maximum: int = MAX_TEXTS) -> list[str]:
    if not isinstance(value, list) or not 1 <= len(value) <= maximum:
        raise RequestError("text batch outside limits")
    for text in value:
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS or "\x00" in text:
            raise RequestError("text outside limits")
    return value


def _vectors(value: object, dimension: int, count: int) -> list[list[float]]:
    if hasattr(value, "tolist"):
        value = value.tolist()
    if not isinstance(value, list) or len(value) != count:
        raise RequestError("encoder vector count invalid")
    result = []
    for vector in value:
        if not isinstance(vector, list) or len(vector) != dimension:
            raise RequestError("encoder dimension invalid")
        if any(isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) for item in vector):
            raise RequestError("encoder vector invalid")
        magnitude = math.sqrt(sum(item * item for item in vector))
        if magnitude <= 0 or not math.isfinite(magnitude):
            raise RequestError("encoder vector empty")
        result.append([float(item) / magnitude for item in vector])
    return result


class LocalModels:
    def __init__(self, model_dir: str, reranker_dir: str = "", device: str = "cpu") -> None:
        if device not in {"cpu", "cuda", "mps"}:
            raise RequestError("unsupported model device")
        self.model_dir, self.reranker_dir, self.device = model_dir, reranker_dir, device
        self.encoder = None
        self.reranker = None
        self.dimension = 0
        self.fingerprint = ""
        self.model = ""
        self.reason = "loading_local_artifacts" if model_dir else "local_model_not_configured"
        self.reranker_reason = "not_configured"
        self._load_lock = threading.Lock()
        self._inference_lock = threading.Lock()

    def load(self) -> None:
        if not self.model_dir:
            return
        with self._load_lock:
            if self.encoder is not None:
                return
            try:
                path = local_model_directory(self.model_dir)
                self.fingerprint = model_fingerprint(path)
                # Set BEFORE import: offline mode covers tokenizer/model-card
                # helpers as well as the explicit local_files_only constructor.
                os.environ["HF_HUB_OFFLINE"] = "1"
                os.environ["TRANSFORMERS_OFFLINE"] = "1"
                os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
                from sentence_transformers import SentenceTransformer
                encoder = SentenceTransformer(str(path), device=self.device, local_files_only=True, trust_remote_code=False, model_kwargs={"use_safetensors": True})
                dimension = encoder.get_sentence_embedding_dimension()
                if isinstance(dimension, bool) or not isinstance(dimension, int) or not 1 <= dimension <= MAX_DIMENSION:
                    raise RequestError("local encoder dimension invalid")
                # Bound model sequence memory independently of the HTTP limit.
                encoder.max_seq_length = min(int(encoder.max_seq_length), 512)
                self.model = path.name[:160]
                self.dimension = dimension
                self.encoder = encoder
                self.reason = "ready"
            except (ImportError, OSError, ValueError, RuntimeError, TypeError):
                self.reason = "local_model_unavailable"
                self.encoder = None
                return
            if self.reranker_dir:
                try:
                    reranker_path = local_model_directory(self.reranker_dir)
                    from sentence_transformers import CrossEncoder
                    self.reranker = CrossEncoder(str(reranker_path), device=self.device, local_files_only=True, trust_remote_code=False, max_length=512, model_kwargs={"use_safetensors": True})
                    self.reranker_reason = "ready"
                except (ImportError, OSError, ValueError, RuntimeError, TypeError):
                    self.reranker_reason = "local_reranker_unavailable"

    def health(self) -> dict[str, object]:
        return {"schemaVersion": 1, "ready": self.encoder is not None, "reason": self.reason,
                "model": self.model, "modelFingerprint": self.fingerprint, "dimension": self.dimension,
                "rerankerReady": self.reranker is not None, "rerankerReason": self.reranker_reason,
                "offlineOnly": True, "automaticDownloads": False}

    def execute(self, path: str, payload: dict[str, object]) -> dict[str, object]:
        expected = {"texts", "modelFingerprint"} if path == "/v1/embed" else {"query", "texts", "modelFingerprint"}
        if set(payload) != expected:
            raise RequestError("request fields invalid")
        if self.encoder is None:
            raise RequestError("local model is not ready")
        if payload.get("modelFingerprint") != self.fingerprint:
            raise RequestError("local model fingerprint changed")
        texts = _texts(payload.get("texts"), MAX_TEXTS if path == "/v1/embed" else 20)
        if path == "/v1/embed":
            if not self._inference_lock.acquire(timeout=0.5):
                raise RequestError("local encoder is busy")
            try:
                vectors = self.encoder.encode(texts, batch_size=8, normalize_embeddings=True, show_progress_bar=False, convert_to_numpy=True)
            finally:
                self._inference_lock.release()
            return {"schemaVersion": 1, "modelFingerprint": self.fingerprint, "dimension": self.dimension, "vectors": _vectors(vectors, self.dimension, len(texts))}
        if self.reranker is None:
            raise RequestError("local reranker is not ready")
        query = _texts([payload.get("query")], 1)[0]
        if not self._inference_lock.acquire(timeout=0.5):
            raise RequestError("local reranker is busy")
        try:
            values = self.reranker.predict([(query, text) for text in texts], batch_size=8, show_progress_bar=False)
        finally:
            self._inference_lock.release()
        if hasattr(values, "tolist"):
            values = values.tolist()
        if not isinstance(values, list) or len(values) != len(texts) or any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
            raise RequestError("local reranker scores invalid")
        return {"schemaVersion": 1, "modelFingerprint": self.fingerprint, "scores": [float(value) for value in values]}


class EmbeddingHandler(BaseHTTPRequestHandler):
    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, format, *args) -> None:
        # Never log submitted text, local model paths or credentials.
        return

    def _json(self, status: HTTPStatus, body: dict[str, object]) -> None:
        encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(encoded)

    def _authorized(self) -> bool:
        # Browser-origin requests are not part of this server-to-server protocol.
        if self.headers.get("Origin") or not ipaddress.ip_address(self.client_address[0]).is_loopback:
            self._json(HTTPStatus.FORBIDDEN, {"schemaVersion": 1, "error": "local server-to-server requests only"})
            return False
        token = self.server.token
        if token and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
            self._json(HTTPStatus.UNAUTHORIZED, {"schemaVersion": 1, "error": "authorization required"})
            return False
        return True

    def do_GET(self) -> None:
        if not self._authorized():
            return
        if self.path != "/healthz":
            self._json(HTTPStatus.NOT_FOUND, {"schemaVersion": 1, "error": "route not found"})
            return
        self._json(HTTPStatus.OK, self.server.models.health())

    def do_POST(self) -> None:
        if not self._authorized():
            return
        if self.path not in {"/v1/embed", "/v1/rerank"}:
            self._json(HTTPStatus.NOT_FOUND, {"schemaVersion": 1, "error": "route not found"})
            return
        try:
            if self.headers.get("Transfer-Encoding") or self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
                raise RequestError("bounded JSON content required")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_REQUEST_BYTES:
                raise RequestError("request outside size limit")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise RequestError("incomplete request")
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, dict):
                raise RequestError("JSON object required")
            result = self.server.models.execute(self.path, payload)
            self._json(HTTPStatus.OK, result)
        except (RequestError, ValueError, UnicodeError):
            self._json(HTTPStatus.BAD_REQUEST, {"schemaVersion": 1, "error": "local embedding request invalid or model unavailable"})
        except (RuntimeError, OSError, TypeError):
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"schemaVersion": 1, "error": "local inference unavailable"})


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline loopback semantic embeddings")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8780)
    parser.add_argument("--model-dir", default=os.environ.get("CET_EMBEDDING_MODEL_DIR", ""))
    parser.add_argument("--reranker-dir", default=os.environ.get("CET_RERANKER_MODEL_DIR", ""))
    parser.add_argument("--device", choices=("cpu", "cuda", "mps"), default="cpu")
    args = parser.parse_args(argv)
    if args.host != "127.0.0.1" or not 1024 <= args.port <= 65535:
        parser.error("bind only 127.0.0.1 on a non-privileged port")
    models = LocalModels(args.model_dir, args.reranker_dir, args.device)
    threading.Thread(target=models.load, daemon=True, name="local-model-loader").start()
    with ThreadingHTTPServer((args.host, args.port), EmbeddingHandler) as server:
        server.models = models
        server.token = os.environ.get("CET_EMBEDDING_TOKEN", "")
        print(f"Local embeddings service: http://{args.host}:{args.port} (offline artifacts only)", flush=True)
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
