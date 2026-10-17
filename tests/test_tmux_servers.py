"""Every tmux server of the SSH user (default plus `tmux -L name` ones), against a fake `tmux` that
keeps one state per socket. The sockets are real unix sockets in temporary directories; the
real tmux and this machine's own socket directories are never used (tmux_socket_dirs is patched)."""
import json
import os
import socket
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from test_bridge import bridge
from test_tmux import row

FAKE = r'''#!%s
import json, os, sys, time
st = json.load(open(os.environ["FAKE_TMUX_STATE"]))
def save(): json.dump(st, open(os.environ["FAKE_TMUX_STATE"], "w"))
args = sys.argv[1:]
with open(os.environ["FAKE_TMUX_LOG"], "a") as f:
    f.write(json.dumps({"argv": args}) + "\n")
if args[:1] == ["-u"]: args = args[1:]
sock = "default"
if args[:1] == ["-S"]: sock, args = args[1], args[2:]
server = st["servers"].get(sock)
cmd = args[0]
if server is None or server.get("dead"):
    sys.stderr.write("no server running on %%s\n" %% sock); sys.exit(1)
if server.get("sleep"): time.sleep(server["sleep"])
fail = server.get("fail", {}).get(cmd)
if fail:
    sys.stderr.write(fail + "\n"); sys.exit(1)
if cmd == "list-panes" and "-s" in args:
    sys.stdout.write("bash\n")
elif cmd == "list-panes":
    sys.stdout.write("".join("\x1f".join(r) + "\n" for r in server["rows"]))
elif cmd == "capture-pane":
    sys.stdout.write(server.get("screen", "$ ") + "\n")
elif cmd == "new-session":
    server["rows"].append(st["new_row"]); save()
    sys.stdout.write(st["new_row"][1] + "\x1f" + st["new_row"][3] + "\n")
''' % sys.executable

UUID = "12345678-1234-4234-8234-123456789012"
UUID2 = "22345678-1234-4234-8234-123456789012"


def make_socket(path):
    """A real unix socket file (nothing listens on it: the fake tmux decides what answers)."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.bind(str(path)); s.close()


class TmuxServersTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(dir="/tmp"); self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        (self.dir / "bin").mkdir()
        fake = self.dir / "bin/tmux"; fake.write_text(FAKE); fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        self.home = self.dir / "home"; (self.home / "proj").mkdir(parents=True)
        # The socket directory tmux would use with TMUX_TMPDIR=<dir>/s, plus a second one (like /tmp).
        self.main = self.dir / "s" / ("tmux-%d" % os.getuid()); self.main.mkdir(parents=True); self.main.chmod(0o700)
        self.other = self.dir / "o" / ("tmux-%d" % os.getuid()); self.other.mkdir(parents=True); self.other.chmod(0o700)
        for name in ("default", "a", "b", "dead"): make_socket(self.main / name)
        make_socket(self.other / "c")
        os.symlink(self.main / "a", self.main / "link")            # a symlink to a live socket: never used
        (self.main / "notes.txt").write_text("not a socket")
        self.sock = {n: str(self.main / n) for n in ("default", "a", "b", "dead")}
        self.sock["c"] = str(self.other / "c")
        proj = str(self.home / "proj")
        self.state = {"servers": {
            "default": {"rows": [row("%0", path=proj, sid="$0"), row("%1", win="1", name="logs", cmd="tail", path=proj, sid="$0")]},
            self.sock["a"]: {"rows": [row("%0", session="work", pid="5000", path=proj, sid="$0"),
                                      row("%1", session="work", win="1", pid="5000", ppid="101", path=proj, sid="$0")], "screen": "on a"},
            self.sock["b"]: {"rows": [row("%0", session="main", pid="6000", ppid="102", path=proj, sid="$3")], "screen": "on b"},
            self.sock["dead"]: {"dead": True},
            self.sock["c"]: {"rows": [row("%4", session="far", pid="7000", ppid="103", path=proj, sid="$0")]}},
            "new_row": row("%2", session="scratch", path=proj, ppid="104", sid="$1")}
        self.save()
        env = {"PATH": str(self.dir / "bin"), "HOME": str(self.home), "TMUX": "/tmp/elsewhere,1,0",
                               "FAKE_TMUX_STATE": str(self.state_file), "FAKE_TMUX_LOG": str(self.log),
                               "TMUX_TMPDIR": str(self.dir / "s")}
        p = patch.dict(os.environ, env, clear=True); p.start(); self.addCleanup(p.stop)
        for name, value in (("SYSTEM_BIN_DIRS", ()),):
            q = patch.object(bridge, name, value); q.start(); self.addCleanup(q.stop)
        self.dirs = [str(self.main), str(self.other)]
        q = patch.object(bridge, "tmux_socket_dirs", side_effect=lambda: list(self.dirs)); q.start(); self.addCleanup(q.stop)
        h = patch.object(bridge.Path, "home", return_value=self.home); h.start(); self.addCleanup(h.stop)
        q = patch.object(bridge, "process_snapshot", return_value=None); q.start(); self.addCleanup(q.stop)
        self.addCleanup(bridge._tmux_sep.clear)
        self.receipts = self.dir / "state"

    @property
    def state_file(self): return self.dir / "state.json"
    @property
    def log(self): return self.dir / "log.jsonl"
    def save(self): self.state_file.write_text(json.dumps(self.state))
    def argvs(self): return [json.loads(x)["argv"] for x in self.log.read_text().splitlines()] if self.log.exists() else []
    def reset(self): self.log.unlink(missing_ok=True)
    def h(self, **req): return bridge.handle(dict(v=1, **req), self.receipts)
    def listing(self): return self.h(op="tmux")
    def pane(self, server, tid):
        return next(p for p in self.listing()["panes"] if p.get("server", "default") == server and p["pane_id"].split("@")[0] == tid)
    def sockets_used(self): return [a[a.index("-S") + 1] for a in self.argvs() if "-S" in a]

    def test_lists_every_owned_server_with_distinct_ids(self):
        r = self.listing()
        key = {n: bridge.tmux_server_key(self.sock[n]) for n in ("a", "b", "c")}
        self.assertEqual([p["pane_id"] for p in r["panes"]],
                         ["%0", "%1", "%0@" + key["a"], "%1@" + key["a"], "%0@" + key["b"], "%4@" + key["c"]])
        self.assertEqual([p.get("server") for p in r["panes"]], [None, None, "a", "a", "b", "c"])
        self.assertNotIn("_sock", r["panes"][2]); self.assertNotIn("_tid", r["panes"][2])
        # %0 on the default server and %0 on "a" are different panes.
        self.assertNotEqual(r["panes"][0]["identity"], r["panes"][2]["identity"])
        self.assertEqual(r["looked"], self.dirs)
        self.assertEqual({(s["name"], s["state"], s["panes"]) for s in r["servers"]},
                         {("default", "running", 2), ("a", "running", 2), ("b", "running", 1), ("dead", "none", 0), ("c", "running", 1)})
        self.assertIn({"path": str(self.main / "link"), "reason": "是符号链接，没跟过去"}, r["skipped"])
        # The default server is asked without -S (its socket is not read a second time as a named
        # one); the symlink and the plain file never reach tmux.
        used = self.sockets_used()
        self.assertEqual(sorted(used), sorted([self.sock["a"], self.sock["b"], self.sock["dead"], self.sock["c"]]))
        plain = [a for a in self.argvs() if "-S" not in a]
        self.assertEqual(len(plain), 1); self.assertEqual(plain[0][:3], ["-u", "list-panes", "-a"])
        for argv in self.argvs():
            if "-S" in argv: self.assertEqual(argv[:4], ["-u", "-S", argv[2], "list-panes"], "-S comes before the command, as one argv item")

    def test_unsafe_directories_and_foreign_sockets_are_skipped(self):
        loose = self.dir / "loose" / "tmux-x"; loose.mkdir(parents=True); make_socket(loose / "x"); loose.chmod(0o777)
        self.addCleanup(loose.chmod, 0o700)
        linked = self.dir / "linked"; os.symlink(self.other, linked)
        foreign_dir = self.dir / "theirs" / "tmux-y"; foreign_dir.mkdir(parents=True); foreign_dir.chmod(0o700); make_socket(foreign_dir / "y")
        self.dirs = [str(self.main), str(loose), str(linked), str(foreign_dir), str(self.dir / "missing")]
        real = os.lstat
        def lstat(path, *a, **k):
            st = real(path, *a, **k)
            if str(path) in (str(self.main / "b"), str(foreign_dir)):
                values = list(st); values[stat.ST_UID] = os.getuid() + 1
                return os.stat_result(values)
            return st
        with patch.object(bridge.os, "lstat", side_effect=lstat):
            r = self.listing()
        reasons = {x["path"]: x["reason"] for x in r["skipped"]}
        self.assertEqual(reasons[str(loose)], "权限太宽，别人也能写")
        self.assertEqual(reasons[str(linked)], "是符号链接，没跟过去")
        self.assertEqual(reasons[str(foreign_dir)], "不是这个用户的")
        self.assertEqual(reasons[str(self.main / "b")], "不是这个用户的")
        used = self.sockets_used()
        for bad in (str(loose / "x"), str(self.other / "c"), str(foreign_dir / "y"), self.sock["b"], str(self.main / "link")):
            self.assertNotIn(bad, used)
        self.assertEqual(sorted({p.get("server") for p in r["panes"]}, key=str), [None, "a"])
        self.assertNotIn(str(self.dir / "missing"), r["looked"], "a directory that is not there is not reported as read")

    def test_ops_reach_exactly_their_own_server(self):
        a0 = self.pane("a", "%0"); b0 = self.pane("b", "%0")
        self.reset()
        read = self.h(op="tmuxRead", target=a0["pane_id"], identity=a0["identity"])
        self.assertEqual(read["text"], "on a")
        self.assertEqual(self.argvs()[-1], ["-u", "-S", self.sock["a"], "capture-pane", "-p", "-e", "-J", "-t", "%0", "-S", "-200"])
        # Before the read only that one server was listed again.
        self.assertEqual(set(self.sockets_used()), {self.sock["a"]})
        self.assertFalse(any("-S" not in a for a in self.argvs()), "the default server was not asked")
        self.reset()
        self.assertEqual(self.h(op="tmuxSend", id=UUID, target=b0["pane_id"], identity=b0["identity"], action="run", text="ls"),
                         {"sent": True, "receipt": UUID})
        self.assertEqual(self.argvs()[-2:], [["-u", "-S", self.sock["b"], "send-keys", "-t", "%0", "-l", "--", "ls"],
                                             ["-u", "-S", self.sock["b"], "send-keys", "-t", "%0", "Enter"]])
        self.reset()
        self.assertTrue(self.h(op="tmuxKill", id=UUID2, target=b0["pane_id"], identity=b0["identity"], scope="session")["closed"])
        self.assertEqual(self.argvs()[-1], ["-u", "-S", self.sock["b"], "kill-session", "-t", "$3"])

    def test_ids_and_identities_are_never_mixed_between_servers(self):
        d0, a0 = self.pane("default", "%0"), self.pane("a", "%0")
        for target, identity in (("%0", a0["identity"]), (a0["pane_id"], d0["identity"]),
                                 ("%0@" + "0" * 12, a0["identity"]), (a0["pane_id"].replace("%0", "%1"), a0["identity"])):
            self.reset()
            with self.subTest(target=target), self.assertRaisesRegex(bridge.BridgeError, "关了或换了"):
                self.h(op="tmuxRead", target=target, identity=identity)
            self.assertFalse(any("capture-pane" in a for a in self.argvs()))
        for bad in ("%0@" + "A" * 12, "%0@abc", "%0@" + "0" * 12 + "/x", "%0@@" + "0" * 12):
            with self.assertRaisesRegex(bridge.BridgeError, "Invalid tmux pane"):
                self.h(op="tmuxRead", target=bad, identity=a0["identity"])
        # A server that went away (its socket is still there but nothing answers): the pane is gone.
        self.state["servers"][self.sock["a"]] = {"dead": True}; self.save()
        with self.assertRaisesRegex(bridge.BridgeError, "关了或换了"):
            self.h(op="tmuxSend", id=UUID, target=a0["pane_id"], identity=a0["identity"], action="key", key="enter")

    def test_a_failing_or_hung_named_server_is_reported_not_fatal(self):
        self.state["servers"][self.sock["b"]] = {"rows": [], "fail": {"list-panes": "protocol version mismatch (client 8, server 7)"}}
        self.state["servers"][self.sock["c"]] = {"rows": [], "sleep": 3}
        self.save()
        with patch.object(bridge, "TMUX_NAMED_TIMEOUT", 0.5):
            started = time.monotonic()
            r = self.listing()
            self.assertLess(time.monotonic() - started, 2.5, "a hung server is not waited for")
        servers = {s["name"]: s for s in r["servers"]}
        self.assertEqual(servers["b"]["state"], "error"); self.assertIn("protocol version", servers["b"]["error"])
        self.assertEqual(servers["c"]["state"], "error"); self.assertIn("没有及时回应", servers["c"]["error"])
        self.assertEqual([p.get("server") for p in r["panes"]], [None, None, "a", "a"])

    def test_a_failing_default_server_does_not_hide_the_named_ones(self):
        self.state["servers"]["default"] = {"rows": [], "fail": {"list-panes": "protocol version mismatch (client 8, server 7)"}}; self.save()
        r = self.listing()
        self.assertEqual([p.get("server") for p in r["panes"]], ["a", "a", "b", "c"])
        default = next(s for s in r["servers"] if s["default"])
        self.assertEqual(default["state"], "error"); self.assertIn("protocol version", default["error"])
        # Aimed at the default server itself (a read, a create), the failure still stops the op.
        with self.assertRaisesRegex(bridge.BridgeError, "没创建：读不到 tmux"):
            self.h(op="tmuxNew", id=UUID, cwd="~/proj")
        with self.assertRaisesRegex(bridge.BridgeError, "protocol version"):
            self.h(op="tmuxRead", target="%0", identity="0" * 64)

    def test_new_sessions_stay_on_the_default_server(self):
        # "work" is a session on server "a" only: the default server may still get one of that name.
        info = self.h(op="tmuxInfo")
        self.assertEqual(info["sessions"], ["main"])
        self.reset()
        r = self.h(op="tmuxNew", id=UUID, name="work", cwd="~/proj")
        self.assertTrue(r["created"]); self.assertEqual(r["pane"]["pane_id"], "%2"); self.assertNotIn("server", r["pane"])
        new = next(a for a in self.argvs() if "new-session" in a)
        self.assertEqual(new[:3], ["-u", "new-session", "-d"]); self.assertNotIn("-S", new[:new.index("new-session")])
        self.assertFalse(self.sockets_used(), "creating never lists or touches the named servers")

    def test_status_and_follow_use_the_pane_server(self):
        r = self.h(op="status", target=self.pane("a", "%1")["pane_id"], identity="x")
        self.assertEqual(r, {"tmux": True, "agents": []})
        self.reset()
        follow = self.h(op="agents", target=self.pane("a", "%1")["pane_id"], identity="x")
        self.assertEqual(follow["state"], "exited")
        self.assertEqual(follow["pane"]["server"], "a")

    def test_nothing_running_says_where_it_looked(self):
        for key in self.state["servers"]: self.state["servers"][key] = {"dead": True}
        self.save()
        r = self.listing()
        self.assertEqual((r["available"], r["panes"]), (True, []))
        self.assertEqual(r["looked"], self.dirs)
        self.assertTrue(all(s["state"] == "none" for s in r["servers"]))
        # The default directory is reported even when it does not exist (tmux would put it there).
        self.dirs = [str(self.dir / "nothing" / "tmux-1"), str(self.other)]
        self.assertEqual(self.listing()["looked"], self.dirs)

    def test_socket_directories_follow_tmux(self):
        uid, name = os.getuid(), "tmux-%d" % os.getuid()
        dirs = TmuxServersTests._real_dirs   # the unpatched function: paths only, nothing is read
        with patch.dict(os.environ, {"TMUX_TMPDIR": "/srv/t/", "XDG_RUNTIME_DIR": "/run/user/%d" % uid}, clear=True), \
             patch.object(bridge.sys, "platform", "linux"):
            self.assertEqual(dirs(), ["/srv/t/" + name, "/tmp/" + name, "/run/user/%d/%s" % (uid, name)])
        with patch.dict(os.environ, {"TMUX_TMPDIR": "relative"}, clear=True), patch.object(bridge.sys, "platform", "darwin"):
            self.assertEqual(dirs(), ["/tmp/" + name, "/private/tmp/" + name, "/run/user/%d/%s" % (uid, name)])


TmuxServersTests._real_dirs = staticmethod(bridge.tmux_socket_dirs)


if __name__ == "__main__":
    unittest.main()
