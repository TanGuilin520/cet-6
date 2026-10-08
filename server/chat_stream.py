"""Same-origin SSE transport for one assistant call, not a second model path.

Only safe progress metadata and the normal validated response are exposed.
Disconnect/cancel is cooperative: it stops subsequent work, but cannot undo
a provider request already in flight. No partial response is a saved answer.
"""
from __future__ import annotations

import json
import queue
import re
import threading
import time
from http import HTTPStatus

_STREAM_SLOTS = threading.BoundedSemaphore(4)


def serve_assistant_stream(handler, call, *, timeout_seconds: float = 75.0) -> None:
    if not _STREAM_SLOTS.acquire(blocking=False):
        handler._json_error(HTTPStatus.TOO_MANY_REQUESTS, "AI 正忙，请等待当前请求结束后重试")
        return
    events: queue.Queue = queue.Queue(maxsize=128)
    cancelled = threading.Event()

    def publish(event):
        if cancelled.is_set() or not isinstance(event, dict):
            return
        kind = event.get("type")
        if kind == "progress":
            safe = {"type": kind}
            for name in ("node", "tool", "status"):
                value = event.get(name)
                if isinstance(value, str) and re.fullmatch(r"[a-zA-Z0-9_.:-]{1,80}", value):
                    safe[name] = value
            if type(event.get("round")) is int and 0 <= event["round"] <= 12:
                safe["round"] = event["round"]
            if len(safe) == 1:
                return
        elif kind == "reply_delta":
            value = event.get("text")
            if not isinstance(value, str) or not value or len(value) > 16_000:
                return
            safe = {"type": kind, "text": value}
        else:
            return
        try:
            events.put_nowait((kind, safe))
        except queue.Full:
            # Progress is lossy under back-pressure; never queue unbounded data.
            return

    def finish(kind, value):
        while not cancelled.is_set():
            try:
                events.put((kind, value), timeout=0.1)
                return
            except queue.Full:
                continue

    def work():
        try:
            result = call(publish, cancelled)
            finish("result", result)
        except Exception as error:
            # Only PlatformError's known public message can leave this process.
            from .platform import PlatformError
            if isinstance(error, PlatformError):
                message, code = error.message, int(error.status)
            else:
                message, code = "AI 请求未能完成，请稍后重试", 500
            finish("error", {"message": message, "code": code})
        finally:
            _STREAM_SLOTS.release()

    try:
        connection = getattr(handler, "connection", None)
        if connection is not None:
            connection.settimeout(5.0)
        handler.send_response(HTTPStatus.OK)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("X-Accel-Buffering", "no")
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.send_header("Connection", "close")
        handler.end_headers()
    except OSError:
        _STREAM_SLOTS.release()
        return
    handler.close_connection = True

    def send(kind, value):
        data = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        if len(data.encode("utf-8")) > 512 * 1024:
            raise ValueError("stream event exceeds response budget")
        handler.wfile.write(f"event: {kind}\ndata: {data}\n\n".encode("utf-8"))
        handler.wfile.flush()

    worker = threading.Thread(target=work, name="cet-assistant-stream", daemon=True)
    worker.start()
    deadline = time.monotonic() + timeout_seconds
    try:
        while not cancelled.is_set():
            if time.monotonic() >= deadline:
                send("error", {"message": "AI 请求超时，请稍后重试", "code": 504})
                break
            try:
                kind, value = events.get(timeout=0.5)
            except queue.Empty:
                # Flushing a heartbeat discovers browser disconnects even
                # while the model is doing a bounded blocking read upstream.
                handler.wfile.write(b": heartbeat\n\n")
                handler.wfile.flush()
                continue
            send(kind, value)
            if kind in {"result", "error"}:
                break
    except (OSError, ValueError):
        pass
    finally:
        cancelled.set()
