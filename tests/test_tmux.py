"""tmux sessions (list, colored screen, input) against a fake `tmux` on PATH. The real tmux is
never called: PATH holds only the fixture directory in front, and every call is logged."""
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_bridge import bridge

FAKE = r'''#!%s
import json, os, sys
st = json.load(open(os.environ["FAKE_TMUX_STATE"]))
args = sys.argv[1:]
data = sys.stdin.read() if "load-buffer" in args else None
with open(os.environ["FAKE_TMUX_LOG"], "a") as f:
    f.write(json.dumps({"argv": args, "stdin": data, "tmux_env": "TMUX" in os.environ}) + "\n")
cmd = args[1] if args[:1] == ["-u"] else args[0]
fail = st.get("fail", {}).get(cmd + ":" + args[-1]) or st.get("fail", {}).get(cmd)
if fail:
    sys.stderr.write(fail + "\n"); sys.exit(1)
if cmd == "list-panes":
    sys.stdout.write("".join("\x1f".join(r) + "\n" for r in st["rows"]))
elif cmd == "capture-pane":
    sys.stdout.write(st["screen"])
''' % sys.executable

UUID = "12345678-1234-4234-8234-123456789012"


def row(pane, session="main", win="0", name="bash", wactive="1", index="0", pactive="1", attached="1",
        cmd="bash", path="/home/u/proj", dead="0", panes="1", pid="4242", ppid="100"):
    return [pid, pane, ppid, session, win, name, wactive, index, pactive, attached, cmd, path, "120", "40", dead, panes]


class TmuxTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        (self.dir / "bin").mkdir()
        fake = self.dir / "bin/tmux"
        fake.write_text(FAKE)
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        self.state_file, self.log = self.dir / "state.json", self.dir / "log.jsonl"
        self.state = {"rows": [row("%0"), row("%1", win="1", name="editor", wactive="0", cmd="vim"),
                               row("%2", win="1", name="editor", wactive="0", index="1", pactive="0", panes="2"),
                               row("%3", session="herdr", cmd="herdr"), row("%4", dead="1"),
                               row("%5", session="work", attached="0", cmd="python3")],
                      "screen": "\x1b]0;title\x07$ ls\n\x1b[1;31mred\x1b[0m plain\x1b[2J\x1b[H\n\x1b[?25l\n\n"}
        self.save()
        env = dict(os.environ, PATH=str(self.dir / "bin") + os.pathsep + os.environ.get("PATH", ""),
                   FAKE_TMUX_STATE=str(self.state_file), FAKE_TMUX_LOG=str(self.log), TMUX="/tmp/tmux-1/other,1,0")
        p = patch.dict(os.environ, env, clear=True); p.start(); self.addCleanup(p.stop)
        self.receipts = self.dir / "state"

    def save(self): self.state_file.write_text(json.dumps(self.state))
    def calls(self):
        return [json.loads(x) for x in self.log.read_text().splitlines()] if self.log.exists() else []
    def argvs(self): return [c["argv"] for c in self.calls()]
    def panes(self): return bridge.handle({"v": 1, "op": "tmux"})["panes"]
    def pane(self, pid): return next(p for p in self.panes() if p["pane_id"] == pid)
    def send(self, **kw):
        p = self.pane(kw.pop("target", "%0"))
        req = {**dict(v=1, op="tmuxSend", id=UUID, target=p["pane_id"], identity=p["identity"]), **kw}
        self.log.unlink(missing_ok=True)
        return req, bridge.handle(req, self.receipts)

    def test_list_default_server_only(self):
        result = bridge.handle({"v": 1, "op": "tmux"})
        self.assertTrue(result["available"])
        self.assertEqual([p["pane_id"] for p in result["panes"]], ["%0", "%1", "%2", "%5"], "Herdr client and dead panes are left out")
        first = result["panes"][0]
        self.assertEqual((first["session"], first["window_index"], first["window_name"], first["command"], first["active"], first["attached"]),
                         ("main", 0, "bash", "bash", True, True))
        self.assertFalse(self.pane("%1")["active"], "the active pane of an inactive window is not the one on screen")
        self.assertEqual(self.pane("%2")["window_panes"], 2)
        self.assertFalse(self.pane("%5")["attached"])
        call = self.calls()[0]
        self.assertEqual(call["argv"][:4], ["-u", "list-panes", "-a", "-F"])
        self.assertNotIn("-L", call["argv"]); self.assertNotIn("-S", call["argv"])
        self.assertFalse(call["tmux_env"], "$TMUX is dropped so the default server is used")

    def test_no_server_and_no_tmux(self):
        self.state["fail"] = {"list-panes": "no server running on /tmp/tmux-1000/default"}; self.save()
        self.assertEqual(bridge.handle({"v": 1, "op": "tmux"}), {"available": True, "panes": []})
        self.state["fail"] = {"list-panes": "error connecting to /tmp/tmux-1000/default (No such file or directory)"}; self.save()
        self.assertEqual(bridge.handle({"v": 1, "op": "tmux"}), {"available": True, "panes": []})
        with patch.dict(os.environ, {"PATH": str(self.dir / "empty")}):
            self.assertEqual(bridge.handle({"v": 1, "op": "tmux"}), {"available": False, "panes": []})

    def test_identity_changes_with_server_or_pane_process(self):
        before = self.pane("%0")["identity"]
        self.state["rows"][0] = row("%0", pid="999"); self.save()
        self.assertNotEqual(self.pane("%0")["identity"], before)

    def test_read_colored_screen_sgr_only(self):
        p = self.pane("%0"); self.log.unlink()
        data = bridge.handle({"v": 1, "op": "tmuxRead", "target": "%0", "identity": p["identity"]})
        self.assertEqual(self.argvs()[-1], ["-u", "capture-pane", "-p", "-e", "-J", "-t", "%0", "-S", "-200"])
        self.assertEqual(data["ansi"], "$ ls\n\x1b[1;31mred\x1b[0m plain")
        self.assertEqual(data["text"], "$ ls\nred plain")
        self.assertNotIn("\x1b]", data["ansi"]); self.assertNotIn("title", data["ansi"])

    def test_bad_pane_ids_and_changed_panes_never_reach_tmux(self):
        p = self.pane("%0")
        for target in ("%0;rm -rf ~", "0", "%x", "-t", "%0 ", "main:0", None, 5):
            self.log.unlink(missing_ok=True)
            with self.assertRaises(bridge.BridgeError):
                bridge.handle({"v": 1, "op": "tmuxRead", "target": target, "identity": p["identity"]})
            with self.assertRaises(bridge.BridgeError):
                bridge.handle({"v": 1, "op": "tmuxSend", "id": UUID, "target": target, "identity": p["identity"], "action": "key", "key": "enter"}, self.receipts)
            self.assertFalse(any(a[1] in ("capture-pane", "send-keys") for a in self.argvs()))
        with self.assertRaisesRegex(bridge.BridgeError, "关了或换了"):
            bridge.handle({"v": 1, "op": "tmuxRead", "target": "%0", "identity": "0" * 64})
        with self.assertRaisesRegex(bridge.BridgeError, "关了或换了"):
            bridge.handle({"v": 1, "op": "tmuxRead", "target": "%3", "identity": p["identity"]})
        self.assertFalse(any(a[1] == "capture-pane" for a in self.argvs()))

    def test_send_text_is_literal_and_run_adds_enter(self):
        req, result = self.send(action="text", text="-n $(rm -rf ~); echo hi")
        self.assertEqual(result, {"sent": True, "receipt": UUID})
        self.assertEqual(self.argvs()[-1], ["-u", "send-keys", "-t", "%0", "-l", "--", "-n $(rm -rf ~); echo hi"])
        req, _ = self.send(action="run", text="ls", id="22345678-1234-4234-8234-123456789012")
        self.assertEqual(self.argvs()[-2:], [["-u", "send-keys", "-t", "%0", "-l", "--", "ls"], ["-u", "send-keys", "-t", "%0", "Enter"]])

    def test_keys_are_named_and_allow_listed(self):
        for i, (key, name) in enumerate((("esc", "Escape"), ("ctrl+c", "C-c"), ("up", "Up"), ("tab", "Tab"), ("enter", "Enter"), ("backspace", "BSpace"))):
            self.send(action="key", key=key, id="3234567%d-1234-4234-8234-123456789012" % i)
            self.assertEqual(self.argvs()[-1], ["-u", "send-keys", "-t", "%0", name])
        p = self.pane("%0")
        for bad in ({"action": "key", "key": "C-c"}, {"action": "key", "key": "ctrl+z"}, {"action": "key", "key": "enter", "text": "x"},
                    {"action": "run", "text": ""}, {"action": "run", "text": "a\x00b"}, {"action": "run", "text": "x" * 16001},
                    {"action": "shell", "text": "ls"}, {"action": "run", "text": "ls", "session": "x"}):
            self.log.unlink(missing_ok=True)
            with self.assertRaises(bridge.BridgeError):
                bridge.handle(dict(v=1, op="tmuxSend", id="42345678-1234-4234-8234-123456789012", target="%0", identity=p["identity"], **bad), self.receipts)
            self.assertFalse(any(a[1] == "send-keys" for a in self.argvs()))
        with self.assertRaises(bridge.BridgeError):
            bridge.handle(dict(v=1, op="tmuxSend", id="not-a-uuid", target="%0", identity=p["identity"], action="key", key="enter"), self.receipts)

    def test_several_lines_go_in_as_one_paste(self):
        self.send(action="run", text="echo a\r\necho b")
        argv = self.argvs()
        self.assertEqual(argv[-3][:4], ["-u", "load-buffer", "-b", "herdr-pocket-12345678"])
        self.assertEqual(self.calls()[-3]["stdin"], "echo a\necho b")
        self.assertEqual(argv[-2], ["-u", "paste-buffer", "-p", "-d", "-b", "herdr-pocket-12345678", "-t", "%0"])
        self.assertEqual(argv[-1], ["-u", "send-keys", "-t", "%0", "Enter"])

    def test_same_id_is_never_sent_twice(self):
        req, first = self.send(action="run", text="make")
        self.log.unlink()
        self.assertEqual(bridge.handle(req, self.receipts), first)
        self.assertFalse(any(a[1] == "send-keys" for a in self.argvs()))
        with self.assertRaisesRegex(bridge.BridgeError, "different content"):
            bridge.handle(dict(req, text="make clean"), self.receipts)

    def test_refused_before_writing_is_not_sent(self):
        self.state["fail"] = {"send-keys": "can't find pane: %0"}; self.save()
        p = self.pane("%0")
        req = dict(v=1, op="tmuxSend", id=UUID, target="%0", identity=p["identity"], action="run", text="ls")
        with self.assertRaisesRegex(bridge.BridgeError, "没发出去"):
            bridge.handle(req, self.receipts)
        self.assertEqual(bridge.handle(req, self.receipts), {"sent": False, "rejected": "tmux"})

    def test_failure_after_a_write_is_unknown_and_not_replayed(self):
        self.state["fail"] = {"send-keys:Enter": "server exited unexpectedly"}; self.save()
        p = self.pane("%0")
        req = dict(v=1, op="tmuxSend", id=UUID, target="%0", identity=p["identity"], action="run", text="ls")
        with self.assertRaisesRegex(bridge.BridgeError, "结果未知"):
            bridge.handle(req, self.receipts)
        self.state["fail"] = {}; self.save(); self.log.unlink()
        with self.assertRaisesRegex(bridge.BridgeError, "结果未知"):
            bridge.handle(req, self.receipts)
        self.assertFalse(any(a[1] == "send-keys" for a in self.argvs()))


if __name__ == "__main__":
    unittest.main()
