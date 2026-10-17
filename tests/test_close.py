"""Closing sessions from the phone. Herdr is a recorded fake: nothing is closed or sent for real."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_bridge import bridge

UUID = "12345678-1234-4234-8234-123456789012"
UUID2 = "22345678-1234-4234-8234-123456789012"
HASH = "a" * 64


class CloseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.state = Path(self.tmp.name) / "state"
        self.calls = []
        self.agent = {"pane_id": "w1:p2", "terminal_id": "term_a", "agent": "claude", "agent_status": "idle",
                      "workspace_id": "w1", "tab_id": "w1:t1"}
        self.pane = {"pane_id": "w1:p2", "terminal_id": "term_a", "agent": "claude", "agent_status": "idle",
                     "focused": True, "workspace_id": "w1", "tab_id": "w1:t1"}
        self.close_error = None       # HerdrRejected code, or "TIMEOUT"
        self.closed = False
        self.prompt_error = None
        self.route = None
        self.screen = ""              # what an agent read shows (exitAgent first looks for a dialog)
        p = patch.object(bridge, "call", side_effect=self.call); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, "probe_pane", side_effect=lambda a, prefix, provider: {"route": self.route}); p.start(); self.addCleanup(p.stop)

    def call(self, args, timeout=20):
        self.calls.append(args)
        cmd = args[2:]
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if cmd == ["agent", "list"]: return {"agents": [] if self.closed or not self.agent else [self.agent]}
        if cmd[:2] == ["pane", "get"]:
            if self.closed or not self.pane: raise bridge.HerdrRejected("pane_not_found", "gone")
            return {"pane": self.pane}
        if cmd == ["workspace", "list"]: return {"workspaces": [{"workspace_id": "w1", "label": "stm32_host", "pane_count": 5}]}
        if cmd[:2] == ["tab", "list"]: return {"tabs": [{"tab_id": "w1:t1", "label": "调试", "pane_count": 1}]}
        if cmd[:2] == ["pane", "close"]:
            if self.close_error == "TIMEOUT": raise bridge.BridgeError("Herdr timeout")
            if self.close_error: raise bridge.HerdrRejected(self.close_error, "no")
            self.closed = True
            return {"type": "ok"}
        if cmd[:2] == ["agent", "read"]: return {"text": self.screen}
        if cmd[:2] == ["agent", "prompt"]:
            if self.prompt_error: raise bridge.HerdrRejected(self.prompt_error, "no")
            return {"type": "prompt_submitted"}
        raise AssertionError("unexpected herdr call " + repr(args))

    def req(self, op="closePane", **kw):
        r = dict(v=1, op=op, session="default", id=UUID, target="w1:p2", identity=bridge.identity(self.agent or {}))
        r.update(kw); return r

    def mutations(self):
        return [a[2:] for a in self.calls if a[2:4] in (["pane", "close"], ["agent", "prompt"], ["agent", "send-keys"])]

    # ── closeInfo ──
    def test_info_is_read_only_and_names_the_place(self):
        info = bridge.handle(self.req("closeInfo", id=None))
        self.assertEqual((info["pane_id"], info["agent"], info["focused"], info["workspace_label"], info["tab_label"], info["tab_panes"]),
                         ("w1:p2", "claude", True, "stm32_host", "调试", 1))
        self.assertEqual(info["exit_command"], "/exit")
        self.assertFalse(info["ch"])
        self.assertEqual(self.mutations(), [])

    def test_info_reports_ch_route(self):
        self.route = {"ssh": ["remote"], "workspace": "~/.local/share/ch/workspaces/7458c85a-6863-d9ce-a5a4-61ac374b8883", "key": "k"}
        info = bridge.handle(self.req("closeInfo"))
        self.assertTrue(info["ch"]); self.assertEqual(info["ch_session"], "7458c85a-6863-d9ce-a5a4-61ac374b8883")

    def test_info_refuses_changed_identity(self):
        with self.assertRaisesRegex(bridge.BridgeError, "变了"):
            bridge.handle(self.req("closeInfo", identity=HASH))

    # ── closePane ──
    def test_close_pane_closes_exactly_that_pane_once(self):
        r = bridge.handle(self.req(), self.state)
        self.assertEqual((r["closed"], r["pane_id"], r["verified"]), (True, "w1:p2", True))
        self.assertEqual(self.mutations(), [["pane", "close", "w1:p2"]])
        # Same id again: the stored receipt, never a second close.
        again = bridge.handle(self.req(), self.state)
        self.assertEqual(again, r)
        self.assertEqual(self.mutations(), [["pane", "close", "w1:p2"]])

    def test_reused_id_with_other_content_is_refused(self):
        bridge.handle(self.req(), self.state)
        with self.assertRaisesRegex(bridge.BridgeError, "reused"):
            bridge.handle(self.req(target="w1:p3"), self.state)

    def test_identity_mismatch_closes_nothing_and_burns_the_id(self):
        with self.assertRaisesRegex(bridge.BridgeError, "^没关：.*变了"):
            bridge.handle(self.req(identity=HASH), self.state)
        self.assertEqual(self.mutations(), [])
        self.assertEqual(bridge.handle(self.req(identity=HASH), self.state)["closed"], False)
        self.assertEqual(self.mutations(), [])

    def test_agent_replaced_in_pane_is_refused(self):
        expected = bridge.identity(self.agent)
        self.agent = dict(self.agent, terminal_id="term_b"); self.pane = dict(self.pane, terminal_id="term_b")
        with self.assertRaisesRegex(bridge.BridgeError, "变了"):
            bridge.handle(self.req(identity=expected), self.state)
        self.assertEqual(self.mutations(), [])

    def test_plain_shell_pane_uses_pane_identity(self):
        self.agent = None; self.pane = {"pane_id": "w1:p2", "terminal_id": "term_a", "agent": None, "workspace_id": "w1", "tab_id": "w1:t1"}
        r = bridge.handle(self.req(identity=bridge.identity(self.pane)), self.state)
        self.assertTrue(r["closed"])
        self.assertEqual(self.mutations(), [["pane", "close", "w1:p2"]])

    def test_strict_fields_and_targets(self):
        for bad in (dict(extra=1), dict(target="w1:p2; rm -rf ~"), dict(target="--all"), dict(id="not-a-uuid"), dict(identity="x")):
            with self.subTest(bad=bad), self.assertRaises(bridge.BridgeError):
                bridge.handle(self.req(**bad), self.state)
        self.assertEqual(self.mutations(), [])

    def test_gone_pane(self):
        self.pane = None; self.agent = None
        with self.assertRaisesRegex(bridge.BridgeError, "^没关：这个窗格已经不在了"):
            bridge.handle(self.req(), self.state)
        self.assertEqual(self.mutations(), [])

    def test_herdr_refusal_is_definite(self):
        self.close_error = "pane_busy"
        with self.assertRaisesRegex(bridge.BridgeError, r"^没关：Herdr 没接受（pane_busy）"):
            bridge.handle(self.req(), self.state)
        self.assertEqual(bridge.handle(self.req(), self.state), {"closed": False, "code": "pane_busy"})
        self.assertEqual(len(self.mutations()), 1)

    def test_timeout_is_unknown_and_never_replayed(self):
        self.close_error = "TIMEOUT"
        with self.assertRaisesRegex(bridge.BridgeError, "^关闭结果未知"):
            bridge.handle(self.req(), self.state)
        self.close_error = None
        with self.assertRaisesRegex(bridge.BridgeError, "上次关闭的结果未知"):
            bridge.handle(self.req(), self.state)
        self.assertEqual(self.mutations(), [["pane", "close", "w1:p2"]])

    def test_create_receipts_keep_their_message(self):
        db, _ = bridge.receipt_open(self.state, UUID2, "d")
        db.close()
        with self.assertRaisesRegex(bridge.BridgeError, "上次新建的结果未知"):
            bridge.receipt_open(self.state, UUID2, "d")

    # ── exitAgent ──
    def test_exit_claude_sends_exit_through_prompt_with_receipt(self):
        r = bridge.handle(self.req("exitAgent"), self.state)
        self.assertEqual((r["sent"], r["command"]), (True, "/exit"))
        self.assertEqual(self.mutations(), [["agent", "prompt", "w1:p2", "/exit"]])
        bridge.handle(self.req("exitAgent"), self.state)
        self.assertEqual(len(self.mutations()), 1)

    def test_exit_codex_uses_quit(self):
        self.agent = dict(self.agent, agent="codex")
        r = bridge.handle(self.req("exitAgent", identity=bridge.identity(self.agent)), self.state)
        self.assertEqual(r["command"], "/quit")
        self.assertEqual(self.mutations(), [["agent", "prompt", "w1:p2", "/quit"]])

    def test_exit_refuses_busy_agent_and_any_text(self):
        for status in ("working", "blocked", "unknown"):
            self.agent = dict(self.agent, agent_status=status)
            with self.subTest(status=status), self.assertRaisesRegex(bridge.BridgeError, "^没发出去"):
                bridge.handle(self.req("exitAgent", id=UUID[:-1] + str(len(status) % 10)), self.state)
        self.agent = dict(self.agent, agent_status="idle")
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去"):
            bridge.handle(self.req("exitAgent", text="rm -rf ~", id=UUID2), self.state)
        self.assertEqual(self.mutations(), [])

    def test_exit_refused_while_a_dialog_is_on_screen(self):
        # Herdr can call a Claude idle while its question dialog is up (a narrow pane wraps the footer):
        # "/exit" and Enter would pick an option.
        rule = "─" * 46
        self.screen = "\n".join([rule, "←  ☐ Lang  ✔ Submit  →", "", "Which one?", "", "❯ 1. [ ] Python", "  2. [ ] Bash",
                                  "  3. [ ] Type something", "     Submit", rule, "  4. Chat about this", "",
                                  "Enter to select · ↑/↓ to navigate · Esc to", "cancel"])
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：Agent 还在干活或在等确认"):
            bridge.handle(self.req("exitAgent"), self.state)
        self.assertEqual(self.mutations(), [])

    def test_exit_not_sent_code_is_reported(self):
        self.prompt_error = "agent_blocked"
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去"):
            bridge.handle(self.req("exitAgent"), self.state)

    def test_exit_checks_identity(self):
        with self.assertRaisesRegex(bridge.BridgeError, "Agent changed"):
            bridge.handle(self.req("exitAgent", identity=HASH), self.state)
        self.assertEqual(self.mutations(), [])

    # ── hidden history records ──
    def test_hidden_records_round_trip(self):
        self.assertEqual(bridge.handle({"v": 1, "op": "hidden"}, self.state), {"ids": []})
        remote_id = "remote:" + "b" * 24 + ":" + "c" * 64
        r = bridge.handle({"v": 1, "op": "hidden", "add": [HASH, remote_id]}, self.state)
        self.assertEqual(r["ids"], [HASH, remote_id])
        r = bridge.handle({"v": 1, "op": "hidden", "remove": [HASH]}, self.state)
        self.assertEqual(r["ids"], [remote_id])
        path = self.state / "hidden-records.json"
        self.assertEqual(json.loads(path.read_text()), [remote_id])
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(bridge.BridgeError):
            bridge.handle({"v": 1, "op": "hidden", "add": ["../../etc/passwd"]}, self.state)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
