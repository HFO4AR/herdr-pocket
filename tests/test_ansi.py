"""Colored screens (`read` with `ansi: true`). Fixtures in tests/fixtures/*.ansi follow the rows that
Herdr 0.8.2 `agent read --format ansi` returns for Claude Code (256 colors) and Codex (truecolor,
rows padded to the pane width, CRLF line ends); their text is made up."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parents[1] / "bridge/pocket_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

FIX = Path(__file__).parent / "fixtures"


def fixture(name):
    return (FIX / name).read_bytes().decode()


def plain(raw):
    """What `--format text` prints for the same visible screen: no SGR, rows right-trimmed."""
    rows = [r.rstrip() for r in bridge.strip_sgr(bridge.clean_ansi(raw)).split("\n")]
    while rows and not rows[-1]: rows.pop()
    return "\n".join(rows) + "\n"


class CleanTests(unittest.TestCase):
    def test_only_sgr_survives(self):
        raw = "a\x1b]0;title\x07b\x1b]8;;http://x\x1b\\c\x1b[2J\x1b[?25l\x1b[3;4Hd\x1b[38;2;1;2;3m\x1b[1me\x1b(B\x07\x00f\x9bg\x1bPq#0\x1b\\h\r\n"
        self.assertEqual(bridge.clean_ansi(raw), "abcd\x1b[38;2;1;2;3m\x1b[1mefgh\n")

    def test_crlf_and_tabs(self):
        self.assertEqual(bridge.clean_ansi("x\r\n\ty\rz"), "x\n\ty\nz")

    def test_fixtures_strip_to_the_text_read(self):
        for name in ("claude_screen.ansi", "codex_screen.ansi", "claude_blocked.ansi", "codex_blocked.ansi"):
            cleaned = bridge.clean_ansi(fixture(name))
            self.assertNotIn("\r", cleaned)
            self.assertIn("\x1b[", cleaned)
            self.assertNotRegex(bridge.strip_sgr(cleaned), "\x1b")


class MenuParity(unittest.TestCase):
    """Menus and modes keep parsing the plain read; the stripped colored screen parses the same."""
    def test_menus_parse_the_same_from_the_stripped_screen(self):
        for name, provider in (("claude_blocked.ansi", "claude"), ("codex_blocked.ansi", "codex")):
            stripped = bridge.strip_sgr(bridge.clean_ansi(fixture(name)))
            text = plain(fixture(name))
            menu = bridge.parse_menu(text, provider)
            self.assertIsNotNone(menu)
            self.assertEqual(bridge.parse_menu(stripped, provider), menu)

    def test_modes_parse_the_same(self):
        stripped = bridge.strip_sgr(bridge.clean_ansi(fixture("claude_screen.ansi")))
        self.assertEqual(bridge.screen_modes(stripped, "claude"), bridge.screen_modes(plain(fixture("claude_screen.ansi")), "claude"))


class ScrollbackTests(unittest.TestCase):
    def test_plain_history_goes_above_the_colored_screen(self):
        screen = bridge.clean_ansi(fixture("claude_screen.ansi"))
        merged = bridge.ansi_with_scrollback((FIX / "claude_recent.txt").read_text(), screen)
        rows = merged.split("\n")
        self.assertEqual(rows[0], "❯ 列表页的轮询太频繁了，手机耗电明显，帮我看看")
        self.assertTrue(merged.endswith(screen.rstrip("\n").rstrip()) or merged.endswith(screen.rstrip("\n")))
        # The screen's own text is not repeated in the history part.
        self.assertEqual(bridge.strip_sgr(merged).count("我把轮询改成了按状态分档"), 1)

    def test_wrapped_rows_match_their_unwrapped_line_and_keep_a_partial_head(self):
        long = "这是一行很长的输出 " * 12
        text = "older\n" + long + "\nlast line\n"
        # The screen shows the long line wrapped in two rows, and only its second row.
        cut = len(long) // 2
        screen = "\x1b[2m" + long[cut:] + "\x1b[0m\nlast line\n"
        merged = bridge.ansi_with_scrollback(text, screen)
        self.assertEqual(merged.split("\n")[:2], ["older", long[:cut]])
        self.assertEqual(bridge.strip_sgr(merged).replace("\n", ""), "older" + long + "last line")

    def test_no_match_keeps_the_screen_alone(self):
        self.assertEqual(bridge.ansi_with_scrollback("something else\n", "\x1b[1mfull screen app\x1b[0m\n\n"), "\x1b[1mfull screen app\x1b[0m")


class ReadOp(unittest.TestCase):
    def setUp(self):
        self.agent = {"pane_id": "w1:p1", "terminal_id": "t1", "agent": "claude", "agent_status": "done"}
        self.commands = []
        self.screen = fixture("claude_screen.ansi")

    def fake(self, args):
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
        if args[:2] == ["--session", "default"]: args = args[2:]
        self.commands.append(args)
        if "--format" in args: return {"text": self.screen}
        return {"text": (FIX / "claude_recent.txt").read_text()}

    def read(self, **extra):
        with patch.object(bridge, "call", side_effect=self.fake):
            return bridge.handle({"v": 1, "op": "read", "session": "default", "target": "w1:p1",
                                  "identity": bridge.identity(self.agent), **extra})

    def test_plain_read_is_unchanged(self):
        r = self.read()
        self.assertNotIn("ansi", r)
        self.assertEqual(self.commands, [["agent", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "160"]])

    def test_ansi_read_adds_the_colored_screen_and_keeps_text(self):
        r = self.read(ansi=True)
        self.assertEqual(r["text"], (FIX / "claude_recent.txt").read_text())
        self.assertIn("\x1b[38;5;114m", r["ansi"])
        self.assertNotIn("\r", r["ansi"])
        self.assertEqual(self.commands[-1], ["agent", "read", "w1:p1", "--source", "visible", "--format", "ansi"])
        self.assertIn("modes", r)

    def test_old_herdr_without_ansi_falls_back_to_plain(self):
        def old(args):
            if "--format" in args: raise bridge.BridgeError("error: unexpected argument '--format' found")
            return self.fake(args)
        with patch.object(bridge, "call", side_effect=old):
            r = bridge.handle({"v": 1, "op": "read", "session": "default", "target": "w1:p1",
                               "identity": bridge.identity(self.agent), "ansi": True})
        self.assertNotIn("ansi", r)
        self.assertTrue(r["text"])

    def test_oversized_screen_is_dropped(self):
        self.screen = "\x1b[1m" + "x" * (bridge.ANSI_LIMIT + 10)
        self.assertNotIn("ansi", self.read(ansi=True))

    def test_relay_pane_reads_color_at_the_pane_level(self):
        def relay(args):
            if args[:1] == ["--session"] and args[2] == "agent" and args[3] == "read":
                raise bridge.HerdrRejected("agent_not_ready", "agent w1:p1 is no longer the pane foreground process")
            return self.fake(args)
        with patch.object(bridge, "call", side_effect=relay), patch.object(bridge, "relay_pane", return_value=True):
            r = bridge.handle({"v": 1, "op": "read", "session": "default", "target": "w1:p1",
                               "identity": bridge.identity(self.agent), "ansi": True})
        self.assertIn("ansi", r)
        self.assertEqual(self.commands[-1], ["pane", "read", "w1:p1", "--source", "visible", "--format", "ansi"])


if __name__ == "__main__":
    unittest.main()
