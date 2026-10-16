"""ch panes: the agent runs on another computer behind a local relay. Herdr lists it but refuses its
agent commands (agent_not_ready: no longer the pane foreground process), so input goes to the pane."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parents[1] / "bridge/pocket_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

ROUTE = {"ssh": ["remote"], "workspace": "~/.local/share/ch/workspaces/x", "key": "k"}


class RelayTests(unittest.TestCase):
    def setUp(self):
        self.real_call = bridge.call
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.state = Path(directory.name)
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term_r", "agent": "claude", "agent_status": "done"}
        self.commands, self.broken = [], None
        self.probe = {"ok": True, "route": ROUTE, "native": False}
        for target, fake in ((bridge, "call"), (bridge, "probe_pane"), (bridge.time, "sleep")):
            side = {"call": self.call, "probe_pane": lambda *a: dict(self.probe), "sleep": lambda s: None}[fake]
            p = patch.object(target, fake, side_effect=side); p.start(); self.addCleanup(p.stop)

    def call(self, args):
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
        if args[:2] == ["--session", "default"]: args = args[2:]
        self.commands.append(args)
        if self.broken and args[:2] == self.broken: raise bridge.BridgeError("link dropped")
        # Herdr lists the agent but refuses its agent commands on a relay pane.
        if args[0] == "agent" and args[1] in ("prompt", "send-keys") and self.probe.get("route") and not self.probe.get("native"):
            raise bridge.HerdrRejected("agent_not_ready", "agent w1:p1 is no longer the pane foreground process")
        return {"type": "ok"}

    def send(self, op="prompt", **extra):
        req = dict(v=1, op=op, session="default", target="w1:p1", identity=bridge.identity(self.agent),
                   id="12345678-1234-1234-1234-123456789012", **extra)
        return bridge.handle(req, self.state)

    def receipt(self):
        row = sqlite3.connect(self.state / "receipts.sqlite").execute("SELECT result FROM receipts").fetchone()
        return None if row[0] is None else json.loads(row[0])

    def test_one_line_prompt_runs_in_the_pane(self):
        result = self.send(text="继续，把测试跑一下")
        self.assertEqual(self.commands, [["agent", "prompt", "w1:p1", "继续，把测试跑一下"], ["pane", "run", "w1:p1", "继续，把测试跑一下"]])
        self.assertTrue(result["sent"]); self.assertTrue(self.receipt()["sent"])

    def test_several_lines_are_one_bracketed_paste_then_enter(self):
        self.send(text="第一行\r\n第二行")
        self.assertEqual(self.commands[1:], [["pane", "send-text", "w1:p1", "\x1b[200~第一行\n第二行\x1b[201~"], ["pane", "send-keys", "w1:p1", "enter"]])

    def test_keys_and_exit_go_to_the_pane(self):
        self.agent["agent_status"] = "working"
        self.send(op="key", key="esc")
        self.assertEqual(self.commands, [["agent", "send-keys", "w1:p1", "esc"], ["pane", "send-keys", "w1:p1", "esc"]])

    def test_exit_command_runs_in_the_pane(self):
        self.send(op="exitAgent")
        self.assertEqual(self.commands, [["agent", "prompt", "w1:p1", "/exit"], ["pane", "run", "w1:p1", "/exit"]])

    def test_local_agent_keeps_herdr_agent_commands(self):
        self.probe = {"ok": True, "route": None, "native": True}
        self.send(text="hi")
        self.assertEqual(self.commands, [["agent", "prompt", "w1:p1", "hi"]])

    def test_unreadable_process_tree_keeps_herdr_agent_commands(self):
        self.probe = {"ok": False, "route": None}
        self.send(text="hi")
        self.assertEqual(self.commands[0][:2], ["agent", "prompt"])

    def test_agent_running_locally_under_a_ch_parent_is_not_a_relay(self):
        self.probe = {"ok": True, "route": ROUTE, "native": True}
        self.send(text="hi")
        self.assertEqual(self.commands[0][:2], ["agent", "prompt"])

    def test_enter_failing_after_the_paste_leaves_the_outcome_unknown(self):
        self.broken = ["pane", "send-keys"]
        with self.assertRaisesRegex(bridge.BridgeError, "link dropped"):
            self.send(text="a\nb")
        self.assertIsNone(self.receipt())
        with self.assertRaisesRegex(bridge.BridgeError, "outcome is unknown"):
            self.send(text="a\nb")
        self.assertEqual([c for c in self.commands if c[0] == "pane"], [["pane", "send-text", "w1:p1", "\x1b[200~a\nb\x1b[201~"], ["pane", "send-keys", "w1:p1", "enter"]], "never typed twice")

    def test_not_ready_on_a_local_agent_is_not_rerouted(self):
        self.probe = {"ok": True, "route": None, "native": True}
        def refuse(args):
            if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
            if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
            self.commands.append(args)
            raise bridge.HerdrRejected("agent_not_ready", "agent is still starting")
        with patch.object(bridge, "call", side_effect=refuse):
            with self.assertRaisesRegex(bridge.BridgeError, "没发出去"):
                self.send(text="hi")
        self.assertFalse(any(c[2:4] == ["pane", "run"] or c[:2] == ["pane", "run"] for c in self.commands))
        self.assertEqual(self.receipt(), {"sent": False, "rejected": "agent_not_ready"})

    def test_relay_answer_presses_keys_in_the_pane(self):
        sent = []
        self.agent["agent_status"] = "blocked"
        # The answer's key transport is built from the agent; a relay pane gets the pane-level one.
        def first_refused(request, agent):
            sent.append(bool(agent.get("relay")))
            if not agent.get("relay"): raise bridge.HerdrRejected("agent_not_ready", "agent w1:p1 is no longer the pane foreground process")
            return {"answered": True}
        with patch.object(bridge, "herdr_answer_io", side_effect=lambda prefix, agent: agent), \
                patch.object(bridge, "answer_question", side_effect=first_refused), patch.object(bridge, "validate_answer", return_value=None):
            self.send(op="answer", action="select", option=1, label="x", fingerprint="f")
        self.assertEqual(sent, [False, True])

    def test_silent_success_of_pane_input_counts_as_sent(self):
        # Measured on Herdr 0.8.2: pane run / send-text / send-keys print nothing and exit 0.
        class Done:
            returncode, stdout, stderr = 0, "", ""
        with patch.object(bridge.subprocess, "run", return_value=Done()) as run:
            for args in (["pane", "run", "w1:p1", "hi"], ["pane", "send-text", "w1:p1", "x"], ["pane", "send-keys", "w1:p1", "enter"],
                         ["--session", "default", "pane", "run", "w1:p1", "hi"]):
                self.assertEqual(self.real_call(args), {"type": "ok"})
            # Anything else still has to answer in JSON.
            with self.assertRaisesRegex(bridge.BridgeError, "non-JSON"):
                self.real_call(["agent", "list"])

    def test_blocked_full_screen_agent_is_read_from_the_visible_screen(self):
        self.agent["agent_status"] = "blocked"
        def read(args):
            if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
            if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
            if args[:2] == ["--session", "default"]: args = args[2:]
            self.commands.append(args)
            if "recent-unwrapped" in args: raise bridge.HerdrRejected("agent_not_idle", "cannot read 160 lines while w1:p1 is blocked; use --source visible")
            return {"text": "  1. 先不动\n  2. 重写\n"}
        with patch.object(bridge, "call", side_effect=read):
            r = bridge.handle({"v": 1, "op": "read", "session": "default", "target": "w1:p1", "identity": bridge.identity(self.agent)})
        self.assertEqual(r["text"], "  1. 先不动\n  2. 重写\n")
        self.assertEqual(self.commands[-1], ["agent", "read", "w1:p1", "--source", "visible"])

    def test_busy_relay_agent_is_not_prompted(self):
        self.agent["agent_status"] = "working"
        with self.assertRaisesRegex(bridge.BridgeError, "busy"):
            self.send(text="hi")
        self.assertEqual(self.commands, [])


if __name__ == "__main__":
    unittest.main()
