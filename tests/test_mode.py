"""Agent modes: what Claude Code / Codex print under their input box, parsed from the screen read,
the transcript's own mode records (glance), and Shift+Tab as the one key that switches them.
Screens follow the real footers of Claude Code 2.1.x and Codex 0.16x (contents sanitized)."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parents[1] / "bridge/pocket_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

RULE = "─" * 72


def claude(footer, above=("● 好的，改完了。",), prompt="❯ "):
    return "\n".join([*above, "", RULE, prompt, RULE, "  ~/demo [.venv] Opus 5.5", *footer, "", ""])


def codex(status, hints="  ← for agents · ? for shortcuts", above=("• 改完了，测试也过了。",), prompt="› Ask Codex to do anything"):
    return "\n".join([*above, "", prompt, status, hints, ""])


STATUS = "  GPT-6 medium fast · ~/demo · Context 3% used · weekly 50% left"


class ClaudeScreenTests(unittest.TestCase):
    def modes(self, text): return bridge.screen_modes(text, "claude")

    def test_each_permission_mode(self):
        cases = {"⏸ manual mode on · ← for agents": "default",
                 "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents": "acceptEdits",
                 "⏸ plan mode on (shift+tab to cycle) · ← for agents": "plan",
                 "⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent": "auto",
                 "⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent": "bypassPermissions",
                 "⏵⏵ bypass permissions on · 4 shells · ← 1 agent": "bypassPermissions",
                 "⏵⏵ don't ask on (shift+tab to cycle)": "dontAsk"}
        for line, mode in cases.items():
            with self.subTest(line=line):
                m = self.modes(claude(["  " + line]))
                self.assertEqual((m["agent"], m["permission"], m["goal"]), ("claude", mode, None))
                self.assertTrue(m["cycle"])

    def test_goal_is_separate_from_the_mode(self):
        m = self.modes(claude(["  ⏸ plan mode on (shift+tab to cycle) · ◎ /goal active (12m) · ← for agents"]))
        self.assertEqual(m["permission"], "plan")
        self.assertEqual(m["goal"], {"state": "active", "elapsed": "12m"})
        m = self.modes(claude(["  ⏸ manual mode on · ◎ /goal active"]))
        self.assertEqual((m["permission"], m["goal"]["state"]), ("default", "active"))

    def test_subagent_list_under_the_footer(self):
        m = self.modes(claude(["  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent", "  ● main",
                               "  ◯ general-purpose  Reading files…   6m 19s · ↓ 142.1k tokens"]))
        self.assertEqual(m["permission"], "bypassPermissions")

    def test_conversation_text_never_counts(self):
        # The words are in the reply above the box; the footer itself shows no mode.
        text = claude(["  ? for shortcuts"], above=("● 进入后底部会显示 ⏸ plan mode on (shift+tab to cycle)。", "  ◎ /goal active (3m)"))
        m = self.modes(text)
        self.assertEqual((m["permission"], m["goal"]), ("default", None))

    def test_footer_without_mode_line_is_unknown(self):
        self.assertIsNone(self.modes(claude([]))["permission"])

    def test_multiline_draft_in_the_box(self):
        text = "\n".join([RULE, "❯ 第一行", "  第二行", RULE, "  ⏸ plan mode on (shift+tab to cycle)"])
        self.assertEqual(self.modes(text)["permission"], "plan")

    def test_menu_on_screen_reports_nothing(self):
        menu = "\n".join([RULE, " Bash command", "   rm -rf dist", " Do you want to proceed?", " ❯ 1. Yes",
                          "   2. Yes, and don't ask again", "   3. No (esc)", "", " Esc to cancel · Tab to amend"])
        self.assertIsNone(self.modes(menu))
        self.assertIsNone(self.modes(""))


class CodexScreenTests(unittest.TestCase):
    def modes(self, text): return bridge.screen_modes(text, "codex")

    def test_default_and_plan(self):
        m = self.modes(codex(STATUS))
        self.assertEqual((m["agent"], m["collaboration"], m["goal"]), ("codex", "default", None))
        m = self.modes(codex(STATUS + "            Plan mode (shift+tab to cycle)"))
        self.assertEqual(m["collaboration"], "plan")

    def test_goal_states(self):
        cases = {"Pursuing goal (5m)": ("active", "5m"), "Goal paused (/goal resume)": ("paused", ""),
                 "Goal stalled (/goal resume)": ("blocked", ""), "Goal hit usage limits (/goal resume)": ("usage_limited", ""),
                 "Goal achieved (1h 2m)": ("complete", "1h 2m")}
        for label, (state, elapsed) in cases.items():
            with self.subTest(label=label):
                m = self.modes(codex(STATUS, hints="  ← for agents · ? for shortcuts      " + label))
                self.assertEqual(m["goal"], {"state": state, "elapsed": elapsed})
                self.assertEqual(m["collaboration"], "default")

    def test_truncated_status_line_is_unknown(self):
        m = self.modes(codex("  GPT-6 medium fast · /mnt/E/project · Context 2…"))
        self.assertIsNone(m["collaboration"])

    def test_history_user_lines_are_not_the_composer(self):
        # An approval overlay replaces the composer: the last › line is the menu, with no footer under it.
        text = "\n".join(["› 帮我跑测试", "• Ran npm test", "", "  Would you like to run the following command?",
                          "› 1. Yes, proceed (y)", "  2. No, and tell Codex what to do differently (esc)", "", "  Press enter to confirm or esc to cancel"])
        self.assertIsNone(self.modes(text))

    def test_working_footer(self):
        m = self.modes(codex(STATUS, hints="  esc to interrupt · tab to queue", above=("• Working (12s • esc to interrupt)",)))
        self.assertEqual(m["collaboration"], "default")

    def test_other_agents_report_nothing(self):
        self.assertIsNone(bridge.screen_modes(codex(STATUS), "pi"))


class TranscriptModeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.home = Path(directory.name)
        p = patch.object(bridge.Path, "home", return_value=self.home); p.start(); self.addCleanup(p.stop)

    def tail(self, provider, rows):
        path = self.home / "t.jsonl"
        path.write_text("".join(json.dumps(r) + "\n" for r in rows))
        modes = {}
        bridge.glance_tail(path, provider, 1 << 20, modes)
        return modes

    def test_claude_newest_permission_mode(self):
        rows = [{"type": "user", "permissionMode": "default", "timestamp": "t1", "message": {"role": "user", "content": "a"}},
                {"type": "user", "permissionMode": "plan", "timestamp": "t2", "message": {"role": "user", "content": "b"}},
                {"type": "user", "permissionMode": "<script>", "timestamp": "t3", "message": {"role": "user", "content": "c"}}]
        self.assertEqual(self.tail("claude", rows), {"permission": "plan", "at": "t2"})

    def test_codex_turn_context(self):
        ctx = lambda mode, approval, sandbox, t: {"type": "turn_context", "timestamp": t, "payload": {
            "collaboration_mode": {"mode": mode, "settings": {"developer_instructions": "x" * 500}},
            "approval_policy": approval, "sandbox_policy": {"type": sandbox}}}
        modes = self.tail("codex", [ctx("plan", "on-request", "workspace-write", "t1"), ctx("default", "never", "danger-full-access", "t2")])
        self.assertEqual(modes, {"collaboration": "default", "approval": "never", "sandbox": "danger-full-access", "at": "t2"})

    def test_codex_goal_is_read_only_from_its_database(self):
        (self.home / ".codex").mkdir()
        db = sqlite3.connect(self.home / ".codex/goals_1.sqlite")
        db.execute("CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT, updated_at_ms INTEGER)")
        thread = "01a14035-2079-7513-be2e-a886caefc891"
        db.execute("INSERT INTO thread_goals VALUES (?, 'g', ?, 'paused', 1791873964951)", (thread, "把整套测试补齐\n第二行"))
        db.commit(); db.close()
        goal = bridge.codex_goal(thread)
        self.assertEqual((goal["state"], goal["objective"]), ("paused", "把整套测试补齐"))
        self.assertIsNone(bridge.codex_goal("01a14035-2079-7513-be2e-000000000000"))
        self.assertIsNone(bridge.codex_goal("../../etc"))


class ShiftTabKeyTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.state = Path(directory.name)
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term_m", "agent": "claude", "agent_status": "idle"}
        self.commands, self.relay = [], False
        self.screen = claude(["  ⏸ plan mode on (shift+tab to cycle)"])
        for name, side in (("call", self.call), ("probe_pane", lambda *a: {"ok": True, "route": {"ssh": ["r"]} if self.relay else None, "native": not self.relay})):
            p = patch.object(bridge, name, side_effect=side); p.start(); self.addCleanup(p.stop)

    def call(self, args):
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
        args = args[2:]
        self.commands.append(args)
        if args[:2] == ["agent", "read"]: return {"text": self.screen}
        if self.relay and args[0] == "agent":
            raise bridge.HerdrRejected("agent_not_ready", "agent w1:p1 is no longer the pane foreground process")
        return {"type": "ok"}

    def send(self, op="key", **extra):
        return bridge.handle(dict(v=1, op=op, session="default", target="w1:p1", identity=bridge.identity(self.agent),
                                  id="12345678-1234-1234-1234-123456789012", **extra), self.state)

    def test_shift_tab_goes_to_the_agent(self):
        self.assertTrue(self.send(key="shift+tab")["sent"])
        self.assertEqual(self.commands, [["agent", "send-keys", "w1:p1", "shift+tab"]])

    def test_shift_tab_while_working_is_allowed(self):
        self.agent["agent_status"] = "working"; self.agent["agent"] = "codex"
        self.assertTrue(self.send(key="shift+tab")["sent"])

    def test_ch_pane_gets_it_at_the_pane_level(self):
        self.relay = True
        self.send(key="shift+tab")
        self.assertEqual(self.commands, [["agent", "send-keys", "w1:p1", "shift+tab"], ["pane", "send-keys", "w1:p1", "shift+tab"]])

    def test_never_while_a_question_or_approval_waits(self):
        # On a Claude permission dialog Shift+Tab means "yes, and don't ask again".
        self.agent["agent_status"] = "blocked"
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：Agent 正等你确认"): self.send(key="shift+tab")
        self.assertEqual(self.commands, [])
        self.assertFalse((self.state / "receipts.sqlite").exists() and sqlite3.connect(self.state / "receipts.sqlite").execute("SELECT 1 FROM receipts").fetchone())

    def test_only_claude_and_codex(self):
        self.agent["agent"] = "pi"
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去"): self.send(key="shift+tab")
        self.assertEqual(self.commands, [])

    def test_other_names_are_refused(self):
        for key in ("backtab", "shift-tab", "tab", "ctrl+d"):
            with self.subTest(key=key), self.assertRaisesRegex(bridge.BridgeError, "Unsupported key"): self.send(key=key)

    def test_read_carries_the_modes(self):
        r = self.send(op="read")
        self.assertEqual(r["modes"], {"agent": "claude", "permission": "plan", "goal": None, "cycle": True})
        self.screen = "nothing here"
        self.assertIsNone(self.send(op="read")["modes"])


if __name__ == "__main__":
    unittest.main()
