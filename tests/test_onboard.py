"""First-run host checks: hello, doctor and the Python version guard."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

BRIDGE = Path(__file__).parents[1] / "bridge/pocket_bridge.py"
spec = importlib.util.spec_from_file_location("bridge", BRIDGE)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class OnboardTests(unittest.TestCase):
    def test_hello_reports_python(self):
        hello = bridge.handle({"v": 1, "op": "hello"})
        self.assertEqual(hello["protocol"], 1)
        self.assertEqual(hello["python"], "%d.%d" % sys.version_info[:2])

    def test_doctor_without_herdr(self):
        with tempfile.TemporaryDirectory() as home, patch.object(bridge.shutil, "which", return_value=None), \
                patch.object(bridge.Path, "home", return_value=Path(home)), patch.object(bridge, "call") as call:
            result = bridge.handle({"v": 1, "op": "doctor"})
        self.assertFalse(result["herdr"])
        self.assertIsNone(result["running"])
        call.assert_not_called()

    def test_doctor_finds_local_bin_and_counts_running(self):
        with tempfile.TemporaryDirectory() as home:
            binary = Path(home) / ".local/bin/herdr"
            binary.parent.mkdir(parents=True)
            binary.write_text("#!/bin/sh\n")
            binary.chmod(0o755)
            sessions = {"sessions": [{"name": "a", "running": True}, {"name": "b", "running": False}]}
            with patch.object(bridge.shutil, "which", return_value=None), patch.object(bridge.Path, "home", return_value=Path(home)), \
                    patch.object(bridge, "call", return_value=sessions) as call:
                result = bridge.handle({"v": 1, "op": "doctor"})
        self.assertTrue(result["herdr"])
        self.assertEqual(result["running"], 1)
        call.assert_called_once_with(["session", "list", "--json"])

    def test_doctor_reports_herdr_errors_without_raising(self):
        with patch.object(bridge.shutil, "which", return_value="/usr/bin/herdr"), \
                patch.object(bridge, "call", side_effect=bridge.BridgeError("server not running")):
            result = bridge.handle({"v": 1, "op": "doctor"})
        self.assertTrue(result["herdr"])
        self.assertIsNone(result["running"])
        self.assertIn("server not running", result["error"])

    def test_missing_herdr_message_is_chinese_with_next_step(self):
        with patch.object(bridge.shutil, "which", return_value=None), \
                patch.object(bridge.subprocess, "run", side_effect=FileNotFoundError("herdr")):
            with self.assertRaises(bridge.BridgeError) as caught:
                bridge.call(["session", "list", "--json"])
        self.assertIn("没找到 Herdr", str(caught.exception))

    def test_old_python_is_refused_on_stderr(self):
        # The app recognises this exact phrase (ConnectErrors.command → python_old).
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(bridge.sys, "version_info", (3, 8, 10)), patch.object(bridge.sys, "stderr", stderr), \
                patch.object(bridge.sys, "stdout", stdout):
            with self.assertRaises(SystemExit) as caught:
                bridge.main()
        self.assertIn("needs Python 3.9", str(caught.exception.code))
        self.assertEqual(stdout.getvalue(), "")

    def test_hello_end_to_end_over_stdin(self):
        out = subprocess.run([sys.executable, str(BRIDGE)], input='{"v":1,"op":"hello"}\n', capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout)["data"]["protocol"], 1)


if __name__ == "__main__":
    unittest.main()
