"""Managed local launcher tests; no processes, sockets, model calls or secrets."""

from __future__ import annotations

import io
import json
import os
import signal
import subprocess
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.request import ProxyHandler
from urllib.error import URLError

import server.app as server_app
from tools import start_platform as launcher


class HealthResponse(io.BytesIO):
    def __init__(self, value, *, url="http://127.0.0.1:8770/healthz", status=200):
        super().__init__(value if isinstance(value, bytes) else json.dumps(value).encode())
        self.url, self.status = url, status

    def geturl(self):
        return self.url


class OwnedChild:
    def __init__(self, *, running=True, wait_result=0, wait_timeout=False):
        self.running = running
        self.wait_result = wait_result
        self.wait_timeout = wait_timeout
        self.terminations = 0
        self.kills = 0
        self.waits = []

    def poll(self):
        return None if self.running else self.wait_result

    def terminate(self):
        self.terminations += 1
        if not self.wait_timeout:
            self.running = False

    def kill(self):
        self.kills += 1
        self.running = False
        self.wait_timeout = False

    def wait(self, timeout=None):
        self.waits.append(timeout)
        if self.wait_timeout and timeout is not None:
            raise subprocess.TimeoutExpired("synthetic-owned-child", timeout)
        self.running = False
        return self.wait_result


class LauncherHealthTests(unittest.TestCase):
    def test_health_accepts_only_ready_agent_service(self):
        for document, expected in (({"service": "cet-agent-runtime", "ready": True}, True),
                                   ({"service": "another-service", "ready": True}, False),
                                   ({"service": "cet-agent-runtime", "ready": False}, False),
                                   ({"service": "cet-agent-runtime", "ready": "true"}, False),
                                   ([], False)):
            with self.subTest(document=document), patch.object(launcher, "build_opener") as builder:
                builder.return_value.open.return_value = HealthResponse(document)
                self.assertEqual(launcher.health("http://127.0.0.1:8770", ""), expected)

    def test_health_disables_environment_proxies_and_keeps_token_in_header(self):
        with patch.object(launcher, "build_opener") as builder:
            builder.return_value.open.return_value = HealthResponse({"service": "cet-agent-runtime", "ready": True})
            self.assertTrue(launcher.health("http://127.0.0.1:8770", "synthetic-local-token"))
        handlers = builder.call_args.args
        proxies = [handler for handler in handlers if isinstance(handler, ProxyHandler)]
        self.assertEqual(len(proxies), 1)
        self.assertEqual(proxies[0].proxies, {})
        redirect_handlers = [handler for handler in handlers if isinstance(handler, launcher.NoRedirects)]
        self.assertEqual(len(redirect_handlers), 1)
        with self.assertRaises(URLError):
            redirect_handlers[0].redirect_request(None, None, 302, "", {}, "https://external.example")
        request = builder.return_value.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8770/healthz")
        self.assertEqual(request.get_header("Authorization"), "Bearer synthetic-local-token")

    def test_health_rejects_redirected_destination_and_oversized_body(self):
        value = {"service": "cet-agent-runtime", "ready": True}
        for response in (HealthResponse(value, url="https://external.example/healthz"),
                         HealthResponse(json.dumps(value).encode() + b" " * 40_000),
                         HealthResponse(value, status=500)):
            with self.subTest(response=response), patch.object(launcher, "build_opener") as builder:
                builder.return_value.open.return_value = response
                self.assertFalse(launcher.health("http://127.0.0.1:8770", "synthetic-local-token"))

    def test_health_invalid_json_and_network_failures_return_not_ready(self):
        with patch.object(launcher, "build_opener") as builder:
            builder.return_value.open.return_value = HealthResponse(b"invalid JSON")
            self.assertFalse(launcher.health("http://127.0.0.1:8770", ""))
            builder.return_value.open.side_effect = OSError("synthetic failure, never printed")
            self.assertFalse(launcher.health("http://127.0.0.1:8770", ""))

    def test_dependency_probe_is_bounded_and_quiet(self):
        with patch.object(Path, "is_file", return_value=True), patch.object(launcher.subprocess, "run") as run:
            run.return_value.returncode = 0
            self.assertTrue(launcher.dependency_ready(Path("/synthetic/python")))
        self.assertEqual(run.call_args.kwargs["timeout"], 10)
        self.assertEqual(run.call_args.kwargs["stdout"], subprocess.DEVNULL)
        self.assertEqual(run.call_args.kwargs["stderr"], subprocess.DEVNULL)
        self.assertIn("langgraph.checkpoint.sqlite", run.call_args.args[0][2])

    def test_missing_dependency_interpreter_and_failed_probe_are_safe(self):
        with patch.object(Path, "is_file", return_value=False), patch.object(launcher.subprocess, "run") as run:
            self.assertFalse(launcher.dependency_ready(Path("/synthetic/missing")))
            run.assert_not_called()
        for outcome in (OSError("missing executable"), subprocess.TimeoutExpired("probe", 10)):
            with patch.object(Path, "is_file", return_value=True), patch.object(launcher.subprocess, "run", side_effect=outcome):
                self.assertFalse(launcher.dependency_ready(Path("/synthetic/python")))


class ManagedLauncherTests(unittest.TestCase):
    def launch(self, *, environment=None, health=True, port_busy=False, dependencies=True, children=None, argv=None, clock=None):
        output = io.StringIO()
        signals = {}
        children = children or [OwnedChild()]
        with ExitStack() as stack:
            stack.enter_context(patch.dict(os.environ, environment or {}, clear=True))
            stack.enter_context(patch.object(server_app, "load_project_env"))
            stack.enter_context(patch.object(server_app, "require_python_311"))
            stack.enter_context(patch.object(launcher.sys, "argv", ["start_platform.py", *(argv or [])]))
            health_mock = stack.enter_context(patch.object(launcher, "health", side_effect=health if isinstance(health, list) or callable(health) else None, return_value=health))
            dependency_mock = stack.enter_context(patch.object(launcher, "dependency_ready", return_value=dependencies))
            stack.enter_context(patch.object(launcher, "port_in_use", return_value=port_busy))
            stack.enter_context(patch.object(launcher.signal, "signal", side_effect=lambda number, callback: signals.update({number: callback})))
            popen = stack.enter_context(patch.object(launcher.subprocess, "Popen", side_effect=children))
            stack.enter_context(patch.object(launcher.time, "sleep"))
            if clock:
                stack.enter_context(patch.object(launcher.time, "monotonic", side_effect=clock))
            stack.enter_context(redirect_stdout(output))
            result = launcher.main()
        return result, popen.call_args_list, output.getvalue(), health_mock, dependency_mock, signals

    def test_existing_ready_runtime_is_reused_but_never_owned_or_stopped(self):
        server = OwnedChild()
        result, calls, output, _, dependency, _ = self.launch(children=[server])
        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].kwargs["env"]["CET_AGENT_URL"], "http://127.0.0.1:8770")
        self.assertIn("existing ready", output)
        dependency.assert_not_called()
        self.assertEqual(server.kills, 0)

    def test_different_service_on_agent_port_is_not_taken_over(self):
        result, calls, output, _, dependency, _ = self.launch(health=False, port_busy=True)
        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("CET_AGENT_URL", calls[0].kwargs["env"])
        self.assertIn("occupied", output)
        dependency.assert_not_called()

    def test_managed_children_receive_shared_ephemeral_token_and_are_cleaned(self):
        agent, server = OwnedChild(), OwnedChild()
        result, calls, output, _, _, _ = self.launch(health=[False, True], children=[agent, server])
        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 2)
        self.assertIn("services.agent.app", calls[0].args[0])
        agent_env, server_env = calls[0].kwargs["env"], calls[1].kwargs["env"]
        self.assertTrue(agent_env["CET_AGENT_TOKEN"])
        self.assertEqual(agent_env["CET_AGENT_TOKEN"], server_env["CET_AGENT_TOKEN"])
        self.assertEqual(server_env["CET_AGENT_URL"], "http://127.0.0.1:8770")
        self.assertEqual(agent.terminations, 1)
        self.assertNotIn(agent_env["CET_AGENT_TOKEN"], output)
        self.assertIn("runtime ready", output)

    def test_optional_dependency_missing_keeps_main_server_usable_and_no_secret_logging(self):
        environment = {"DEEPSEEK_API_KEY": "synthetic-test-secret", "CET_AGENT_TOKEN": "synthetic-agent-token", "PYTHONPATH": "/synthetic/untrusted"}
        result, calls, output, _, _, _ = self.launch(environment=environment, health=False, dependencies=False)
        self.assertEqual(result, 0)
        self.assertEqual(len(calls), 1)
        self.assertNotIn("PYTHONPATH", calls[0].kwargs["env"])
        self.assertEqual(calls[0].kwargs["env"]["DEEPSEEK_API_KEY"], "synthetic-test-secret")
        self.assertNotIn("synthetic-test-secret", output)
        self.assertNotIn("synthetic-agent-token", output)
        self.assertIn("original server remains usable", output)

    def test_explicit_agent_configuration_and_managed_opt_out_preserved(self):
        for environment in ({"CET_AGENT_URL": "http://127.0.0.1:8870"}, {"CET_MANAGED_AGENT": "0"}):
            with self.subTest(environment=environment):
                _, calls, _, health, dependency, _ = self.launch(environment=environment)
                self.assertEqual(len(calls), 1)
                health.assert_not_called()
                dependency.assert_not_called()
                for key, value in environment.items():
                    self.assertEqual(calls[0].kwargs["env"][key], value)

    def test_agent_startup_timeout_stops_only_created_child_and_falls_back(self):
        agent, server = OwnedChild(), OwnedChild()
        result, calls, output, _, _, _ = self.launch(health=False, children=[agent, server], clock=[0, 13])
        self.assertEqual(result, 0)
        self.assertEqual(agent.terminations, 1)
        self.assertNotIn("CET_AGENT_URL", calls[1].kwargs["env"])
        self.assertIn("not ready", output)

    def test_cleanup_kills_only_owned_child_if_terminate_does_not_finish(self):
        agent, server = OwnedChild(wait_timeout=True), OwnedChild()
        result, _, _, _, _, _ = self.launch(health=[False, True], children=[agent, server])
        self.assertEqual(result, 0)
        self.assertEqual(agent.kills, 1)
        self.assertIn(4, agent.waits)
        self.assertIn(2, agent.waits)
        self.assertEqual(server.kills, 0)

    def test_whitespace_agent_configuration_does_not_hide_failed_startup(self):
        agent, server = OwnedChild(), OwnedChild()
        result, calls, output, _, _, _ = self.launch(environment={"CET_AGENT_URL": " "}, health=False,
                                                    children=[agent, server], clock=[0, 13])
        self.assertEqual(result, 0)
        self.assertEqual(agent.terminations, 1)
        self.assertFalse(calls[1].kwargs["env"]["CET_AGENT_URL"].strip())
        self.assertIn("not ready", output)

    def test_managed_startup_preserves_explicit_token_without_printing_it(self):
        agent, server = OwnedChild(), OwnedChild()
        _, calls, output, _, _, _ = self.launch(environment={"CET_AGENT_TOKEN": "synthetic-managed-token"},
                                              health=[False, True], children=[agent, server])
        self.assertEqual(calls[0].kwargs["env"]["CET_AGENT_TOKEN"], "synthetic-managed-token")
        self.assertEqual(calls[1].kwargs["env"]["CET_AGENT_TOKEN"], "synthetic-managed-token")
        self.assertNotIn("synthetic-managed-token", output)

    def test_help_check_exec_original_main_without_spawn(self):
        class ExecRequested(Exception):
            pass
        with patch.object(server_app, "load_project_env"), patch.object(server_app, "require_python_311"), \
             patch.object(launcher.sys, "argv", ["start_platform.py", "--check"]), \
             patch.object(launcher.os, "execv", side_effect=ExecRequested) as execute, \
             patch.object(launcher.subprocess, "Popen") as spawn:
            with self.assertRaises(ExecRequested):
                launcher.main()
        self.assertEqual(execute.call_args.args[1][-1], "--check")
        spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
