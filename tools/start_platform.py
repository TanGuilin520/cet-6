#!/usr/bin/env python3
"""Run the existing server and its optional local Agent as one managed suite.

Never changes .env, installs dependencies, downloads models, or calls an LLM.
Credentials stay in child environments; only readiness is printed. Ctrl+C
stops only child processes started by this launcher.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import Request, ProxyHandler, HTTPRedirectHandler, build_opener

PROJECT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT))


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise URLError("Local readiness redirects are not allowed")


def health(origin, token):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        request = Request(origin + "/healthz", headers=headers)
        with build_opener(ProxyHandler({}), NoRedirects()).open(request, timeout=0.6) as response:
            if response.status != 200 or response.geturl() != origin + "/healthz":
                return False
            raw = response.read(32_769)
        if len(raw) > 32_768:
            return False
        document = json.loads(raw)
        return isinstance(document, dict) and document.get("service") == "cet-agent-runtime" and document.get("ready") is True
    except (OSError, ValueError, URLError):
        return False


def dependency_ready(python):
    if not python.is_file():
        return False
    code = "import langgraph.graph; import langgraph.checkpoint.sqlite"
    try:
        result = subprocess.run([str(python), "-c", code], cwd=PROJECT, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=10)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def port_in_use(host, port):
    try:
        with socket.create_connection((host, port), timeout=0.3):
            return True
    except OSError:
        return False


def main():
    from server.app import load_project_env, require_python_311
    require_python_311()
    load_project_env(PROJECT / ".env")
    arguments = sys.argv[1:]
    if "--check" in arguments or "--help" in arguments or "-h" in arguments:
        os.execv(sys.executable, [sys.executable, "-m", "server", *arguments])
    # Preserve explicit user configuration; this launcher's managed defaults
    # apply only when no remote/externally managed Agent was requested.
    environment = dict(os.environ)
    environment.pop("PYTHONPATH", None)
    environment["PYTHONUNBUFFERED"] = "1"
    # Local service credentials must not travel through a configured proxy.
    bypass = environment.get("no_proxy", environment.get("NO_PROXY", ""))
    bypass = ",".join(dict.fromkeys([*filter(None, (item.strip() for item in bypass.split(","))), "127.0.0.1", "localhost", "::1"]))
    environment["NO_PROXY"] = bypass
    environment["no_proxy"] = bypass
    children = []
    interrupted = False

    def stop(_number=None, _frame=None):
        nonlocal interrupted
        interrupted = True
        for child in reversed(children):
            if child.poll() is None:
                try:
                    child.terminate()
                except OSError:
                    pass

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        if not environment.get("CET_AGENT_URL", "").strip() and environment.get("CET_MANAGED_AGENT", "1") != "0":
            agent_python = PROJECT / ".venv-agent" / "bin" / "python"
            origin = "http://127.0.0.1:8770"
            token = environment.get("CET_AGENT_TOKEN", "").strip()
            if health(origin, token):
                environment["CET_AGENT_URL"] = origin
                print("Agent: using the existing ready local runtime", flush=True)
            elif port_in_use("127.0.0.1", 8770):
                print("Agent: port 8770 is occupied; not taking over another process", flush=True)
            elif dependency_ready(agent_python):
                token = token or secrets.token_urlsafe(32)
                environment["CET_AGENT_TOKEN"] = token
                agent_environment = {**environment, "CET_AGENT_CHECKPOINT_PATH": str(PROJECT / "data" / "agent" / "checkpoints.sqlite3")}
                child = subprocess.Popen([str(agent_python), "-m", "services.agent.app", "--host", "127.0.0.1", "--port", "8770"],
                                         cwd=PROJECT, env=agent_environment)
                children.append(child)
                deadline = time.monotonic() + 12
                while child.poll() is None and time.monotonic() < deadline and not interrupted:
                    if health(origin, token):
                        environment["CET_AGENT_URL"] = origin
                        print("Agent: LangGraph and persistent memory runtime ready", flush=True)
                        break
                    time.sleep(0.15)
                if not environment.get("CET_AGENT_URL", "").strip():
                    try:
                        child.terminate()
                    except OSError:
                        pass
                    print("Agent: not ready; starting the original server without Agent", flush=True)
            else:
                print("Agent: optional dependencies unavailable; original server remains usable", flush=True)
                print("Install explicitly: .venv-agent/bin/python -m pip install -r services/agent/requirements.txt", flush=True)
        if interrupted:
            return 130
        server = subprocess.Popen([sys.executable, "-m", "server", *arguments], cwd=PROJECT, env=environment)
        children.append(server)
        return server.wait()
    finally:
        stop()
        for child in reversed(children):
            try:
                child.wait(timeout=4)
            except subprocess.TimeoutExpired:
                try:
                    child.kill()
                except OSError:
                    pass
                child.wait(timeout=2)


if __name__ == "__main__":
    raise SystemExit(main())
