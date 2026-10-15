import json
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parents[1] / "bridge/pocket_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.state = Path(self.directory.name)
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term_test", "agent": "codex", "agent_status": "idle"}
        self.commands = []
        self.mock = patch.object(bridge, "call", side_effect=self.call)
        self.mock.start()
        self.addCleanup(self.mock.stop)
        self.addCleanup(self.directory.cleanup)

    def call(self, args):
        self.commands.append(args)
        if args == ["session", "list", "--json"]:
            return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]:
            return {"agents": [self.agent]}
        return {"text": "ok"}

    def request(self, op="prompt", **extra):
        return dict(v=1, op=op, session="default", target="w1:p1",
                    identity=bridge.identity(self.agent), text="你好; $(touch /tmp/never)",
                    id="12345678-1234-1234-1234-123456789012", **extra)

    def test_status_is_cheap_and_keeps_identity(self):
        result = bridge.handle({"v": 1, "op": "status", "session": "default"})
        self.assertEqual(result["agents"][0]["identity"], bridge.identity(self.agent))
        self.assertEqual(result["agents"][0]["agent_status"], "idle")
        self.assertNotIn("history_ref", result["agents"][0])
        # Only the Herdr list call: no process walk or transcript scan.
        self.assertFalse(any("process-info" in c for c in self.commands))

    def test_herdr_rejection_is_reported_as_not_sent(self):
        def call(args):
            self.commands.append(args)
            if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
            if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
            raise bridge.HerdrRejected("agent_blocked", "agent is waiting at a dialog")
        self.mock.stop(); patcher = patch.object(bridge, "call", side_effect=call); patcher.start(); self.addCleanup(patcher.stop)
        req = self.request()
        with self.assertRaisesRegex(bridge.BridgeError, "没发出去"):
            bridge.handle(req, self.state)
        import sqlite3
        row = sqlite3.connect(self.state / "receipts.sqlite").execute("SELECT result FROM receipts").fetchone()
        self.assertEqual(json.loads(row[0]), {"sent": False, "rejected": "agent_blocked"})

    def test_herdr_json_error_is_parsed(self):
        exc = bridge.herdr_error('{"error":{"code":"agent_not_found","message":"agent target w1:p9 not found"},"id":"x"}')
        self.assertEqual((exc.code, exc.detail), ("agent_not_found", "agent target w1:p9 not found"))
        self.assertIsNone(bridge.herdr_error("plain text"))

    def test_read_carries_herdr_state_for_fast_question_cards(self):
        self.agent["agent_status"] = "blocked"
        result = bridge.handle(dict(v=1, op="read", session="default", target="w1:p1", identity=bridge.identity(self.agent)))
        self.assertEqual(result["agent_status"], "blocked")
        self.assertIn("menu", result)

    def test_sessions_only_exposes_public_fields(self):
        self.assertEqual(bridge.handle({"v": 1, "op": "sessions"}),
                         {"sessions": [{"name": "default", "running": True, "default": None}]})

    def test_duplicate_prompt_is_sent_once_and_text_is_one_argument(self):
        req = self.request()
        first = bridge.handle(req, self.state)
        self.assertEqual(bridge.handle(req, self.state), first)
        writes = [c for c in self.commands if "prompt" in c]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0][-1], req["text"])

    def test_conflicting_duplicate_rejected(self):
        req = self.request()
        bridge.handle(req, self.state)
        req["text"] = "different"
        with self.assertRaisesRegex(bridge.BridgeError, "different content"):
            bridge.handle(req, self.state)

    def test_busy_prompt_rejected(self):
        self.agent["agent_status"] = "working"
        with self.assertRaisesRegex(bridge.BridgeError, "busy"):
            bridge.handle(self.request(), self.state)
        self.assertFalse(any("prompt" in c for c in self.commands))

    def test_replaced_agent_rejected(self):
        req = self.request()
        self.agent["terminal_id"] = "replacement"
        with self.assertRaisesRegex(bridge.BridgeError, "changed"):
            bridge.handle(req, self.state)

    def test_unknown_outcome_never_replays(self):
        original = self.call
        def uncertain(args):
            if "prompt" in args:
                self.commands.append(args)
                raise bridge.BridgeError("timeout")
            return original(args)
        bridge.call.side_effect = uncertain
        with self.assertRaisesRegex(bridge.BridgeError, "timeout"):
            bridge.handle(self.request(), self.state)
        with self.assertRaisesRegex(bridge.BridgeError, "unknown"):
            bridge.handle(self.request(), self.state)
        self.assertEqual(len([c for c in self.commands if "prompt" in c]), 1)

    def test_offline_session_cannot_be_created(self):
        req = self.request()
        req["session"] = "nonexistent"
        with self.assertRaisesRegex(bridge.BridgeError, "offline"):
            bridge.handle(req, self.state)
        self.assertFalse(any("--session" in c for c in self.commands))

    def test_keys_are_allowlisted(self):
        with self.assertRaisesRegex(bridge.BridgeError, "Unsupported key"):
            bridge.handle(self.request("key", key="rm -rf /"), self.state)

    def test_arbitrary_commands_rejected(self):
        with self.assertRaisesRegex(bridge.BridgeError, "Unknown"):
            bridge.handle({"v": 1, "op": "shell", "command": "id"}, self.state)

    def test_plain_text_read_is_not_parsed_as_json(self):
        self.mock.stop()
        from types import SimpleNamespace
        with patch.object(bridge.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="hello\nworld", stderr="")):
            self.assertEqual(bridge.call(["agent", "read", "w1:p1"]), {"text": "hello\nworld"})

    def test_non_json_control_output_is_rejected(self):
        self.mock.stop()
        from types import SimpleNamespace
        with patch.object(bridge.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout="shell banner", stderr="")):
            with self.assertRaisesRegex(bridge.BridgeError, "non-JSON"):
                bridge.call(["agent", "list"])

    def test_protocol_version_required(self):
        with self.assertRaises(bridge.BridgeError):
            bridge.handle({"op": "sessions"})


if __name__ == "__main__":
    unittest.main()
