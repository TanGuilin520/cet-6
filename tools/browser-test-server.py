#!/usr/bin/env python3
"""Serve the real reader locally with model credentials and outbound sockets disabled.

Playwright intercepts paper and assistant requests using synthetic fixtures. This
second, process-wide safeguard prevents real API calls even if a route is missed
or the developer's .env contains a funded key. Never use this server in production.
"""

from __future__ import annotations

import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# Set before importing server.app: dotenv uses setdefault and cannot override us.
for name in ("DEEPSEEK_API_KEY", "CET_AGENT_URL", "CET_AGENT_TOKEN", "CET_PADDLEOCR_URL"):
    os.environ[name] = ""


def deny_outbound_connections(event: str, _args: tuple) -> None:
    if event == "socket.connect":
        raise RuntimeError("Browser test server forbids all outbound connections")


sys.addaudithook(deny_outbound_connections)

from server.app import ReadingLabHandler, require_python_311  # noqa: E402
import server.platform as platform_module  # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402


def main() -> None:
    require_python_311()
    port = int(os.environ.get("CET_BROWSER_TEST_PORT", "4187"))
    with TemporaryDirectory(prefix="cet-browser-test-") as temporary:
        platform_module.EXAMS_DIR = Path(temporary)
        with ThreadingHTTPServer(("127.0.0.1", port), ReadingLabHandler) as server:
            print(f"Offline browser test server: http://127.0.0.1:{port}", flush=True)
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass


if __name__ == "__main__":
    main()
