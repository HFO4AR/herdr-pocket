"""Computers without Herdr (tmux only), new / closed tmux sessions, and Claude / Codex agents
running inside tmux panes. A fake `tmux` on PATH and a fake process tree; the real tmux, the
real Herdr and the real /proc are never touched. PATH holds only the fixture directory, so
`herdr` cannot be found."""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_bridge import bridge
from test_tmux import row

FAKE = r'''#!%s
import json, os, sys
st = json.load(open(os.environ["FAKE_TMUX_STATE"]))
args = sys.argv[1:]
data = sys.stdin.read() if "load-buffer" in args else None
with open(os.environ["FAKE_TMUX_LOG"], "a") as f:
    f.write(json.dumps({"argv": args, "stdin": data}) + "\n")
cmd = args[1] if args[:1] == ["-u"] else args[0]
fail = st.get("fail", {}).get(cmd + ":" + args[-1]) or st.get("fail", {}).get(cmd)
if fail:
    sys.stderr.write(fail + "\n"); sys.exit(1)
if cmd == "list-panes" and "-s" in args:
    sys.stdout.write("".join(c + "\n" for c in st.get("session_cmds", ["bash"])))
elif cmd == "list-panes":
    sys.stdout.write("".join("\x1f".join(r) + "\n" for r in st["rows"]))
elif cmd == "capture-pane":
    target = args[args.index("-t") + 1]
    sys.stdout.write(st.get("screens", {}).get(target, "$ "))
elif cmd == "new-session":
    st["rows"].append(st["new_row"]); json.dump(st, open(os.environ["FAKE_TMUX_STATE"], "w"))
    sys.stdout.write(st["new_row"][1] + "\x1f" + st["new_row"][3] + "\n")
''' % sys.executable

UUID = "12345678-1234-4234-8234-123456789012"
UUID2 = "22345678-1234-4234-8234-123456789012"
CLAUDE_IDLE = "╭───╮\n│ > │\n╰───╯\n  ⏵⏵ accept edits on (shift+tab to cycle)\n"
CLAUDE_BUSY = "✻ Pondering… (12s · esc to interrupt)\n╭───╮\n│ > │\n╰───╯\n"
CLAUDE_ASK = ("Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently (esc)\n\n"
              "Esc to cancel · Tab to amend\n")


class TmuxOnlyTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        for d in ("bin", "home/proj", "home/notes"): (self.dir / d).mkdir(parents=True)
        fake = self.dir / "bin/tmux"; fake.write_text(FAKE); fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        self.home = self.dir / "home"
        self.proj = str(self.home / "proj")
        self.state_file, self.log = self.dir / "state.json", self.dir / "log.jsonl"
        self.state = {"rows": [row("%0", path=self.proj, sid="$0"),
                               row("%1", win="1", name="claude", cmd="claude", path=self.proj, ppid="200", title="✳ Fix the parser", sid="$0"),
                               row("%2", session="work", cmd="node", path=self.proj, ppid="300", sid="$1")],
                      "screens": {"%1": CLAUDE_IDLE, "%2": "• Working (3s • esc to interrupt)\n› \n"},
                      "new_row": row("%7", session="scratch", path=str(self.home / "notes"), ppid="700", sid="$2")}
        self.save()
        # PATH: the fake tmux only. HOME: an empty folder, so ~/.local/bin/herdr does not exist either.
        env = {"PATH": str(self.dir / "bin"), "HOME": str(self.home), "FAKE_TMUX_STATE": str(self.state_file), "FAKE_TMUX_LOG": str(self.log)}
        p = patch.dict(os.environ, env, clear=True); p.start(); self.addCleanup(p.stop)
        h = patch.object(bridge.Path, "home", return_value=self.home); h.start(); self.addCleanup(h.stop)
        # Fake process tree: 200 is a shell running Claude (201), 300 a node launcher of Codex.
        self.procs = {
            100: {"argv": ["-bash"], "children": [], "paths": [], "cwd": self.proj, "start": "10", "active_threads": []},
            200: {"argv": ["-bash"], "children": [201], "paths": [], "cwd": self.proj, "start": "20", "active_threads": []},
            201: {"argv": ["node", "/usr/lib/node_modules/.bin/claude"], "children": [], "paths": [Path("/h/.claude/projects/p/T1.jsonl")],
                  "cwd": self.proj, "start": "21", "active_threads": []},
            300: {"argv": ["node", "/usr/bin/codex"], "children": [], "paths": [], "cwd": self.proj, "start": "30", "active_threads": []},
            700: {"argv": ["-bash"], "children": [], "paths": [], "cwd": str(self.home / "notes"), "start": "70", "active_threads": []}}
        s = patch.object(bridge, "process_snapshot", side_effect=lambda pid: self.procs.get(pid)); s.start(); self.addCleanup(s.stop)
        self.catalog = [{"provider": "claude", "thread": "T1", "id": "rec1", "_path": Path("/h/.claude/projects/p/T1.jsonl"), "cwd": self.proj,
                         "title": "Fix the parser", "modified": 1.0, "parent": None},
                        {"provider": "codex", "thread": "C1", "id": "rec2", "_path": Path("/h/.codex/sessions/a.jsonl"), "cwd": self.proj,
                         "title": "other", "modified": 2.0, "parent": None},
                        {"provider": "codex", "thread": "0199aaaa-1111-4222-8333-444455556666", "id": "rec3", "_path": Path("/h/.codex/sessions/b.jsonl"), "cwd": self.proj,
                         "title": "another", "modified": 3.0, "parent": None}]
        c = patch.object(bridge, "transcript_catalog", side_effect=lambda *a, **k: list(self.catalog)); c.start(); self.addCleanup(c.stop)
        for name in ("codex_thread_names", "codex_loaded_threads"):
            q = patch.object(bridge, name, return_value={} if name == "codex_thread_names" else set()); q.start(); self.addCleanup(q.stop)
        self.receipts = self.dir / "state"

    def save(self): self.state_file.write_text(json.dumps(self.state))
    def argvs(self): return [json.loads(x)["argv"] for x in self.log.read_text().splitlines()] if self.log.exists() else []
    def reset_log(self): self.log.unlink(missing_ok=True)
    def h(self, **req): return bridge.handle(dict(v=1, **req), self.receipts)
    def panes(self, **kw): return self.h(op="tmux", **kw)["panes"]
    def pane(self, pid, **kw): return next(p for p in self.panes(**kw) if p["pane_id"] == pid)

    # ── 1. No Herdr: clean answers, no crash ──
    def test_no_herdr_sessions_flag_and_doctor(self):
        self.assertEqual(self.h(op="sessions"), {"sessions": [], "herdr": False, "tmux": True})
        doctor = self.h(op="doctor")
        self.assertEqual((doctor["herdr"], doctor["tmux"], doctor["running"]), (False, True, None))
        with patch.dict(os.environ, {"PATH": str(self.dir / "nothing")}):
            self.assertEqual(self.h(op="sessions"), {"sessions": [], "herdr": False, "tmux": False})
            self.assertFalse(self.h(op="doctor")["tmux"])

    def test_every_herdr_op_fails_cleanly(self):
        for op in ("agents", "status", "panes", "createInfo", "closeInfo", "closePane", "read", "prompt", "key", "commands", "exitAgent", "paneRead"):
            with self.subTest(op=op), self.assertRaisesRegex(bridge.BridgeError, "没找到 Herdr"):
                self.h(op=op, session="default", target="w1:p1", identity="x", id=UUID, text="hi", key="enter")
        # Through the real entry point: one JSON line, ok false, no traceback.
        env = dict(os.environ, PATH=str(self.dir / "bin"), HOME=str(self.home))
        out = subprocess.run([sys.executable, "-I", str(Path(bridge.__file__))], input='{"v":1,"op":"agents","session":"default"}\n',
                             capture_output=True, text=True, timeout=30, env=env)
        reply = json.loads(out.stdout)
        self.assertFalse(reply["ok"]); self.assertIn("没找到 Herdr", reply["error"]); self.assertEqual(out.stderr, "")
        sessions = subprocess.run([sys.executable, "-I", str(Path(bridge.__file__))], input='{"v":1,"op":"sessions"}\n',
                                  capture_output=True, text=True, timeout=30, env=env)
        self.assertEqual(json.loads(sessions.stdout), {"ok": True, "data": {"sessions": [], "herdr": False, "tmux": True}})

    # ── 2. New tmux session ──
    def test_new_session_argv_no_shell_and_returns_pane(self):
        self.reset_log()
        result = self.h(op="tmuxNew", id=UUID, name="scratch", cwd="~/notes")
        new = [a for a in self.argvs() if a[1] == "new-session"]
        self.assertEqual(new, [["-u", "new-session", "-d", "-s", "scratch", "-c", str(self.home / "notes"), "-P", "-F", "#{pane_id}\x1f#{session_name}"]])
        self.assertEqual((result["created"], result["session"], result["pane"]["pane_id"]), (True, "scratch", "%7"))
        self.assertTrue(result["pane"]["identity"]); self.assertNotIn("_pid", result["pane"])
        # The same id never runs twice.
        self.reset_log()
        self.assertEqual(self.h(op="tmuxNew", id=UUID, name="scratch", cwd="~/notes"), result)
        self.assertFalse(any(a[1] == "new-session" for a in self.argvs()))

    def test_new_session_without_name_and_without_server(self):
        self.state["fail"] = {"list-panes": "no server running on /tmp/tmux-1000/default"}; self.save()
        self.reset_log()
        result = self.h(op="tmuxNew", id=UUID, cwd=self.proj)
        self.assertTrue(result["created"])
        new = next(a for a in self.argvs() if a[1] == "new-session")
        self.assertNotIn("-s", new, "tmux picks the name")
        self.assertEqual(new[new.index("-c") + 1], self.proj)

    def test_new_session_validation_never_reaches_tmux(self):
        bad = [dict(name="a b"), dict(name="x;rm -rf ~"), dict(name="a.b"), dict(name="-t"), dict(name="x" * 65), dict(name=5),
               dict(cwd="relative/dir"), dict(cwd=str(self.home / "missing")), dict(cwd="~/proj/../proj"), dict(cwd="/etc"),
               dict(cwd="~/proj\n"), dict(extra=1), dict(name="main")]
        for i, extra in enumerate(bad):
            req = dict(op="tmuxNew", id="3234567%d-1234-4234-8234-123456789012" % (i % 10), cwd=self.proj); req.update(extra)
            if "extra" in extra: req["extra"] = 1
            self.reset_log()
            with self.subTest(extra=extra), self.assertRaisesRegex(bridge.BridgeError, "没创建"):
                self.h(**req)
            self.assertFalse(any(a[1] == "new-session" for a in self.argvs()))
        with self.assertRaisesRegex(bridge.BridgeError, "UUID"):
            self.h(op="tmuxNew", id="x", cwd=self.proj)

    def test_new_session_refused_by_tmux_is_recorded(self):
        self.state["fail"] = {"new-session": "duplicate session: scratch"}; self.save()
        req = dict(op="tmuxNew", id=UUID, name="scratch", cwd=self.proj)
        with self.assertRaisesRegex(bridge.BridgeError, "没创建：tmux 没接受"):
            self.h(**req)
        self.state["fail"] = {}; self.save(); self.reset_log()
        self.assertEqual(self.h(**req), {"created": False})
        self.assertFalse(any(a[1] == "new-session" for a in self.argvs()))

    def test_info_offers_tmux_dirs_and_sessions(self):
        info = self.h(op="tmuxInfo")
        self.assertTrue(info["available"]); self.assertEqual(info["home"], str(self.home))
        self.assertEqual(info["dirs"][0], {"path": self.proj, "source": "tmux"})
        self.assertEqual(info["sessions"], ["main", "work"])

    # ── 3. Close ──
    def test_kill_pane_and_session_by_identity(self):
        p = self.pane("%0"); self.reset_log()
        self.assertEqual(self.h(op="tmuxKill", id=UUID, target="%0", identity=p["identity"], scope="pane"),
                         {"closed": True, "scope": "pane", "session": "main"})
        self.assertEqual(self.argvs()[-1], ["-u", "kill-pane", "-t", "%0"])
        self.reset_log()
        self.assertEqual(self.h(op="tmuxKill", id=UUID2, target="%0", identity=p["identity"], scope="session")["scope"], "session")
        self.assertEqual(self.argvs()[-1], ["-u", "kill-session", "-t", "$0"])
        # Never twice for one id, even once the pane is gone.
        self.state["rows"] = self.state["rows"][1:]; self.save()
        self.reset_log()
        self.h(op="tmuxKill", id=UUID2, target="%0", identity=p["identity"], scope="session")
        self.assertFalse(any(a[1].startswith("kill") for a in self.argvs()))

    def test_kill_refusals(self):
        p = self.pane("%0")
        for req, msg in ((dict(identity="0" * 64, scope="pane"), "关了或换了"), (dict(identity=p["identity"], scope="window"), "不支持"),
                         (dict(identity=p["identity"], scope="pane", extra=1), "不认识")):
            self.reset_log()
            with self.assertRaisesRegex(bridge.BridgeError, msg):
                self.h(op="tmuxKill", id=UUID, target="%0", **req)
            self.assertFalse(any(a[1].startswith("kill") for a in self.argvs()))
        self.state["session_cmds"] = ["bash", "herdr"]; self.save(); self.reset_log()
        with self.assertRaisesRegex(bridge.BridgeError, "Herdr"):
            self.h(op="tmuxKill", id=UUID, target="%0", identity=p["identity"], scope="session")
        self.assertFalse(any(a[1].startswith("kill") for a in self.argvs()))

    # ── 4. Agents inside tmux panes ──
    def test_list_detects_agents_from_the_process_tree(self):
        panes = {p["pane_id"]: p for p in self.panes()}
        self.assertNotIn("agent", panes["%0"], "a plain shell stays a terminal")
        cl, cx = panes["%1"]["agent"], panes["%2"]["agent"]
        self.assertEqual((cl["agent"], cl["agent_status"], cl["tmux"], cl["terminal_title"]), ("claude", "idle", True, "✳ Fix the parser"))
        self.assertEqual((cx["agent"], cx["agent_status"]), ("codex", "working"))
        self.assertNotEqual(cl["identity"], panes["%1"]["identity"], "the agent has its own identity")
        self.assertNotIn("history_ref", cl, "no transcript scan on the cheap poll")
        self.state["screens"]["%1"] = CLAUDE_ASK; self.save()
        self.assertEqual(self.pane("%1")["agent"]["agent_status"], "blocked")
        self.state["screens"]["%1"] = CLAUDE_BUSY; self.save()
        self.assertEqual(self.pane("%1")["agent"]["agent_status"], "working")
        # Two agents in one pane: unsure, so a terminal.
        self.procs[200]["children"] = [201, 300]
        self.assertNotIn("agent", self.pane("%1"))

    def test_resolve_matches_only_with_evidence(self):
        panes = {p["pane_id"]: p for p in self.panes(resolve=True)}
        ref = panes["%1"]["agent"]["history_ref"]
        self.assertEqual((ref["status"], ref["record_id"], ref["source"], ref["record"]["title"]), ("matched", "rec1", "open-file", "Fix the parser"))
        self.assertNotIn("_path", ref["record"])
        # Codex: no open file, no title, no argv id: never guessed, candidates from its directory instead.
        cx = panes["%2"]["agent"]["history_ref"]
        self.assertEqual(cx["status"], "unavailable"); self.assertNotIn("record", cx)
        self.assertEqual({c["id"] for c in cx["candidates"]}, {"rec2", "rec3"})
        # Codex with `resume <id>` in its argv.
        self.procs[300]["argv"] = ["node", "/usr/bin/codex", "resume", "0199aaaa-1111-4222-8333-444455556666"]
        self.assertEqual(self.pane("%2", resolve=True)["agent"]["history_ref"]["record_id"], "rec3")

    def test_claude_native_session_dir_wins(self):
        self.procs[201]["active_threads"] = ["T9"]
        with patch.object(bridge, "locate_thread", return_value=None):
            ref = self.pane("%1", resolve=True)["agent"]["history_ref"]
        self.assertEqual((ref["status"], ref["thread"]), ("pending", "T9"))

    def agent(self, pid="%1"): return self.pane(pid)["agent"]

    def test_agent_read_prompt_and_keys_through_tmux(self):
        a = self.agent()
        read = self.h(op="read", session="", target="%1", identity=a["identity"], ansi=True)
        self.assertEqual(read["agent_status"], "idle"); self.assertIn("accept edits", read["text"])
        self.assertIn("modes", read); self.assertIn("bg", read); self.assertIn("ansi", read)
        self.reset_log()
        self.assertEqual(self.h(op="prompt", session="", target="%1", identity=a["identity"], id=UUID, text="ship it"), {"sent": True, "receipt": UUID})
        self.assertEqual(self.argvs()[-2:], [["-u", "send-keys", "-t", "%1", "-l", "--", "ship it"], ["-u", "send-keys", "-t", "%1", "Enter"]])
        self.reset_log()
        self.h(op="prompt", session="", target="%1", identity=a["identity"], id=UUID, text="ship it")
        self.assertFalse(any(x[1] == "send-keys" for x in self.argvs()), "never twice")
        self.reset_log()
        self.h(op="prompt", session="", target="%1", identity=a["identity"], id=UUID2, text="one\ntwo")
        self.assertEqual([x[1] for x in self.argvs() if x[1] in ("load-buffer", "paste-buffer", "send-keys")], ["load-buffer", "paste-buffer", "send-keys"])
        self.reset_log()
        self.h(op="key", session="", target="%1", identity=a["identity"], id="52345678-1234-4234-8234-123456789012", key="shift+tab")
        self.assertEqual(self.argvs()[-1], ["-u", "send-keys", "-t", "%1", "BTab"])
        self.assertEqual(self.h(op="commands", session="", target="%1", identity=a["identity"])["commands"], [])

    def test_agent_input_refusals(self):
        a = self.agent()
        cases = [(dict(op="prompt", identity=self.pane("%1")["identity"], text="x"), "Agent changed"),
                 (dict(op="prompt", identity=a["identity"], text="x", images=[{"name": "a"}]), "图片"),
                 (dict(op="answer", identity=a["identity"], action="pick", option=1), "终端"),
                 (dict(op="stageFile", identity=a["identity"]), "文件"),
                 (dict(op="exitAgent", identity=a["identity"]), "关闭"),
                 (dict(op="key", identity=a["identity"], key="C-c"), "Unsupported")]
        for req, msg in cases:
            self.reset_log()
            with self.subTest(op=req["op"]), self.assertRaisesRegex(bridge.BridgeError, msg):
                self.h(session="", target="%1", id=UUID, **req)
            self.assertFalse(any(x[1] in ("send-keys", "paste-buffer") for x in self.argvs()))
        # Waiting on a menu: a prompt would land in it.
        self.state["screens"]["%1"] = CLAUDE_ASK; self.save(); self.reset_log()
        with self.assertRaisesRegex(bridge.BridgeError, "没发出去"):
            self.h(op="prompt", session="", target="%1", identity=a["identity"], id=UUID, text="x")
        self.assertFalse(any(x[1] == "send-keys" for x in self.argvs()))
        # The agent process was replaced (same pane, new Claude): the old identity is refused.
        self.procs[201] = dict(self.procs[201], start="99")
        with self.assertRaisesRegex(bridge.BridgeError, "Agent changed"):
            self.h(op="read", session="", target="%1", identity=a["identity"])

    def test_follow_states(self):
        a = self.agent()
        r = self.h(op="agents", session="", target="%1", identity=a["identity"])
        self.assertEqual((r["follow"], r["state"], r["agents"][0]["history_ref"]["record_id"]), (True, "same", "rec1"))
        self.assertEqual(r["agents"][0]["tmux_pane"]["pane_id"], "%1")
        self.procs[201] = dict(self.procs[201], start="99")
        self.assertEqual(self.h(op="agents", session="", target="%1", identity=a["identity"])["state"], "changed")
        self.procs[200]["children"] = []
        r = self.h(op="agents", session="", target="%1", identity=a["identity"])
        self.assertEqual((r["state"], r["pane"]["pane_id"], r["pane"]["tmux"]), ("exited", "%1", True))
        self.state["rows"] = self.state["rows"][:1]; self.save()
        self.assertEqual(self.h(op="agents", session="", target="%1", identity=a["identity"])["state"], "gone")


if __name__ == "__main__":
    unittest.main()
