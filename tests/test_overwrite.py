"""A message from the phone replaces whatever sits in a Claude / Codex input box and is only reported
sent once the box has emptied again (box_send). Herdr, ch relay panes and tmux are fakes around a box
that reacts like the real one (box_tui.BoxTui); no real Herdr, tmux or agent."""
import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_bridge import bridge
from box_tui import BoxTui
from test_tmux import row

IDS = ["%d2345678-1234-4234-8234-12345678901%d" % (i, i % 10) for i in range(1, 12)]
ROUTE = {"ssh": ["remote"], "workspace": "~/.local/share/ch/workspaces/x", "key": "k"}


class HerdrBoxTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name)
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term1", "agent": "claude", "agent_status": "idle"}
        self.tui, self.commands, self.relay, self.fail, self.blank = BoxTui(), [], False, {}, False
        self.probe = lambda *a: {"ok": True, "route": ROUTE, "native": False} if self.relay else {"ok": True, "route": None, "native": True}
        for target, name, fake in ((bridge, "call", self.call), (bridge, "probe_pane", self.probe), (bridge.time, "sleep", lambda s: None)):
            p = patch.object(target, name, side_effect=fake); p.start(); self.addCleanup(p.stop)

    def call(self, args):
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
        if args[:2] == ["--session", "default"]: args = args[2:]
        self.commands.append(args)
        failure = self.fail.get(tuple(args[:2]))
        if failure: raise failure
        if args[0] == "agent" and self.relay:
            raise bridge.HerdrRejected("agent_not_ready", "agent w1:p1 is no longer the pane foreground process")
        if args[1] == "read":
            if self.blank: raise bridge.BridgeError("read failed")
            return {"text": self.tui.ansi() if "ansi" in args else self.tui.screen()}
        if args[:2] == ["pane", "send-text"]:
            data = args[3]
            if data.startswith("\x1b[200~") and data.endswith("\x1b[201~"): self.tui.paste(data[6:-6])
            else: self.tui.type(data)
        elif args[1] == "send-keys":
            for key in args[3:]: self.tui.key(key)
        elif args[:2] == ["agent", "prompt"]:
            # Herdr: a paste, a short pause, Enter.
            self.tui.paste(args[3]); self.tui.key("enter")
        return {"type": "ok"}

    def send(self, request_id, text="Reply with just: OK", op="prompt"):
        req = {"v": 1, "op": op, "session": "default", "target": "w1:p1", "identity": bridge.identity(self.agent), "id": request_id}
        if op == "prompt": req["text"] = text
        return bridge.handle(req, self.state)

    def receipt(self, request_id):
        found = sqlite3.connect(self.state / "receipts.sqlite").execute("SELECT result FROM receipts WHERE id=?", (request_id,)).fetchone()
        return None if found is None or found[0] is None else json.loads(found[0])

    def writes(self): return [c for c in self.commands if c[1] != "read"]
    def enters(self): return sum(c[3:].count("enter") for c in self.commands if c[1] == "send-keys")

    def test_an_empty_box_gets_a_paste_then_enter_once_it_shows_it(self):
        result = self.send(IDS[0], "第一行\n第二行")
        self.assertEqual(self.tui.submitted, ["第一行\n第二行"])
        self.assertEqual((result["sent"], result["verified"], result["replaced"]), (True, True, False))
        self.assertEqual(self.writes(), [["pane", "send-text", "w1:p1", "\x1b[200~第一行\n第二行\x1b[201~"], ["pane", "send-keys", "w1:p1", "enter"]])
        self.assertEqual(self.receipt(IDS[0])["verified"], True)
        # The same id answers from its receipt: nothing typed again.
        self.assertEqual(self.send(IDS[0], "第一行\n第二行")["receipt"], IDS[0])
        self.assertEqual(len(self.tui.pastes), 1)

    def test_old_text_is_replaced_never_joined(self):
        drafts = [("Write a 30-line poem about terminals", None, None), ("one\ntwo\nthree", None, None),
                  ("one\ntwo\nthree\nfour", 0, 1), ("[Image #1]看这张图\n[图片]", None, None),
                  ("[Pasted text #1 +30 lines]", None, None), ("line\n\n\nmore", 1, 0)]
        for i, (draft, line, col) in enumerate(drafts):
            with self.subTest(draft):
                self.tui = BoxTui("claude", draft, line, col)
                result = self.send(IDS[i], "新的这条")
                self.assertEqual(self.tui.submitted, ["新的这条"])
                self.assertTrue(result["replaced"] and result["verified"])
                self.assertEqual(self.tui.pastes, ["新的这条"], "pasted once, after the box was empty")
                for key in self.tui.keys: self.assertIn(key, ("ctrl+e", "ctrl+u", "ctrl+k", "backspace", "enter"))

    def test_codex_composer_is_replaced(self):
        self.agent["agent"] = "codex"
        self.tui = BoxTui("codex", "leftover\ndraft text")
        result = self.send(IDS[0], "Reply with just: OK")
        self.assertEqual((self.tui.submitted, result["replaced"], result["verified"]), (["Reply with just: OK"], True, True))

    def test_a_box_that_will_not_clear_is_refused_without_typing(self):
        self.tui = BoxTui("claude", "keep me"); self.tui.frozen = True
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：它输入框里原来的字没能清干净"):
            self.send(IDS[0])
        self.assertEqual((self.tui.pastes, self.tui.submitted, self.enters()), ([], [], 0))
        self.assertEqual(self.receipt(IDS[0]), {"sent": False, "rejected": "draft"})

    def test_enter_waits_while_claude_shows_pasting(self):
        # Seen live: a ch-file://….png line makes Claude read the clipboard first; an Enter meanwhile is dropped.
        self.tui.hold = 4
        text = "看图\n\n[图片 · ch-local fetch] ch-file://%s.png" % ("a" * 64)
        result = self.send(IDS[0], text)
        self.assertEqual((self.tui.submitted, result["verified"]), ([text], True))
        self.assertEqual(self.enters(), 1, "Enter only once the text was in the box")

    def test_a_paste_that_never_lands_is_not_sent(self):
        self.tui.hold = None
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：粘贴以后它一直显示「Pasting…」"):
            self.send(IDS[0], "a\nb")
        self.assertEqual((self.enters(), self.tui.submitted), (0, []))
        self.assertEqual(self.receipt(IDS[0]), {"sent": False, "rejected": "late"})
        # Still pasting at the next try: refused before the receipt, nothing cleared or typed.
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：它还在处理上一次粘贴"):
            self.send(IDS[1], "c")
        self.assertIsNone(self.receipt(IDS[1]))
        self.assertEqual(len(self.tui.pastes), 1)
        # It landed meanwhile (the old text sits in the box, unsent): the next message replaces it.
        self.tui.hold = 0; self.tui.ansi()
        self.assertEqual(self.tui.text(), "a\nb")
        self.assertTrue(self.send(IDS[2], "c")["replaced"])
        self.assertEqual(self.tui.submitted, ["c"])

    def test_a_dropped_enter_is_pressed_once_more(self):
        self.tui.drop = 1
        result = self.send(IDS[0], "hello")
        self.assertEqual((self.tui.submitted, result["verified"], result.get("retried")), (["hello"], True, True))
        self.assertEqual((self.enters(), len(self.tui.pastes)), (2, 1))

    def test_enter_never_taken_is_reported_not_sent(self):
        self.tui.drop = 9
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：字进了它的输入框，可按了两次回车都没发出去"):
            self.send(IDS[0], "hello")
        self.assertEqual((self.enters(), len(self.tui.pastes), self.tui.text()), (2, 1, "hello"))
        self.assertEqual(self.receipt(IDS[0]), {"sent": False, "rejected": "enter"})

    def test_something_else_in_the_box_after_the_paste_gets_no_enter(self):
        real = self.tui.paste
        self.tui.paste = lambda text: real("someone typed " + text)
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：粘贴以后输入框里的字和这条对不上"):
            self.send(IDS[0], "hello")
        self.assertEqual(self.enters(), 0)

    def test_screen_lost_after_the_paste_falls_back_to_enter(self):
        real = self.tui.paste
        def paste(text): real(text); self.blank = True
        self.tui.paste = paste
        result = self.send(IDS[0], "hello")
        self.assertEqual((result["sent"], result["verified"], self.tui.submitted), (True, False, ["hello"]))

    def test_write_refused_before_enter_is_not_sent_but_enter_failing_is_unknown(self):
        self.fail[("pane", "send-text")] = bridge.HerdrRejected("pane_not_found", "gone")
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：这个窗格已经不在了"):
            self.send(IDS[0])
        self.assertEqual(self.receipt(IDS[0]), {"sent": False, "rejected": "pane_not_found"})
        self.fail = {("pane", "send-keys"): bridge.BridgeError("Herdr timeout; mutation outcome may be unknown. Do not resend blindly.")}
        with self.assertRaisesRegex(bridge.BridgeError, "Herdr timeout"):
            self.send(IDS[1])
        self.assertIsNone(self.receipt(IDS[1]))
        with self.assertRaisesRegex(bridge.BridgeError, "outcome is unknown"):
            self.send(IDS[1])

    def test_relay_pane_uses_the_same_checked_pane_input(self):
        self.relay = True
        self.tui = BoxTui("claude", "旧的草稿"); self.tui.hold = 2
        result = self.send(IDS[0], "只回一个字\n\n[图片 · ch-local fetch] ch-file://%s.png" % ("b" * 64))
        self.assertTrue(result["verified"] and result["replaced"])
        self.assertEqual(len(self.tui.submitted), 1)
        self.assertFalse(any(c[0] == "agent" and c[1] in ("prompt", "send-keys") for c in self.commands))

    def test_escape_never_reaches_the_paste(self):
        self.send(IDS[0], "a\x1b[201~\rb")
        self.assertEqual(self.tui.submitted, ["a[201~\nb"])

    def test_exit_command_goes_into_an_emptied_box(self):
        self.tui = BoxTui("claude", "draft")
        self.send(IDS[0], op="exitAgent")
        self.assertEqual(self.tui.submitted, ["/exit"])
        self.tui = BoxTui("claude", "draft"); self.tui.frozen = True
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：它输入框里原来的字没能清干净"):
            self.send(IDS[1], op="exitAgent")
        self.assertEqual(self.tui.submitted, [])


class BoxHoldsTests(unittest.TestCase):
    def test_what_counts_as_our_text(self):
        holds = bridge.box_holds
        self.assertTrue(holds("第一行\n  第二行", "第一行\n第二行"))
        self.assertTrue(holds("a long line that\nwrapped", "a long line that wrapped"))
        self.assertTrue(holds("[Image #1]看这张图\n[图片]", "看这张图\n[图片] /home/u/.herdr-pocket/uploads/d/x.png"))
        self.assertTrue(holds("[Pasted text #2 +30 lines]", "\n".join(map(str, range(30)))))
        self.assertTrue(holds("[Pasted Content 1501 chars]看", "x" * 1501 + "看"))
        self.assertFalse(holds("", "a"))
        self.assertFalse(holds("old draft hello", "hello"))
        self.assertFalse(holds("hel", "hello"))
        self.assertFalse(holds("[Image #1]别的字", "看这张图"))


class TmuxBoxTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        (self.home / "proj").mkdir()
        proj = self.proj = str(self.home / "proj")
        self.rows = [row("%1", win="1", name="claude", cmd="claude", path=proj, ppid="200", sid="$0")]
        env = {"PATH": str(self.home / "nothing"), "HOME": str(self.home)}
        p = patch.dict(os.environ, env, clear=True); p.start(); self.addCleanup(p.stop)
        h = patch.object(bridge.Path, "home", return_value=self.home); h.start(); self.addCleanup(h.stop)
        self.tui, self.log, self.buffers = BoxTui(), [], {}
        for name, value in (("tmux_binary", lambda: "/fake/tmux"), ("tmux_run", self.tmux), ("tmux_socket_dirs", lambda: [])):
            q = patch.object(bridge, name, side_effect=value); q.start(); self.addCleanup(q.stop)
        q = patch.object(bridge.time, "sleep", side_effect=lambda s: None); q.start(); self.addCleanup(q.stop)
        self.procs = {200: {"argv": ["-bash"], "children": [201], "paths": [], "cwd": proj, "start": "20", "active_threads": []},
                      201: {"argv": ["claude"], "children": [], "paths": [], "cwd": proj, "start": "21", "active_threads": []}}
        s = patch.object(bridge, "process_snapshot", side_effect=lambda pid: self.procs.get(pid)); s.start(); self.addCleanup(s.stop)
        c = patch.object(bridge, "transcript_catalog", return_value=[]); c.start(); self.addCleanup(c.stop)

    def tmux(self, args, timeout=6, data=None, sock=None):
        self.log.append(list(args))
        if args[0] == "list-panes": return "".join("\x1f".join(r) + "\n" for r in self.rows)
        if args[0] == "capture-pane": return (self.tui.ansi() if "-e" in args else self.tui.screen()) + "\n"
        if args[0] == "load-buffer": self.buffers[args[2]] = data; return ""
        if args[0] == "paste-buffer": self.tui.paste(self.buffers.pop(args[args.index("-b") + 1])); return ""
        if args[0] == "send-keys":
            if "-l" in args: self.tui.type(args[-1])
            else:
                for key in args[3:]: self.tui.key(key)
            return ""
        raise AssertionError(args)

    def prompt(self, request_id, text):
        a = next(p for p in bridge.handle({"v": 1, "op": "tmux"}, self.home)["panes"] if p["pane_id"] == "%1")["agent"]
        return bridge.handle({"v": 1, "op": "prompt", "target": "%1", "identity": a["identity"], "id": request_id, "text": text}, self.home / "state")

    def test_claude_draft_replaced_and_checked(self):
        self.tui = BoxTui("claude", "interrupted prompt\nsecond line", 0, 3)
        result = self.prompt(IDS[0], "新消息")
        self.assertEqual((self.tui.submitted, result["replaced"], result["verified"]), (["新消息"], True, True))
        self.assertIn(["paste-buffer", "-p", "-d", "-b", "herdr-pocket-" + IDS[0][:8], "-t", "%1"], self.log)
        keys = [a for a in self.log if a[0] == "send-keys"]
        self.assertEqual(keys[-1], ["send-keys", "-t", "%1", "Enter"])
        self.assertTrue(set(k for a in keys[:-1] for k in a[3:]) <= {"C-e", "C-u", "C-k", "BSpace"})

    def test_codex_and_a_dropped_enter(self):
        self.procs[201]["argv"] = ["codex"]
        self.rows[0] = row("%1", win="1", name="codex", cmd="codex", path=self.proj, ppid="200", sid="$0")
        self.tui = BoxTui("codex", "hello draft text"); self.tui.drop = 1
        result = self.prompt(IDS[1], "Reply with just: OK")
        self.assertEqual((self.tui.submitted, result.get("retried")), (["Reply with just: OK"], True))

    def test_unsent_is_recorded_in_the_same_receipt(self):
        self.tui.drop = 9
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：字进了它的输入框"):
            self.prompt(IDS[2], "hi")
        self.assertEqual(self.prompt(IDS[2], "hi"), {"sent": False, "rejected": "enter"}, "answered from the receipt, not typed again")
        self.assertEqual(len(self.tui.pastes), 1)


if __name__ == "__main__":
    unittest.main()
