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
                         {"herdr": True, "sessions": [{"name": "default", "running": True, "default": None}]})

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

    def test_ch_trust_dialog_walks_to_yes_with_pane_keys(self):
        lines = ['~/site', '❯ claude', '', '─' * 100,
                 ' Quick safety check: Is this a project you created or one you trust?',
                 '', " Claude Code'll be able to read, edit, and execute files here.", '', ' Security guide', '',
                 '', '', '', ' Enter to confirm · Esc to cancel']
        class IO:
            provider = "claude"
            def __init__(self): self.cursor, self.keys, self.typed = 1, [], ""
            def screen(self):
                rows = list(lines)
                rows[10] = (" ❯ No, exit" if self.cursor == 1 else "   No, exit")
                rows[11] = (" ❯ Yes, I trust this folder" if self.cursor == 2 else "   Yes, I trust this folder")
                return "\n".join(rows)
            def key(self, name):
                self.keys.append(name)
                if name == "down": self.cursor = min(2, self.cursor + 1)
                elif name == "up": self.cursor = max(1, self.cursor - 1)
            def text(self, value): self.typed = value
        io = IO()
        # A ch pane's dialog is parsed as its displayed agent (Claude), so trust is an approval
        # and Esc is known to mean "No, exit" rather than a cancellation the agent survives.
        menu = bridge.parse_menu(io.screen(), bridge.agent_provider({"agent": "ch", "display_agent": "claude"}))
        self.assertEqual(menu["kind"], "approval")
        self.assertEqual(menu["cursor"], 1)
        self.assertEqual(menu["esc"], {"action": "cancel", "option": 1})
        self.assertEqual([o["label"] for o in menu["options"]], ["No, exit", "Yes, I trust this folder"])
        result = bridge.answer_question({"action": "select", "option": 2, "fingerprint": menu["fingerprint"],
                                         "label": "Yes, I trust this folder", "labels": {}}, io)
        self.assertEqual(result["steps"], ["down", "enter"])

    def test_ch_pane_resolves_as_its_displayed_agent(self):
        ch = {"pane_id": "w1:p1", "terminal_id": "term_ch", "agent": "ch", "display_agent": "claude"}
        self.assertEqual(bridge.agent_provider(ch), "claude")
        self.assertEqual(bridge.agent_provider({"agent": "claude", "display_agent": "claude"}), "claude")
        self.assertEqual(bridge.agent_provider({"agent": "ch"}), "ch")
        with patch.object(bridge, "probe_pane", return_value={"ok": True, "route": {"key": "r"}, "native": False}) as probe:
            self.assertTrue(bridge.relay_pane(ch, ["--session", "default"]))
        probe.assert_called_with(ch, ["--session", "default"], "claude")

    def transcript(self, rows, name="parent.jsonl"):
        path = self.state / name
        path.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
        return path

    def test_claude_waiting_on_kid_reads_the_last_own_row(self):
        waiting = self.transcript([
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "call_1", "name": "Read", "input": {}}]}},
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "call_2", "name": "Agent", "input": {}}]}},
        ])
        self.assertTrue(bridge.claude_waiting_on_kid(waiting))
        # Queue / attachment rows written while it waits do not mean the parent resumed.
        with waiting.open("a") as stream:
            stream.write(json.dumps({"type": "queue-operation", "operation": "enqueue", "content": "x"}) + "\n")
        self.assertTrue(bridge.claude_waiting_on_kid(waiting))
        # The result (a user row) means it is no longer inside the Agent call.
        with waiting.open("a") as stream:
            stream.write(json.dumps({"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "call_2", "content": "done"}]}}) + "\n")
        self.assertFalse(bridge.claude_waiting_on_kid(waiting))

    def test_async_agent_launch_is_not_waiting(self):
        path = self.transcript([
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "call_1", "name": "Agent", "input": {}}]}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "call_1", "content": "Async agent launched"}]},
             "toolUseResult": {"isAsync": True}},
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "call_2", "name": "Bash", "input": {}}]}},
        ])
        self.assertFalse(bridge.claude_waiting_on_kid(path))
        # A newer assistant row that is only the Agent call again: waiting.
        with path.open("a") as stream:
            stream.write(json.dumps({"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "call_3", "name": "Task", "input": {}}]}}) + "\n")
        self.assertTrue(bridge.claude_waiting_on_kid(path))

    def claude_waiting_prompt(self, waiting):
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term_test", "agent": "claude",
                      "agent_status": "working", "agent_session": {"value": "unused"},
                      "cwd": "/work/proj"}
        path = self.transcript([{"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "call_1", "name": "Agent" if waiting else "Bash", "input": {}}]}}])
        patcher = patch.object(bridge, "claude_agent_transcript", return_value=path)
        patcher.start(); self.addCleanup(patcher.stop)
        return path

    def test_prompt_goes_to_a_parent_waiting_on_its_kid(self):
        self.claude_waiting_prompt(True)
        with patch.object(bridge, "herdr_box", return_value={"box": "", "menu": None, "pasting": False}), \
             patch.object(bridge, "box_attempt", return_value=({"verified": True}, None)):
            result = bridge.handle(self.request(), self.state)
        self.assertTrue(result["sent"])
        self.assertEqual([c for c in self.commands if c[:2] == ["agent", "prompt"]], [])

    def test_prompt_refused_when_claude_works_on_its_own(self):
        self.claude_waiting_prompt(False)
        with patch.object(bridge, "herdr_box", return_value={"box": "", "menu": None, "pasting": False}), \
             patch.object(bridge, "box_attempt", return_value=({"verified": True}, None)):
            with self.assertRaisesRegex(bridge.BridgeError, "busy"):
                bridge.handle(self.request(), self.state)

    def test_prompt_refused_when_waiting_but_box_unreadable(self):
        self.claude_waiting_prompt(True)
        with patch.object(bridge, "herdr_box", return_value=None), \
             patch.object(bridge, "box_attempt", return_value=({"verified": True}, None)):
            with self.assertRaisesRegex(bridge.BridgeError, "busy"):
                bridge.handle(self.request(), self.state)

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
