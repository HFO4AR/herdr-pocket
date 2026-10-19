"""Terminal keys (key bar, modifiers, direct keyboard): one key name grammar, its xterm bytes and how
it reaches a Herdr pane (`pane send-keys` / `pane send-text`) and a tmux pane (`send-keys`). The table
in tests/fixtures/term_keys.json is shared with the phone (scripts/test_term2_ui.cjs) and was checked
live against Herdr 0.8.2 and tmux 3.7c (`od -c` in throwaway panes). Herdr and tmux are fakes here."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_bridge import bridge
import test_tmux
from contextlib import redirect_stdout
from io import StringIO

TABLE = json.loads((Path(__file__).parent / "fixtures/term_keys.json").read_text())["keys"]


class KeyTableTests(unittest.TestCase):
    def test_table_matches_the_bridge(self):
        self.assertGreater(len(TABLE), 400)
        for row in TABLE:
            key = row["key"]
            self.assertEqual(bridge.term_key_bytes(key), row["bytes"], key)
            self.assertEqual(bridge.term_key_bytes(key, app_cursor=True), row["app"], key)
            self.assertEqual(bridge.herdr_key_args(key), row["herdr"], key)
            self.assertEqual(bridge.tmux_key_args(key), row["tmux"], key)

    def test_grammar(self):
        for good in ("a", "|", "+", "ctrl++", "f12", "ctrl+alt+shift+left", "shift+tab", "alt+;", "pagedown"):
            self.assertIsNotNone(bridge.term_key(good), good)
        for bad in ("", "Ctrl+c", "shift+ctrl+a", "ctrl+ctrl+a", "meta+x", "f13", "C-c", "ctrl+unknown", "ab", "é",
                    "ctrl+", " ", "ctrl+ ", "\x1b", None, 5, ["a"]):
            self.assertIsNone(bridge.term_key(bad), bad)

    def test_xterm_encoding(self):
        b = bridge.term_key_bytes
        self.assertEqual((b("up"), b("up", True), b("shift+up"), b("ctrl+left"), b("ctrl+alt+shift+right")),
                         ("\x1b[A", "\x1bOA", "\x1b[1;2A", "\x1b[1;5D", "\x1b[1;8C"))
        self.assertEqual((b("home"), b("home", True), b("shift+end")), ("\x1b[H", "\x1bOH", "\x1b[1;2F"))
        self.assertEqual((b("pageup"), b("ctrl+pagedown"), b("delete"), b("shift+insert")), ("\x1b[5~", "\x1b[6;5~", "\x1b[3~", "\x1b[2;2~"))
        self.assertEqual((b("f1"), b("shift+f1"), b("f5"), b("ctrl+f12")), ("\x1bOP", "\x1b[1;2P", "\x1b[15~", "\x1b[24;5~"))
        self.assertEqual((b("shift+tab"), b("alt+tab"), b("ctrl+tab"), b("shift+enter"), b("alt+enter"), b("ctrl+esc")),
                         ("\x1b[Z", "\x1b\t", "\x1b[27;5;9~", "\x1b[27;2;13~", "\x1b\r", "\x1b[27;5;27~"))
        self.assertEqual((b("ctrl+c"), b("ctrl+shift+c"), b("alt+x"), b("ctrl+alt+x"), b("shift+a"), b("alt+shift+a")),
                         ("\x03", "\x03", "\x1bx", "\x1b\x18", "A", "\x1bA"))
        self.assertEqual((b("ctrl+space"), b("ctrl+@"), b("ctrl+["), b("ctrl+?"), b("ctrl+/"), b("ctrl+backspace"), b("alt+backspace")),
                         ("\x00", "\x00", "\x1b", "\x7f", "\x1f", "\x08", "\x1b\x7f"))
        # No such key code: refused, never sent as something else.
        for none in ("ctrl+1", "ctrl+|", "ctrl++", "ctrl+-", "alt+ctrl+;"):
            self.assertIsNone(b(none), none)

    def test_herdr_and_tmux_never_get_a_wrong_name(self):
        # Seen live: Herdr sends plain Tab for ctrl+tab and "?" for ctrl+?; tmux sends plain Enter for
        # S-Enter, plain Tab for S-Tab and types unknown names as text. Those go in as bytes instead.
        self.assertEqual(bridge.herdr_key_args("ctrl+tab"), ["send-text", "\x1b[27;5;9~"])
        self.assertEqual(bridge.herdr_key_args("ctrl+?"), ["send-text", "\x7f"])
        self.assertEqual(bridge.herdr_key_args("ctrl+shift+f3"), ["send-text", "\x1b[1;6R"])
        self.assertEqual(bridge.herdr_key_args("ctrl+@"), ["send-keys", "ctrl+space"])
        self.assertEqual(bridge.tmux_key_args("shift+enter"), ["-l", "--", "\x1b[27;2;13~"])
        self.assertEqual(bridge.tmux_key_args("shift+tab"), ["BTab"])
        self.assertEqual(bridge.tmux_key_args("ctrl+backspace"), ["C-h"])
        self.assertEqual(bridge.tmux_key_args("ctrl+shift+left"), ["C-S-Left"])
        self.assertEqual(bridge.tmux_key_args(";"), ["-l", "--", "\\;"], "a trailing ; would end the tmux command")
        self.assertEqual(bridge.tmux_key_args("alt+;"), ["-l", "--", "\x1b\\;"])
        for row in TABLE:
            for arg in row["herdr"] or []: self.assertNotIn("\x00", arg)
            for arg in row["tmux"] or []: self.assertNotIn("\x00", arg)
            if row["tmux"] and row["tmux"][0] != "-l": self.assertRegex(row["tmux"][0], r"^(C-)?(M-)?(S-)?[A-Za-z0-9@\[\\\]^_/?]+$")


class HerdrPaneKeyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.pane = {"pane_id": "w2:p7", "terminal_id": "shell-7", "tab_id": "w2:t1", "revision": 41}
        self.calls = []
        m = patch.object(bridge, "call", side_effect=self.call); m.start(); self.addCleanup(m.stop)
        self.n = 0

    def call(self, args):
        self.calls.append(args)
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if "get" in args: return {"pane": self.pane}
        if "read" in args: return {"text": "$ ls"}
        return {"type": "ok"}

    def key(self, key, **extra):
        self.n += 1
        req = dict(v=1, op="paneKey", session="default", target="w2:p7", identity=bridge.identity(self.pane), key=key,
                   id="%08d-1234-4234-8234-123456789012" % self.n, **extra)
        return bridge.handle(req, Path(self.tmp.name))

    def test_keys_go_out_as_names_or_bytes(self):
        self.key("ctrl+shift+left"); self.assertEqual(self.calls[-1], ["--session", "default", "pane", "send-keys", "w2:p7", "ctrl+shift+left"])
        self.key("pageup"); self.assertEqual(self.calls[-1], ["--session", "default", "pane", "send-text", "w2:p7", "\x1b[5~"])
        self.key("ctrl+r"); self.assertEqual(self.calls[-1], ["--session", "default", "pane", "send-text", "w2:p7", "\x12"])
        self.key("tab"); self.assertEqual(self.calls[-1][-1], "tab")
        self.key("ctrl+c"); self.assertEqual(self.calls[-1][-2:], ["w2:p7", "\x03"])

    def test_refused_keys_write_nothing(self):
        for bad in ("ctrl+1", "Ctrl+C", "ctrl+unknown", "meta+x"):
            before = len(self.calls)
            with self.assertRaises(bridge.BridgeError) as caught: self.key(bad)
            if bad == "ctrl+1": self.assertTrue(str(caught.exception).startswith("没发出去"))
            self.assertFalse(any(a[3:4] in (["send-keys"], ["send-text"]) for a in self.calls[before:]), bad)

    def test_read_skips_an_unchanged_pane(self):
        req = dict(v=1, op="paneRead", session="default", target="w2:p7", identity=bridge.identity(self.pane))
        first = bridge.handle(req)
        self.assertEqual((first["text"], first["revision"]), ("$ ls", 41))
        before = len(self.calls)
        self.assertEqual(bridge.handle(dict(req, revision=41)), {"same": True, "revision": 41})
        self.assertFalse(any("read" in a for a in self.calls[before:]), "no pane read for the same revision")
        self.pane["revision"] = 42
        self.assertEqual(bridge.handle(dict(req, revision=41))["text"], "$ ls")
        for odd in (True, "41", None):
            self.assertIn("text", bridge.handle(dict(req, revision=odd)))


class TmuxKeyTests(unittest.TestCase):
    # The fake tmux of test_tmux (borrowed, so its own tests do not run twice).
    T = test_tmux.TmuxTests
    setUp, save, calls, argvs, panes, pane, send = T.setUp, T.save, T.calls, T.argvs, T.panes, T.pane, T.send

    def test_keys_and_text(self):
        for i, (key, argv) in enumerate((("ctrl+shift+left", ["C-S-Left"]), ("pageup", ["PPage"]), ("shift+tab", ["BTab"]),
                                         ("ctrl+z", ["C-z"]), ("alt+x", ["M-x"]), ("f5", ["F5"]), ("|", ["-l", "--", "|"]),
                                         ("shift+enter", ["-l", "--", "\x1b[27;2;13~"]))):
            self.send(action="key", key=key, id="5234567%d-1234-4234-8234-123456789012" % i)
            self.assertEqual(self.argvs()[-1], ["-u", "send-keys", "-t", "%0", *argv], key)
        self.send(action="text", text="ls;", id="62345678-1234-4234-8234-123456789012")
        self.assertEqual(self.argvs()[-1][-1], "ls\\;", "a trailing ; is typed, not taken as a tmux separator")
        p = self.pane("%0")
        for bad in ("ctrl+1", "C-c", "ctrl+alt+@"):
            self.log.unlink(missing_ok=True)
            with self.assertRaises(bridge.BridgeError):
                bridge.handle(dict(v=1, op="tmuxSend", id="72345678-1234-4234-8234-123456789012", target="%0", identity=p["identity"], action="key", key=bad), self.receipts)
            self.assertFalse(any(a[1] == "send-keys" for a in self.argvs()), bad)

    def test_read_answers_same_for_the_same_screen(self):
        p = self.pane("%0")
        first = bridge.handle({"v": 1, "op": "tmuxRead", "target": "%0", "identity": p["identity"]})
        self.assertRegex(first["known"], r"^[0-9a-f]{16}$")
        again = bridge.handle({"v": 1, "op": "tmuxRead", "target": "%0", "identity": p["identity"], "known": first["known"]})
        self.assertEqual((again["same"], again["known"]), (True, first["known"]))
        self.assertNotIn("text", again)
        self.state["screen"] = "$ ls\nother\n"; self.save()
        self.assertEqual(bridge.handle({"v": 1, "op": "tmuxRead", "target": "%0", "identity": p["identity"], "known": first["known"]})["text"], "$ ls\nother")

    def test_live_attach_checks_the_pane_then_execs_tmux(self):
        p = self.pane("%0")
        with patch.object(bridge.os, "execve", side_effect=SystemExit(0)) as ex:
            with self.assertRaises(SystemExit): bridge.tmux_attach_main(["%0", p["identity"]])
            binary, argv, env = ex.call_args[0]
            self.assertEqual(argv[1:], ["-u", "attach-session", "-t", "$0"])
            self.assertNotIn("TMUX", env)
            with self.assertRaises(SystemExit): bridge.tmux_attach_main(["%0", p["identity"], "--read-only"])
            self.assertEqual(ex.call_args[0][1][1:], ["-u", "attach-session", "-r", "-t", "$0"])
        with patch.object(bridge.os, "execve") as ex, redirect_stdout(StringIO()) as out:
            for argv in (["%0", "0" * 64], ["%0;ls", p["identity"]], ["%0", p["identity"], "--rw"], ["%0"], []):
                with self.assertRaises(SystemExit) as caught: bridge.tmux_attach_main(argv)
                self.assertEqual(caught.exception.code, 2, argv)
            ex.assert_not_called()
        self.assertIn("没连上：", out.getvalue())


if __name__ == "__main__":
    unittest.main()
