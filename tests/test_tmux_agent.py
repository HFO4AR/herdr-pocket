"""A Claude / Codex in a tmux pane behaves like one in Herdr: question cards answered with tmux
keys, the send queue's status reads, pictures and files, Shift+Tab, Esc and the background
watcher's status. tmux is a fake inside this process (tmux_run is replaced): it keeps one small
TUI per pane that reacts to send-keys the way the real screen does. No real tmux, Herdr or agent."""
import hashlib
import json
import os
import re
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from test_bridge import bridge
from test_answer import CLAUDE_MULTI_CHAT, RULE
from test_tmux import row

CODEX = json.loads((Path(__file__).parent / "fixtures/codex_tmux.json").read_text(encoding="utf-8"))
UUIDS = ["%d2345678-1234-4234-8234-123456789012" % i for i in range(1, 10)]
CLAUDE_IDLE = "\n".join(["● 好了。", "", RULE, "❯ ", RULE, "  ⏵⏵ accept edits on (shift+tab to cycle)"])
CLAUDE_BUSY = "\n".join(["✻ Pondering… (12s · esc to interrupt)", "", RULE, "❯ ", RULE, "  ⏵⏵ accept edits on (shift+tab to cycle)"])
CLAUDE_APPROVE = "\n".join([RULE, " Bash command", "", "   rm -rf build", "", " Do you want to proceed?", "❯ 1. Yes",
                            "  2. No, and tell Claude what to do differently (esc)", "", "Esc to cancel · Tab to amend"])


class MultiChatTui:
    """The real captured Claude multi-select screen (test_answer.CLAUDE_MULTI_CHAT), redrawn for the
    cursor, the checked rows and what was typed into the "Type something" row, with Claude's keys:
    ↓/↑ move (rows 1–4, Submit, then the "Chat about this" row), Enter toggles a row or submits,
    typing into row 4 replaces its label and checks it."""
    ROW = re.compile(r"^(?:❯ |  )(\d)\. (\[ \] )?(.*)$")
    ORDER = [1, 2, 3, 4, "submit", 5]

    def __init__(self):
        self.cursor, self.checked, self.typed, self.submitted, self.cancelled, self.stuck = 1, set(), "", None, False, False

    def screen(self):
        out = []
        for line in CLAUDE_MULTI_CHAT.split("\n"):
            m = self.ROW.match(line)
            if m:
                n, ptr = int(m[1]), "❯ " if self.cursor == int(m[1]) else "  "
                if m[2]:
                    label = self.typed if n == 4 and self.typed else m[3]
                    line = "%s%d. [%s] %s" % (ptr, n, "✔" if n in self.checked else " ", label)
                else: line = "%s%d. %s" % (ptr, n, m[3])
            elif line.strip() == "Submit": line = ("❯" if self.cursor == "submit" else " ") + "    Submit"
            out.append(line)
        return "\n".join(out)

    def key(self, name):
        if self.stuck: return
        at = self.ORDER.index(self.cursor)
        if name == "Down": self.cursor = self.ORDER[min(at + 1, len(self.ORDER) - 1)]
        elif name == "Up": self.cursor = self.ORDER[max(at - 1, 0)]
        elif name == "Enter":
            if self.cursor == "submit": self.submitted = sorted(self.checked)
            elif self.cursor == 5: self.submitted = "chat"
            else: self.checked ^= {self.cursor}
        elif name == "Escape": self.cancelled = True

    def text(self, value):
        if self.cursor == 4: self.typed += value; self.checked.add(4)


class Static:
    def __init__(self, text): self.text_ = text
    def screen(self): return self.text_
    def key(self, name): pass
    def text(self, value): pass


class TmuxAgentTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        (self.home / "proj").mkdir()
        self.proj = str(self.home / "proj")
        self.state = self.home / "state"
        self.rows = [row("%0", path=self.proj, sid="$0"),
                     row("%1", win="1", name="claude", cmd="claude", path=self.proj, ppid="200", title="✳ Fix the parser", sid="$0")]
        self.tuis = {"%0": Static("$ "), "%1": Static(CLAUDE_IDLE)}
        self.log = []
        env = {"PATH": str(self.home / "nothing"), "HOME": str(self.home)}
        p = patch.dict(os.environ, env, clear=True); p.start(); self.addCleanup(p.stop)
        h = patch.object(bridge.Path, "home", return_value=self.home); h.start(); self.addCleanup(h.stop)
        # Only the default server: this machine's own tmux sockets are never looked at.
        for name, value in (("tmux_binary", lambda: "/fake/tmux"), ("tmux_run", self.tmux), ("tmux_socket_dirs", lambda: [])):
            q = patch.object(bridge, name, side_effect=value); q.start(); self.addCleanup(q.stop)
        for name, value in (("ANSWER_PAUSE", 0), ("ANSWER_PATIENCE", 0.05)):
            q = patch.object(bridge, name, value); q.start(); self.addCleanup(q.stop)
        self.procs = {
            100: {"argv": ["-bash"], "children": [], "paths": [], "cwd": self.proj, "start": "10", "active_threads": []},
            200: {"argv": ["-bash"], "children": [201], "paths": [], "cwd": self.proj, "start": "20", "active_threads": []},
            201: {"argv": ["node", "/usr/lib/node_modules/.bin/claude"], "children": [], "paths": [], "cwd": self.proj, "start": "21", "active_threads": []}}
        s = patch.object(bridge, "process_snapshot", side_effect=lambda pid: self.procs.get(pid)); s.start(); self.addCleanup(s.stop)
        c = patch.object(bridge, "transcript_catalog", return_value=[]); c.start(); self.addCleanup(c.stop)

    def tmux(self, args, timeout=6, data=None, sock=None):
        """list-panes, capture-pane and send-keys against the per-pane TUIs."""
        self.log.append(list(args))
        cmd = args[0]
        if cmd == "list-panes": return "".join("\x1f".join(r) + "\n" for r in self.rows)
        target = args[args.index("-t") + 1] if "-t" in args else None
        if cmd == "capture-pane":
            # -e: with colours, for screens captured with them (Codex fixtures); plain otherwise.
            tui = self.tuis[target]
            return (tui.ansi() if "-e" in args and hasattr(tui, "ansi") else tui.screen()) + "\n"
        if cmd == "send-keys":
            tui = self.tuis[target]
            if "-l" in args: tui.text(args[-1])
            else: tui.key(args[-1])
            return ""
        if cmd in ("load-buffer", "paste-buffer", "delete-buffer"): return ""
        raise AssertionError(args)

    def h(self, **req): return bridge.handle(dict(v=1, **req), self.state)
    def agent(self): return next(p for p in self.h(op="tmux")["panes"] if p["pane_id"] == "%1")["agent"]
    def sent(self): return [a for a in self.log if a[0] in ("send-keys", "paste-buffer")]
    def keys(self): return [a[-1] for a in self.sent() if a[0] == "send-keys" and "-l" not in a]

    # ── Question cards ──
    def answer(self, request_id, **extra):
        a = self.agent()
        menu = self.h(op="read", target="%1", identity=a["identity"])["menu"]
        return self.h(op="answer", target="%1", identity=a["identity"], id=request_id, fingerprint=menu["fingerprint"], **extra)

    def test_read_carries_the_agents_status_line(self):
        # The phone's activity line: the agent's own words and clock, only while it works.
        self.tuis["%1"] = Static(CLAUDE_BUSY)
        a = self.agent()
        read = self.h(op="read", target="%1", identity=a["identity"])
        self.assertEqual((read["agent_status"], read["activity"]["verb"], read["activity"]["seconds"]), ("working", "Pondering", 12))
        self.tuis["%1"] = Static(CLAUDE_IDLE)
        self.assertNotIn("activity", self.h(op="read", target="%1", identity=a["identity"]))

    def test_read_carries_the_menu_while_it_waits(self):
        self.tuis["%1"] = MultiChatTui()
        a = self.agent()
        self.assertEqual(a["agent_status"], "blocked")
        read = self.h(op="read", target="%1", identity=a["identity"])
        menu = read["menu"]
        self.assertEqual((read["agent_status"], menu["multi"], menu["submit"], menu["cursor"]), ("blocked", True, "Submit", 1))
        self.assertEqual([o["label"] for o in menu["options"]][:3], ["选项一", "选项二", "选项三"])
        self.assertTrue(menu["options"][3]["input"]); self.assertTrue(menu["options"][4]["chat"])
        # Idle: no menu unless asked for one (after a slash command).
        self.tuis["%1"] = Static(CLAUDE_IDLE)
        self.assertNotIn("menu", self.h(op="read", target="%1", identity=a["identity"]))

    def test_multi_select_on_the_real_claude_screen(self):
        tui = self.tuis["%1"] = MultiChatTui()
        result = self.answer(UUIDS[0], action="multi", options=[1, 3], labels={"1": "选项一", "3": "选项三"})
        self.assertEqual(self.keys(), ["Enter", "Down", "Down", "Enter", "Down", "Down", "Enter"])
        self.assertEqual(tui.submitted, [1, 3])
        self.assertEqual((result["sent"], result["result"]["options"]), (True, [1, 3]))
        # The same request id never presses anything again.
        self.log.clear()
        self.assertEqual(self.h(op="answer", target="%1", identity=self.agent()["identity"], id=UUIDS[0], action="multi",
                                options=[1, 3], labels={"1": "选项一", "3": "选项三"}, fingerprint=bridge.parse_menu(tui.screen(), "claude")["fingerprint"])
                         .get("receipt"), UUIDS[0])
        self.assertEqual(self.sent(), [])

    def test_free_text_row_is_typed_literally_and_checked_before_submit(self):
        tui = self.tuis["%1"] = MultiChatTui()
        self.answer(UUIDS[1], action="multi", options=[2], option=4, text="全都不要 $(rm -rf ~)")
        typed = [a for a in self.sent() if "-l" in a]
        self.assertEqual(typed, [["send-keys", "-t", "%1", "-l", "--", "全都不要 $(rm -rf ~)"]])
        self.assertEqual(tui.submitted, [2, 4])
        self.assertEqual(self.keys()[-1], "Enter")

    def test_cursor_that_does_not_move_never_gets_enter(self):
        tui = self.tuis["%1"] = MultiChatTui()
        tui.stuck = True
        with self.assertRaisesRegex(bridge.BridgeError, "光标没有移动"):
            self.answer(UUIDS[2], action="multi", options=[3])
        self.assertEqual(self.keys(), ["Down"])
        # The outcome is unknown now: the same id is never run again.
        self.log.clear()
        with self.assertRaisesRegex(bridge.BridgeError, "结果未知"):
            self.answer(UUIDS[2], action="multi", options=[3])
        self.assertEqual(self.sent(), [])

    def test_changed_menu_or_no_menu_is_refused_before_any_key(self):
        self.tuis["%1"] = MultiChatTui()
        a = self.agent()
        with self.assertRaisesRegex(bridge.BridgeError, "选项已经变了"):
            self.h(op="answer", target="%1", identity=a["identity"], id=UUIDS[3], fingerprint="0" * 20, action="select", option=1)
        self.tuis["%1"] = Static(CLAUDE_IDLE)
        with self.assertRaisesRegex(bridge.BridgeError, "not waiting"):
            self.h(op="answer", target="%1", identity=a["identity"], id=UUIDS[4], fingerprint="0" * 20, action="select", option=1)
        with self.assertRaisesRegex(bridge.BridgeError, "回答文字"):
            self.h(op="answer", target="%1", identity=a["identity"], id=UUIDS[5], fingerprint="0" * 20, action="text", option=4, text="a\nb")
        self.assertEqual(self.sent(), [])

    def test_approval_select_and_esc(self):
        self.tuis["%1"] = Static(CLAUDE_APPROVE)
        a = self.agent()
        menu = self.h(op="read", target="%1", identity=a["identity"])["menu"]
        self.assertEqual((menu["kind"], menu["esc"]["option"]), ("approval", 2))
        # Shift+Tab on a permission dialog would mean "don't ask again": refused.
        with self.assertRaisesRegex(bridge.BridgeError, "没发出去"):
            self.h(op="key", target="%1", identity=a["identity"], id=UUIDS[6], key="shift+tab")
        self.h(op="key", target="%1", identity=a["identity"], id=UUIDS[7], key="esc")
        self.assertEqual(self.keys(), ["Escape"])

    def test_claude_spinner_without_esc_hint_is_working(self):
        # Captured from Claude Code 2.1.268 in tmux: no "esc to interrupt" anywhere while it works.
        foot = ["❯ ", "  /tmp/x [.venv] model 98% left", "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"]
        for spinner in ("✽ Ionizing…", "* Ionizing…", "· Ionizing… (4s · ↓ 28 tokens · thinking)", "✻ Puttering… (6s · ↓ 140 tokens)"):
            screen = "\n".join([spinner, "  ⎿  Tip: Ask Claude to create a todo list", RULE] + foot[:1] + [RULE] + foot[1:])
            self.assertEqual(bridge.tmux_screen_state(screen, "claude"), "working", spinner)
        done = "\n".join(["  20. Your processes live on.", "✻ Crunched for 7s · done 17:51", RULE] + foot[:1] + [RULE] + foot[1:])
        self.assertEqual(bridge.tmux_screen_state(done, "claude"), "idle")
        self.assertEqual(bridge.tmux_screen_state("• Working (3s • esc to interrupt)\n› \n", "codex"), "working")

    def streaming(self, *after):
        # Captured from Claude Code 2.1.268: while the reply's text streams there is no spinner at all.
        return "\n".join(["❯ Write a 40-line poem about pipes, one line per number.", "", "● 1. Pipes connect", "  2. One to the next",
                          *after, RULE, "❯ ", RULE, "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"])

    def test_claude_streaming_reply_counts_as_working(self):
        a = self.agent()
        transcript = self.home / ".claude/projects/-proj/T1.jsonl"; transcript.parent.mkdir(parents=True)
        self.procs[201]["paths"] = [transcript]
        rows = [{"type": "user", "message": {"role": "user", "content": "earlier"}}, {"type": "system", "subtype": "turn_duration"},
                {"type": "user", "message": {"role": "user", "content": "Write a 40-line poem about pipes"}},
                {"type": "assistant", "message": {"content": [{"type": "text", "text": "1."}]}}]
        transcript.write_text("".join(json.dumps(r) + "\n" for r in rows))
        self.tuis["%1"] = Static(self.streaming("  3."))
        self.assertEqual(self.agent()["agent_status"], "working")
        with self.assertRaisesRegex(bridge.BridgeError, "^Agent is busy"):
            self.h(op="prompt", target="%1", identity=a["identity"], id=UUIDS[0], text="next")
        # The end line, or an interrupt, closes the turn on screen.
        for end in ("✻ Churned for 4s · done 17:54", "  ⎿  Interrupted · What should Claude do instead?"):
            self.tuis["%1"] = Static(self.streaming("  3. Done.", end))
            self.assertEqual(self.agent()["agent_status"], "idle", end)
        # No end line on screen (a resumed conversation), but the transcript says the turn ended.
        transcript.write_text("".join(json.dumps(r) + "\n" for r in rows[:2] + rows[2:] + [{"type": "system", "subtype": "turn_duration"}]))
        self.tuis["%1"] = Static(self.streaming("  3. Done."))
        self.assertEqual(self.agent()["agent_status"], "idle")
        # No transcript to ask: an open prompt stays working, nothing is typed into it.
        self.procs[201]["paths"] = []
        self.assertEqual(self.agent()["agent_status"], "working")
        # A local command never prints an end line.
        self.tuis["%1"] = Static("\n".join(["❯ /model", "  ⎿  Set model to opus", "", RULE, "❯ ", RULE, "  ⏸ manual mode on"]))
        self.assertEqual(self.agent()["agent_status"], "idle")
        self.assertEqual(self.sent(), [])

    def test_text_left_in_claudes_input_box_is_never_joined(self):
        # Esc early in a turn puts the prompt back into Claude's box (seen live): a new message would join it.
        a = self.agent()
        box = "\n".join(["● 好了。", "", RULE, "❯\u00a0Write a 30-line poem about terminals", RULE, "  ⏵⏵ accept edits on (shift+tab to cycle)"])
        self.tuis["%1"] = Static(box)
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：它的输入框里已经有字"):
            self.h(op="prompt", target="%1", identity=a["identity"], id=UUIDS[0], text="Reply with just: NOW-OK")
        self.assertEqual(self.sent(), [])
        # Captured with colours: an empty box, a draft, and a dim suggestion after the cursor.
        empty = "\x1b[39m❯\u00a0\x1b[7m \x1b[0m"
        draft = "\x1b[39m❯\u00a0draft text here\x1b[7m \x1b[0m"
        hint = "\x1b[39m❯\u00a0\x1b[7mT\x1b[0m\x1b[2mry \"fix lint errors\"\x1b[0m"
        for colored, want in ((empty, ""), (draft, "draft text here"), (hint, "")):
            plain = bridge.strip_sgr(colored)
            self.assertEqual(bridge.claude_draft("\n".join([RULE, plain, RULE]), "\n".join([RULE, colored, RULE])), want, colored)
        self.assertIsNone(bridge.claude_draft("no box here", "no box here"))

    # ── Prompts, the queue's status reads ──
    def test_prompt_only_when_idle_and_status_reads(self):
        a = self.agent()
        self.tuis["%1"] = Static(CLAUDE_BUSY)
        status = self.h(op="status", target="%1", identity=a["identity"])
        self.assertEqual((status["tmux"], status["agents"][0]["agent_status"], status["agents"][0]["identity"]), (True, "working", a["identity"]))
        self.assertNotIn("history_ref", status["agents"][0])
        with self.assertRaisesRegex(bridge.BridgeError, "^Agent is busy"):
            self.h(op="prompt", target="%1", identity=a["identity"], id=UUIDS[0], text="next")
        self.tuis["%1"] = Static(CLAUDE_APPROVE)
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去"):
            self.h(op="prompt", target="%1", identity=a["identity"], id=UUIDS[1], text="next")
        self.assertEqual(self.sent(), [])
        self.tuis["%1"] = Static(CLAUDE_IDLE)
        self.assertEqual(self.h(op="prompt", target="%1", identity=a["identity"], id=UUIDS[2], text="next"), {"sent": True, "receipt": UUIDS[2]})
        self.assertEqual(self.sent()[-2:], [["send-keys", "-t", "%1", "-l", "--", "next"], ["send-keys", "-t", "%1", "Enter"]])
        # Gone pane: an empty status, no error.
        self.rows = self.rows[:1]
        self.assertEqual(self.h(op="status", target="%1", identity=a["identity"])["agents"], [])

    def test_watcher_status_lists_tmux_agents_without_herdr(self):
        self.tuis["%1"] = Static(CLAUDE_BUSY)
        r = self.h(op="status", session="", tmux=True)
        self.assertEqual([(x["pane_id"], x["agent"], x["agent_status"], x["tmux"]) for x in r["agents"]], [("%1", "claude", "working", True)])
        # A named Herdr session on a computer without Herdr: still the tmux agents.
        self.assertEqual(len(self.h(op="status", session="default", tmux=True)["agents"]), 1)
        self.assertFalse(any(a[0] == "send-keys" for a in self.log), "reads only")

    def test_shift_tab_only_with_the_footer_on_screen(self):
        a = self.agent()
        self.tuis["%1"] = Static("● 好了。\n")
        with self.assertRaisesRegex(bridge.BridgeError, "没看到它的输入框"):
            self.h(op="key", target="%1", identity=a["identity"], id=UUIDS[0], key="shift+tab")
        self.tuis["%1"] = Static(CLAUDE_IDLE)
        self.h(op="key", target="%1", identity=a["identity"], id=UUIDS[1], key="shift+tab")
        self.assertEqual(self.keys(), ["BTab"])

    # ── Pictures and files: local paths, checked before anything is typed ──
    def upload_image(self, data):
        sha = hashlib.sha256(data).hexdigest()
        day = time.strftime("%Y-%m-%d", time.gmtime())
        folder = self.home / ".herdr-pocket/uploads" / day; folder.mkdir(parents=True, exist_ok=True)
        (folder / (sha + ".png")).write_bytes(data)
        return {"name": day + "/" + sha + ".png", "sha256": sha}, folder / (sha + ".png")

    def upload_file(self, name, data):
        sha = hashlib.sha256(data).hexdigest()
        day = time.strftime("%Y-%m-%d", time.gmtime())
        folder = self.home / ".herdr-pocket/uploads" / day / sha[:16]; folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(data)
        return {"name": day + "/" + sha[:16] + "/" + name, "sha256": sha}, folder / name

    def test_pictures_and_files_by_local_path(self):
        a = self.agent()
        image, image_path = self.upload_image(b"\x89PNG fake")
        doc, doc_path = self.upload_file("说明.pdf", b"%PDF-1.4 fake")
        self.assertEqual(self.h(op="stageFile", target="%1", identity=a["identity"], **doc), {"remote": False, "path": str(doc_path)})
        r = self.h(op="prompt", target="%1", identity=a["identity"], id=UUIDS[0], text="看看这个", images=[image], files=[doc])
        expected = "看看这个\n\n[图片] %s\n[文件] %s" % (image_path, doc_path)
        self.assertEqual((r["sent"], r["text"]), (True, expected))
        # Several lines: one paste, then Enter.
        self.assertEqual([x[0] for x in self.sent()], ["paste-buffer", "send-keys"])
        load = next(x for x in self.log if x[0] == "load-buffer")
        self.assertEqual(load[:2], ["load-buffer", "-b"])

    def test_bad_uploads_send_nothing(self):
        a = self.agent()
        image, image_path = self.upload_image(b"\x89PNG fake")
        doc, doc_path = self.upload_file("a.txt", b"hello")
        image_path.write_bytes(b"changed")
        cases = [(dict(images=[image]), "不一致"), (dict(images=[dict(image, name="2026-01-01/" + "a" * 64 + ".png", sha256="a" * 64)]), "还没传到"),
                 (dict(files=[dict(doc, sha256=doc["sha256"][:16] + "0" * 48)]), "不一致"), (dict(files=[doc], remote=True), "没发出去"),
                 (dict(images=[]), "最多带 4 张")]
        for i, (extra, msg) in enumerate(cases):
            with self.subTest(extra=extra), self.assertRaisesRegex(bridge.BridgeError, msg):
                self.h(op="prompt", target="%1", identity=a["identity"], id=UUIDS[i], text="x", **extra)
        doc_path.unlink()
        with self.assertRaisesRegex(bridge.BridgeError, "没发出去"):
            self.h(op="stageFile", target="%1", identity=a["identity"], **doc)
        self.assertEqual(self.sent(), [])
        self.assertFalse(any(x[0] == "load-buffer" for x in self.log))


class CodexScreen:
    """One real captured Codex 0.163 screen (fixtures/codex_tmux.json); a plain capture drops its colours."""
    def __init__(self, name): self.raw, self.got = CODEX[name], []
    def ansi(self): return self.raw
    def screen(self): return bridge.strip_sgr(self.raw)
    def key(self, name): self.got.append(name)
    def text(self, value): self.got.append(("text", value))


class CodexPicker:
    """A real captured Codex picker (approval, request_user_input question, model switch) redrawn for
    its cursor: ↓/↑ move the "›", Enter picks the row, Esc cancels; then the screen is `after`."""
    ROW = re.compile(r"^(\s*)(› |  )(\d\. .*)$")

    def __init__(self, name, after="idle"):
        self.lines = bridge.strip_sgr(CODEX[name]).split("\n")
        self.rows = [i for i, x in enumerate(self.lines) if self.ROW.match(x)]
        self.cursor, self.picked, self.after, self.typed = 1, None, after, []

    def screen(self):
        if self.picked is not None: return bridge.strip_sgr(CODEX[self.after])
        out = list(self.lines)
        for n, i in enumerate(self.rows, 1):
            m = self.ROW.match(out[i])
            out[i] = m[1] + ("› " if n == self.cursor else "  ") + m[3]
        return "\n".join(out)

    def key(self, name):
        if name == "Down": self.cursor = min(self.cursor + 1, len(self.rows))
        elif name == "Up": self.cursor = max(self.cursor - 1, 1)
        elif name == "Enter": self.picked = self.cursor
        elif name == "Escape": self.picked = "esc"

    def text(self, value): self.typed.append(value)


class CodexTurn:
    """Codex working on a turn (real screen); Esc interrupts it (real screen), as seen live."""
    def __init__(self): self.name = "working"
    def ansi(self): return CODEX[self.name]
    def screen(self): return bridge.strip_sgr(CODEX[self.name])
    def key(self, name):
        if name == "Escape" and self.name == "working": self.name = "interrupted"
    def text(self, value): pass


class CodexTmuxTests(unittest.TestCase):
    """Codex CLI 0.163 in a tmux pane, on screens captured from a real one (fixtures/codex_tmux.json)."""
    setUp_claude = TmuxAgentTests.setUp
    tmux, h, agent, sent, keys, answer = (TmuxAgentTests.tmux, TmuxAgentTests.h, TmuxAgentTests.agent,
                                          TmuxAgentTests.sent, TmuxAgentTests.keys, TmuxAgentTests.answer)

    def setUp(self):
        self.setUp_claude()
        self.rows[1] = row("%1", win="1", name="codex", cmd="codex", path=self.proj, ppid="200", title="", sid="$0")
        self.procs[201]["argv"] = [str(self.home / ".local/bin/codex"), "--no-daemon"]
        self.tuis["%1"] = CodexScreen("idle")

    def test_state_from_real_screens(self):
        for name, want in (("idle", "idle"), ("working", "working"), ("interrupted", "idle"), ("plan", "idle"),
                           ("esc_again", "idle"), ("draft", "idle"), ("draft_multi", "idle"),
                           ("approval", "blocked"), ("question", "blocked"), ("model_menu", "blocked")):
            self.tuis["%1"] = CodexScreen(name)
            self.assertEqual(self.agent()["agent_status"], want, name)
        # Nothing of Codex's own composer on screen (an overlay, a dialog not understood): never idle,
        # so nothing is typed where letters may be shortcuts (y / p approve a command).
        self.tuis["%1"] = Static("  Approve?\n  [y] yes   [n] no\n")
        self.assertEqual(self.agent()["agent_status"], "working")
        with self.assertRaisesRegex(bridge.BridgeError, "^Agent is busy"):
            self.h(op="prompt", target="%1", identity=self.agent()["identity"], id=UUIDS[0], text="yes")
        self.assertEqual(self.sent(), [])

    def test_modes_only_under_its_composer(self):
        a = self.agent()
        read = lambda name: (self.tuis.__setitem__("%1", CodexScreen(name)), self.h(op="read", target="%1", identity=a["identity"]))[1]
        self.assertEqual(read("idle")["modes"], {"agent": "codex", "collaboration": "default", "goal": None, "cycle": True})
        self.assertEqual(read("plan")["modes"]["collaboration"], "plan")
        # The question's own hint reads "esc to interrupt": that is not the composer's footer.
        self.assertIsNone(read("question")["modes"])
        self.assertIsNone(read("approval")["modes"])

    def test_text_in_its_composer_is_never_joined(self):
        # Seen live: "leftover draft" in the composer + a prompt went out as "leftover draftReply with just: OK".
        a = self.agent()
        for name in ("draft", "draft_multi"):
            self.tuis["%1"] = CodexScreen(name)
            with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：它的输入框里已经有字"):
                self.h(op="prompt", target="%1", identity=a["identity"], id=UUIDS[0], text="Reply with just: OK")
        self.assertEqual(self.sent(), [])
        draft = lambda name: bridge.codex_draft(bridge.strip_sgr(CODEX[name]), CODEX[name])
        self.assertEqual([draft(n) for n in ("idle", "working", "plan", "esc_again")], ["", "", "", ""])
        self.assertEqual(draft("draft"), "hello draft text")
        self.assertEqual(draft("draft_multi").split("\n")[0], "first line")
        self.assertIsNone(draft("question"))
        # Without colours a placeholder cannot be told from typed text: counted as a draft.
        self.assertEqual(bridge.codex_draft(bridge.strip_sgr(CODEX["idle"]), ""), "Ask Codex to do anything")
        self.tuis["%1"] = CodexScreen("esc_again")
        self.assertEqual(self.h(op="prompt", target="%1", identity=a["identity"], id=UUIDS[1], text="next")["sent"], True)
        self.assertEqual(self.sent(), [["send-keys", "-t", "%1", "-l", "--", "next"], ["send-keys", "-t", "%1", "Enter"]])

    def test_approval_answered_with_keys(self):
        tui = self.tuis["%1"] = CodexPicker("approval", after="interrupted")
        a = self.agent()
        menu = self.h(op="read", target="%1", identity=a["identity"])["menu"]
        self.assertEqual((menu["kind"], menu["cursor"], menu["esc"]), ("approval", 1, {"action": "cancel", "option": 3}))
        self.assertEqual(menu["context"][0], "Would you like to run the following command?")
        self.assertIn("$ touch probe.txt", menu["context"])
        self.assertEqual([o["label"] for o in menu["options"]][2], "No, and tell Codex what to do differently (esc)")
        # The row under the cursor must be the one picked on the phone, or Enter is never pressed.
        with self.assertRaisesRegex(bridge.BridgeError, "不一致"):
            self.answer(UUIDS[0], action="select", option=2, label="Yes, proceed (y)")
        self.assertEqual((self.keys(), tui.picked), (["Down"], None))
        self.log.clear(); tui.cursor = 1
        r = self.answer(UUIDS[1], action="select", option=3, label="No, and tell Codex what to do differently (esc)")
        self.assertEqual((r["sent"], self.keys(), tui.picked), (True, ["Down", "Down", "Enter"], 3))
        self.assertEqual(tui.typed, [], "letters are shortcuts here: none typed")
        self.assertEqual(self.agent()["agent_status"], "idle")

    def test_question_and_model_pickers(self):
        tui = self.tuis["%1"] = CodexPicker("question")
        menu = self.h(op="read", target="%1", identity=self.agent()["identity"])["menu"]
        self.assertEqual((menu["kind"], menu["question"], menu["context"]), ("question", "Which color?", ["Question 1/1 (1 unanswered)", "Which color?"]))
        self.assertEqual(menu["esc"], {"action": "interrupt", "option": None})
        self.assertEqual([(o["label"], o["description"], o["input"]) for o in menu["options"]][:2], [("Red", "Choose red.", False), ("Blue", "Choose blue.", False)])
        with self.assertRaisesRegex(bridge.BridgeError, "没发出去"):
            self.h(op="key", target="%1", identity=self.agent()["identity"], id=UUIDS[0], key="shift+tab")
        self.answer(UUIDS[1], action="select", option=2, label="Blue")
        self.assertEqual((self.keys(), tui.picked), (["Down", "Enter"], 2))
        self.log.clear()
        tui = self.tuis["%1"] = CodexPicker("model_menu")
        menu = self.h(op="read", target="%1", identity=self.agent()["identity"])["menu"]
        # Its hint "enter select · esc back" is not part of the last row's description.
        self.assertEqual(menu["context"], ["Approaching rate limits", "Switch to gpt-6-luna for lower credit usage?"])
        self.assertEqual(menu["options"][2]["description"], "Hide future rate limit reminders about switching models")
        self.answer(UUIDS[2], action="select", option=2, label="Keep current model")
        self.assertEqual((self.keys(), tui.picked), (["Down", "Enter"], 2))

    def test_shift_tab_and_send_now(self):
        a = self.agent()
        self.h(op="key", target="%1", identity=a["identity"], id=UUIDS[0], key="shift+tab")
        self.assertEqual(self.keys(), ["BTab"])
        # 立即发送: refused while working, Esc, the screen says idle, then the message goes out.
        self.log.clear()
        self.tuis["%1"] = CodexTurn()
        with self.assertRaisesRegex(bridge.BridgeError, "^Agent is busy"):
            self.h(op="prompt", target="%1", identity=a["identity"], id=UUIDS[1], text="Reply with just: NOW-OK")
        self.assertEqual(self.h(op="status", target="%1", identity=a["identity"])["agents"][0]["agent_status"], "working")
        self.h(op="key", target="%1", identity=a["identity"], id=UUIDS[2], key="esc")
        self.assertEqual(self.h(op="status", target="%1", identity=a["identity"])["agents"][0]["agent_status"], "idle")
        self.h(op="prompt", target="%1", identity=a["identity"], id=UUIDS[3], text="Reply with just: NOW-OK")
        self.assertEqual(self.keys(), ["Escape", "Enter"])
        self.assertEqual(self.sent()[-2][-1], "Reply with just: NOW-OK")


if __name__ == "__main__":
    unittest.main()
