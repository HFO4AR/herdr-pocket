"""A Claude / Codex in a Herdr pane: a prompt is refused while text already sits in the agent's own
input box (it would go out joined to that text), read from Herdr's coloured visible screen. Screens
are the real Codex captures (fixtures/codex_tmux.json) and Herdr's own ANSI fixtures. When the box
cannot be told (no colours, an unreadable screen) the prompt goes as before. Herdr is a fake."""
import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parents[1] / "bridge/pocket_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
FIXTURES = Path(__file__).parent / "fixtures"
CODEX = json.loads((FIXTURES / "codex_tmux.json").read_text(encoding="utf-8"))
HERDR_CODEX = (FIXTURES / "codex_screen.ansi").read_text(encoding="utf-8")
HERDR_CLAUDE = (FIXTURES / "claude_screen.ansi").read_text(encoding="utf-8")
IDS = ["%d2345678-1234-4234-8234-123456789012" % i for i in range(1, 10)]


class HerdrDraftTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name)
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term1", "agent": "codex", "agent_status": "idle"}
        self.commands, self.screen, self.unreadable = [], CODEX["idle"], False
        for name, fake in (("call", self.call), ("probe_pane", lambda *a: {"ok": True, "route": None, "native": True})):
            p = patch.object(bridge, name, side_effect=fake); p.start(); self.addCleanup(p.stop)

    def call(self, args):
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
        if args[:2] == ["--session", "default"]: args = args[2:]
        self.commands.append(args)
        if args[:2] == ["agent", "read"]:
            if self.unreadable: raise bridge.HerdrRejected("agent_not_found", "gone for a moment")
            return {"text": self.screen if "ansi" in args else bridge.strip_sgr(self.screen)}
        return {"type": "ok"}

    def prompt(self, request_id, text="Reply with just: OK"):
        return bridge.handle({"v": 1, "op": "prompt", "session": "default", "target": "w1:p1", "identity": bridge.identity(self.agent),
                              "id": request_id, "text": text}, self.state)

    def prompts(self): return [c for c in self.commands if c[:2] == ["agent", "prompt"]]

    def receipts(self):
        db = self.state / "receipts.sqlite"
        return sqlite3.connect(db).execute("SELECT count(*) FROM receipts").fetchone()[0] if db.exists() else 0

    def test_codex_draft_refused_before_anything_is_typed(self):
        for i, name in enumerate(("draft", "draft_multi")):
            self.screen = CODEX[name]
            with self.subTest(name), self.assertRaisesRegex(bridge.BridgeError, "^没发出去：它的输入框里已经有字了，发出去会连在一起"):
                self.prompt(IDS[i])
        self.assertEqual((self.prompts(), self.receipts()), ([], 0), "refused before the receipt: nothing sent, nothing recorded")
        # The colored visible screen was what was read.
        self.assertIn(["agent", "read", "w1:p1", "--source", "visible", "--format", "ansi"], self.commands)
        # Cleared on the computer: the same request id goes out normally.
        self.screen = CODEX["idle"]
        self.assertTrue(self.prompt(IDS[0])["sent"])
        self.assertEqual(self.prompts(), [["agent", "prompt", "w1:p1", "Reply with just: OK"]])

    def test_a_handled_request_answers_from_its_receipt(self):
        self.assertTrue(self.prompt(IDS[0])["sent"])
        # Its text now sits in the box (or anything else does): the same id is not refused, not resent.
        self.screen = CODEX["draft"]
        self.assertEqual(self.prompt(IDS[0])["receipt"], IDS[0])
        self.assertEqual(len(self.prompts()), 1)

    def test_codex_empty_composer_sends(self):
        # Herdr's own rendering draws the composer on a truecolor band (48;2;…): that 2 is not "dim".
        for i, screen in enumerate((CODEX["idle"], CODEX["esc_again"], CODEX["plan"], HERDR_CODEX)):
            self.screen = screen
            self.assertTrue(self.prompt(IDS[i], "m%d" % i)["sent"], i)
        typed = HERDR_CODEX.replace("\x1b[2m\x1b[48;2;65;69;76mAsk Codex to do anything", "\x1b[48;2;65;69;76mfix the flaky test")
        self.assertNotEqual(typed, HERDR_CODEX)
        self.screen = typed
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：它的输入框里已经有字"):
            self.prompt(IDS[5])
        self.assertEqual(len(self.prompts()), 4)

    def test_claude_box(self):
        self.agent["agent"] = "claude"
        rule = "\x1b[38;5;244m" + "─" * 40 + "\x1b[0m"
        box = lambda line: "\n".join(["● 好了。", "", rule, line, rule, "  \x1b[38;5;211m⏵⏵ accept edits on\x1b[0m"])
        cases = [(HERDR_CLAUDE, True), (box("\x1b[39m❯ \x1b[7m \x1b[0m"), True),
                 (box("\x1b[39m❯ \x1b[7mT\x1b[0m\x1b[2mry \"fix lint errors\"\x1b[0m"), True),
                 (box("\x1b[39m❯ \x1b[7mT\x1b[0m\x1b[38;5;246mry \"fix lint errors\"\x1b[0m"), True),
                 (box("\x1b[39m❯ Write a 30-line poem about terminals\x1b[7m \x1b[0m"), False)]
        for i, (screen, sends) in enumerate(cases):
            self.screen = screen
            with self.subTest(i):
                if sends: self.assertTrue(self.prompt(IDS[i])["sent"])
                else:
                    with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：它的输入框里已经有字了（可能是刚被中断"):
                        self.prompt(IDS[i])
        self.assertEqual(len(self.prompts()), 4)

    def test_dialog_herdr_calls_idle_is_never_typed_into(self):
        # Seen live (Herdr 0.8.2, Claude Code 2.1.268, a 46-column pane): the question dialog's footer
        # wraps ("Esc to" / "cancel"), Herdr reports the agent done, and a prompt's text plus Enter
        # ticked the highlighted checkbox. With no input box on screen and a dialog there, nothing goes.
        self.agent["agent"] = "claude"
        rule = "\x1b[38;5;244m" + "─" * 46 + "\x1b[0m"
        dialog = "\n".join([rule, "←  ☐ Lang  ✔ Submit  →", "", "Which language should the tiny demo script use", "for parsing?", "",
                             "\x1b[38;5;153m❯ 1. [ ] Python\x1b[0m", "  Python", "  2. [ ] Bash", "  Bash", "  3. [ ] Type something",
                             "     Submit", rule, "  4. Chat about this", "", "Enter to select · ↑/↓ to navigate · Esc to", "cancel"])
        for i, (status, screen) in enumerate((("done", dialog), ("idle", dialog), ("idle", bridge.strip_sgr(dialog)))):
            self.agent["agent_status"], self.screen = status, screen
            with self.subTest(i), self.assertRaisesRegex(bridge.BridgeError, "^没发出去：它正停在一个提问或选择框上"):
                self.prompt(IDS[i])
        self.assertEqual((self.prompts(), self.receipts()), ([], 0))
        # Answered on the computer, the input box is back: the same request id goes out.
        self.screen = "\n".join(["● Bash it is.", "", rule, "\x1b[39m❯ \x1b[7m \x1b[0m", rule, "  ⏸ manual mode on"])
        self.assertTrue(self.prompt(IDS[0])["sent"])
        # A numbered list the user sent earlier ("❯ 1. …" in the transcript) with the box below is no dialog.
        echo = "\n".join(["❯ 1. fix the parser", "  2. run the tests", "", "● Done.", "", rule, "\x1b[39m❯ \x1b[7m \x1b[0m", rule, "  ⏸ manual mode on"])
        self.screen = echo
        self.assertTrue(self.prompt(IDS[4])["sent"])
        self.assertEqual(len(self.prompts()), 2)

    def test_unknown_box_keeps_the_old_behaviour(self):
        # Unreadable screen, a Herdr without colours, no input box on screen: Herdr's state decides.
        self.screen, self.unreadable = CODEX["draft"], True
        self.assertTrue(self.prompt(IDS[0], "a")["sent"])
        self.unreadable = False
        self.screen = bridge.strip_sgr(CODEX["draft"])
        self.assertTrue(self.prompt(IDS[1], "b")["sent"])
        self.screen = "• 改完了。\n"
        self.assertTrue(self.prompt(IDS[2], "c")["sent"])
        self.assertEqual(len(self.prompts()), 3)
        # Other agents are not read at all.
        self.agent["agent"] = "pi"; self.commands.clear()
        self.assertTrue(self.prompt(IDS[3], "d")["sent"])
        self.assertFalse(any(c[1] == "read" for c in self.commands))

if __name__ == "__main__":
    unittest.main()
