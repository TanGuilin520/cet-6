"""Project-wide Python 3.11 baseline guards."""

from __future__ import annotations

import unittest
from unittest.mock import patch

import server.app as server_app


class RuntimeVersionGateTests(unittest.TestCase):
    def test_startup_is_rejected_below_3_11_with_actionable_message(self):
        for version in ((3, 8, 10), (3, 9, 7), (3, 10, 12)):
            with patch.object(server_app.sys, "version_info", version):
                with self.assertRaises(SystemExit) as caught:
                    server_app.require_python_311()
            message = str(caught.exception)
            self.assertIn("Python 3.11", message)
            self.assertIn(f"{version[0]}.{version[1]}.{version[2]}", message)
            self.assertIn(".venv-main", message)

    def test_python_3_11_and_3_12_are_allowed(self):
        for version in ((3, 11, 16), (3, 11, 9), (3, 12, 1)):
            with patch.object(server_app.sys, "version_info", version):
                server_app.require_python_311()  # must not raise

    def test_main_refuses_to_start_on_old_interpreter(self):
        original_argv = server_app.sys.argv
        try:
            server_app.sys.argv = ["server"]
            with patch.object(server_app.sys, "version_info", (3, 8, 10)):
                with self.assertRaises(SystemExit):
                    server_app.main()
        finally:
            server_app.sys.argv = original_argv


if __name__ == "__main__":
    unittest.main()
