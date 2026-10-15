from contextlib import closing
import hashlib
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
from test_bridge import bridge

REAL_RUN = subprocess.run


class FileTests(unittest.TestCase):
    """Sending files. The other computer of a ch route is a second temporary home, reached through
    a fake ssh that runs the same remote program locally; no real SSH, Herdr or agent is involved."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name) / "here"; self.home.mkdir()
        self.far = Path(tmp.name) / "there"; self.far.mkdir()
        self.state = self.home / "state"
        hp = patch.object(bridge.Path, "home", return_value=self.home); hp.start(); self.addCleanup(hp.stop)
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term_test", "agent": "codex", "agent_status": "idle"}
        self.commands = []
        call = patch.object(bridge, "call", side_effect=self.call); call.start(); self.addCleanup(call.stop)
        self.probe = {"ok": True, "route": None, "remote": False}
        probe = patch.object(bridge, "probe_pane", side_effect=lambda *a: self.probe); probe.start(); self.addCleanup(probe.stop)
        self.ssh = []
        run = patch.object(bridge.subprocess, "run", side_effect=self.fake_ssh); run.start(); self.addCleanup(run.stop)
        self.day = time.strftime("%Y-%m-%d", time.gmtime())
        self.data = b"%PDF-1.4\n" + os.urandom(3000)
        self.sha = hashlib.sha256(self.data).hexdigest()
        self.name = self.upload("设计 说明 v2.pdf", self.data)
        self.route = {"ssh": ["-p", "2222", "box"], "workspace": "~/.local/share/ch/workspaces/x", "key": "k"}

    def upload(self, name, data):
        """What the phone's SFTP upload leaves behind."""
        sha = hashlib.sha256(data).hexdigest()
        folder = self.home / ".herdr-pocket/uploads" / self.day / sha[:16]
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(data)
        return self.day + "/" + sha[:16] + "/" + name

    def call(self, args):
        self.commands.append(args)
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
        return {"text": "ok"}

    def fake_ssh(self, args, input=None, **kw):
        """The safe ssh options and the route are checked; the program runs with the far home."""
        self.ssh.append(args)
        self.assertEqual(args[:len(bridge.SAFE_SSH)], bridge.SAFE_SSH)
        self.assertEqual(args[len(bridge.SAFE_SSH):-1], self.route["ssh"])
        self.assertEqual(args[-1], bridge.REMOTE_FILE_COMMAND)
        if getattr(self, "ssh_down", False): return subprocess.CompletedProcess(args, 255, b"", b"denied")
        program = args[-1].split("'")[1]
        return REAL_RUN(["python3", "-c", program], input=input, capture_output=True, timeout=30,
                        env={"HOME": str(self.far), "PATH": os.environ.get("PATH", "/usr/bin")})

    def item(self, name=None, sha=None):
        return {"name": name or self.name, "sha256": sha or self.sha}

    def request(self, op, **extra):
        return dict(v=1, op=op, session="default", target="w1:p1", identity=bridge.identity(self.agent), **extra)

    def prompt(self, text="帮我看看这份文档", files=None, rid="12345678-1234-1234-1234-123456789012", **extra):
        return self.request("prompt", text=text, files=files if files is not None else [self.item()], id=rid, **extra)

    def sent(self):
        return [c for c in self.commands if "prompt" in c]

    def receipts(self):
        path = self.state / "receipts.sqlite"
        if not path.exists(): return []
        with closing(sqlite3.connect(path)) as db: return db.execute("SELECT id FROM receipts").fetchall()

    def test_local_pane_gets_the_absolute_path_with_the_original_name(self):
        local = self.home / ".herdr-pocket/uploads" / self.name
        self.assertEqual(bridge.handle(self.request("stageFile", **self.item()), self.state), {"remote": False, "path": str(local)})
        req = self.prompt()
        first = bridge.handle(req, self.state)
        self.assertEqual(bridge.handle(req, self.state), first)
        self.assertEqual(len(self.sent()), 1)
        self.assertEqual(self.sent()[0][-1], "帮我看看这份文档\n\n[文件] " + str(local))
        self.assertEqual(first["text"], self.sent()[0][-1])
        self.assertEqual(self.ssh, [])

    def test_files_only_and_with_pictures(self):
        bridge.handle(self.prompt(text=""), self.state)
        self.assertTrue(self.sent()[0][-1].startswith("[文件] /"))
        picture = b"\x89PNG" + os.urandom(64); psha = hashlib.sha256(picture).hexdigest()
        (self.home / ".herdr-pocket/uploads" / self.day / (psha + ".png")).write_bytes(picture)
        log = self.upload("build.log", b"error: boom\n")
        req = self.prompt(text="对比", files=[self.item(), self.item(log, hashlib.sha256(b"error: boom\n").hexdigest())],
                          images=[{"name": self.day + "/" + psha + ".png", "sha256": psha}], rid="22345678-1234-1234-1234-123456789012")
        lines = bridge.handle(req, self.state)["text"].split("\n")
        self.assertEqual([x.split(" ")[0] for x in lines], ["对比", "", "[图片]", "[文件]", "[文件]"])
        self.assertTrue(lines[-1].endswith("/build.log"))

    def test_bad_files_are_not_sent_and_leave_no_receipt(self):
        prefix = self.sha[:16]
        bad = [[{"name": self.day + "/" + prefix + "/../../../.ssh/id_rsa", "sha256": self.sha}],
               [{"name": "../" + self.name, "sha256": self.sha}],
               [{"name": self.day + "/" + prefix + "/.bashrc", "sha256": self.sha}],
               [{"name": self.day + "/" + prefix + "/a\nb.txt", "sha256": self.sha}],
               [{"name": self.day + "/" + prefix + "/x‮exe.txt", "sha256": self.sha}],
               [self.item(sha="0" * 64)],  # hash does not carry the folder prefix
               [self.item(sha=prefix + "0" * 48)],  # right prefix, wrong content
               [self.item(name=self.day + "/" + prefix + "/missing.pdf")],
               [self.item()] * 5, [], "x"]
        for files in bad:
            with self.assertRaises(bridge.BridgeError, msg=repr(files)):
                bridge.handle(self.prompt(files=files), self.state)
        outside = self.home / "secret.txt"; outside.write_bytes(self.data)
        link = self.home / ".herdr-pocket/uploads" / self.day / prefix / "link.pdf"; link.symlink_to(outside)
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：文件「link.pdf」还没传到"):
            bridge.handle(self.prompt(files=[self.item(name=self.day + "/" + prefix + "/link.pdf")]), self.state)
        (self.home / ".herdr-pocket/uploads" / self.name).write_bytes(self.data + b"!")
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：电脑上的「设计 说明 v2.pdf」和手机上的不一致"):
            bridge.handle(self.prompt(), self.state)
        self.assertEqual(self.sent(), [])
        self.assertEqual(self.receipts(), [])

    def test_name_rules(self):
        for ok in ("report.pdf", "设计 说明 v2.pdf", "a" * 180, "日志（3）.tar.gz", "-dash.txt", "x.y.z"):
            self.assertTrue(bridge.file_name_ok(ok), ok)
        for bad in ("", ".", "..", ".env", " lead.txt", "trail.txt ", "a/b", "a\\b", "tab\t.txt", "zw​.txt",
                    "rtl‮.txt", "line .txt", "a" * 181, "长" * 61, 5, None):
            self.assertFalse(bridge.file_name_ok(bad), repr(bad))

    def test_check_after_upload_removes_a_wrong_copy(self):
        check = lambda **kw: bridge.handle(dict(v=1, op="fileCheck", **kw))
        self.assertEqual(check(**self.item()), {"match": True, "size": len(self.data)})
        path = self.home / ".herdr-pocket/uploads" / self.name
        path.write_bytes(b"truncated")
        self.assertEqual(check(**self.item()), {"match": False})
        self.assertFalse(path.exists())
        self.assertEqual(check(**self.item()), {"match": False, "missing": True})
        with self.assertRaises(bridge.BridgeError): check(name="../x/" + self.sha[:16] + "/a", sha256=self.sha)

    def test_info_reports_size_or_cleaned_up(self):
        gone = "2020-01-01/" + "c" * 16 + "/old.zip"
        got = bridge.handle(dict(v=1, op="fileInfo", names=[self.name, gone, "../../etc/passwd", "x"]))
        self.assertEqual(got, {"files": {self.name: {"size": len(self.data)}, gone: {"gone": True}}})
        with self.assertRaises(bridge.BridgeError): bridge.handle(dict(v=1, op="fileInfo", names=["x"] * 61))

    def test_ch_route_copies_into_the_remote_uploads_folder_then_names_that_path(self):
        self.probe = {"ok": True, "route": self.route, "remote": True}
        # Not staged yet: refused, nothing sent, no receipt.
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：文件「设计 说明 v2.pdf」还没传到远端电脑"):
            bridge.handle(self.prompt(), self.state)
        self.assertEqual((self.sent(), self.receipts()), ([], []))
        staged = bridge.handle(self.request("stageFile", **self.item()), self.state)
        remote = self.far / ".herdr-pocket/uploads" / self.name
        self.assertEqual(staged, {"remote": True, "path": str(remote)})
        self.assertEqual(remote.read_bytes(), self.data)
        self.assertEqual(stat.S_IMODE(remote.stat().st_mode), 0o600)
        for folder in (remote.parent, remote.parent.parent, self.far / ".herdr-pocket/uploads"):
            self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
        # Staging again is harmless; no temporary files are left.
        self.assertEqual(bridge.handle(self.request("stageFile", **self.item()), self.state), staged)
        self.assertEqual([p.name for p in remote.parent.parent.iterdir()], [self.sha[:16]])
        bridge.handle(self.prompt(), self.state)
        self.assertEqual(self.sent()[0][-1], "帮我看看这份文档\n\n[文件] " + str(remote))
        self.assertEqual(self.sent()[0][-2], "w1:p1")
        # Only the remote tree under ~/.herdr-pocket/uploads was written.
        self.assertEqual(sorted(str(p.relative_to(self.far)) for p in self.far.rglob("*")),
                         [".herdr-pocket", ".herdr-pocket/uploads", ".herdr-pocket/uploads/" + self.day,
                          ".herdr-pocket/uploads/" + self.day + "/" + self.sha[:16], ".herdr-pocket/uploads/" + self.name])

    def test_remote_never_overwrites_a_different_file_and_refuses_links(self):
        self.probe = {"ok": True, "route": self.route, "remote": True}
        remote = self.far / ".herdr-pocket/uploads" / self.name
        remote.parent.mkdir(parents=True); remote.write_bytes(b"someone else's")
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：远端已有同名的不同文件"):
            bridge.handle(self.request("stageFile", **self.item()), self.state)
        self.assertEqual(remote.read_bytes(), b"someone else's")
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：文件「设计 说明 v2.pdf」还没传到远端电脑"):
            bridge.handle(self.prompt(), self.state)
        # A symlinked day folder on the other computer is not written through.
        elsewhere = self.far / "elsewhere"; elsewhere.mkdir()
        (self.far / ".herdr-pocket/uploads" / self.day).rename(self.far / "old-day")
        (self.far / ".herdr-pocket/uploads" / self.day).symlink_to(elsewhere)
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：上传目录异常"):
            bridge.handle(self.request("stageFile", **self.item()), self.state)
        self.assertEqual(list(elsewhere.iterdir()), [])
        self.assertEqual((self.sent(), self.receipts()), ([], []))

    def test_unreachable_route_and_plain_ssh_pane_send_nothing(self):
        self.probe = {"ok": True, "route": self.route, "remote": True}
        self.ssh_down = True
        for req in (self.request("stageFile", **self.item()), self.prompt()):
            with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：连不上远端电脑"):
                bridge.handle(req, self.state)
        self.probe = {"ok": True, "route": None, "remote": True}
        for req in (self.request("stageFile", **self.item()), self.prompt()):
            with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：这个窗格连着别的电脑"):
                bridge.handle(req, self.state)
        self.probe = {"ok": True, "route": None, "remote": False}
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去"):
            bridge.handle(self.prompt(remote=True), self.state)
        self.assertEqual((self.sent(), self.receipts()), ([], []))

    def test_old_file_folders_are_pruned(self):
        root = self.home / ".herdr-pocket/uploads"
        old = root / "2020-01-01"; (old / ("d" * 16)).mkdir(parents=True)
        (old / ("d" * 16) / "old report.pdf").write_bytes(b"x"); (old / ("." + "e" * 32 + ".part")).write_bytes(b"x")
        mine = root / "2020-01-02"; (mine / "notes").mkdir(parents=True); (mine / "notes" / "keep.txt").write_text("mine")
        bridge.prune_uploads()
        self.assertFalse(old.exists())
        self.assertTrue((mine / "notes" / "keep.txt").exists())
        self.assertTrue((root / self.name).exists())


if __name__ == "__main__":
    unittest.main()
