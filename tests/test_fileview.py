import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from test_bridge import bridge

REAL_RUN = subprocess.run
THREAD = "11111111-2222-3333-4444-555555555555"


class FileViewTests(unittest.TestCase):
    """fileView: one text file, read-only, under home or the conversation's project folder."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name).resolve()
        self.home = self.base / "home"; self.home.mkdir()
        self.project = self.base / "work/project"; self.project.mkdir(parents=True)
        self.outside = self.base / "elsewhere"; self.outside.mkdir()
        hp = patch.object(bridge.Path, "home", return_value=self.home); hp.start(); self.addCleanup(hp.stop)
        (self.project / "src").mkdir()
        (self.project / "src/app.js").write_text("const a = 1;\n// 中文注释\n")
        (self.outside / "secret.txt").write_text("not for the phone\n")

    def view(self, path, cwd=None, roots=()):
        return bridge.view_file(path, cwd, roots)

    def refused(self, path, text, cwd=None, roots=()):
        with self.assertRaises(bridge.BridgeError) as ctx: self.view(path, cwd, roots)
        self.assertIn(text, str(ctx.exception))

    def test_project_file_relative_absolute_and_home(self):
        r = self.view("src/app.js", str(self.project), [str(self.project)])
        self.assertEqual(r["text"], "const a = 1;\n// 中文注释\n")
        self.assertEqual(r["path"], str(self.project / "src/app.js"))
        self.assertFalse(r["truncated"]); self.assertFalse(r["binary"])
        self.assertEqual(self.view(str(self.project / "src/app.js"), None, [str(self.project)])["name"], "app.js")
        (self.home / "notes.md").write_text("# hi\n")
        self.assertEqual(self.view("~/notes.md")["text"], "# hi\n")
        self.assertEqual(self.view("notes.md")["text"], "# hi\n")          # relative to home without a cwd

    def test_outside_roots_is_refused(self):
        self.refused(str(self.outside / "secret.txt"), "只能查看项目目录或主目录")
        self.refused(str(self.project / "src/app.js"), "只能查看项目目录或主目录")   # project not a root here
        self.refused("../../elsewhere/secret.txt", "只能查看项目目录或主目录", str(self.project / "src"), [str(self.project)])
        self.refused("/etc/hostname", "只能查看项目目录或主目录", None, [str(self.project)])

    def test_symlink_escape_is_refused_but_links_inside_work(self):
        (self.project / "link.txt").symlink_to(self.outside / "secret.txt")
        self.refused("link.txt", "链接指向项目和主目录之外", str(self.project), [str(self.project)])
        (self.project / "dirlink").symlink_to(self.outside)
        self.refused("dirlink/secret.txt", "链接指向项目和主目录之外", str(self.project), [str(self.project)])
        (self.project / "inner.js").symlink_to(self.project / "src/app.js")
        self.assertEqual(self.view("inner.js", str(self.project), [str(self.project)])["path"], str(self.project / "src/app.js"))

    def test_sensitive_names_and_folders(self):
        cases = [".ssh/config", ".ssh/id_ed25519", ".gnupg/pubring.kbx", ".aws/credentials", ".config/gh/hosts.yml",
                 ".codex/auth.json", ".codex/config.toml", ".claude/.credentials.json", ".claude/settings.json", ".claude.json", "proj/.env", "proj/.env.local", "proj/id_rsa.pub",
                 "proj/server.pem", "proj/tls.key", "proj/release.keystore", "proj/keystore.properties", ".netrc", ".git-credentials"]
        for rel in cases:
            path = self.home / rel; path.parent.mkdir(parents=True, exist_ok=True); path.write_text("secret\n")
            self.refused("~/" + rel, "敏感文件")
        # A harmless link pointing at a secret is refused by where it really goes.
        (self.home / "innocent.txt").symlink_to(self.home / ".ssh/config")
        self.refused("~/innocent.txt", "敏感文件")
        # Look-alikes are fine.
        (self.home / "environment.md").write_text("ok\n"); (self.home / "keys.md").write_text("ok\n")
        (self.home / ".claude/CLAUDE.md").write_text("ok\n")
        self.assertEqual(self.view("~/.claude/CLAUDE.md")["text"], "ok\n")
        self.assertEqual(self.view("~/environment.md")["text"], "ok\n")
        self.assertEqual(self.view("~/keys.md")["text"], "ok\n")

    def test_size_cap_shows_the_first_part(self):
        big = self.home / "big.log"; big.write_bytes(("x" * 99 + "\n").encode() * 8000)       # 800 KB
        r = self.view("~/big.log")
        self.assertTrue(r["truncated"]); self.assertEqual(r["size"], 800000)
        self.assertEqual(r["shown"], bridge.VIEW_LIMIT); self.assertEqual(len(r["text"]), bridge.VIEW_LIMIT)
        # A multi-byte character cut at the limit is dropped, not shown as garbage.
        cjk = self.home / "cjk.txt"; cjk.write_bytes("汉".encode() * 200000)
        r = self.view("~/cjk.txt")
        self.assertTrue(r["truncated"]); self.assertNotIn("�", r["text"]); self.assertEqual(set(r["text"]), {"汉"})

    def test_binary_is_detected_and_not_sent(self):
        (self.home / "a.bin").write_bytes(b"\x7fELF\x02\x01\x00\x00" + os.urandom(4000))
        r = self.view("~/a.bin")
        self.assertTrue(r["binary"]); self.assertNotIn("text", r)
        (self.home / "latin.txt").write_bytes(bytes(range(128, 256)) * 40)
        self.assertTrue(self.view("~/latin.txt")["binary"])

    def test_directories_devices_pipes_and_missing(self):
        self.refused("~", "文件夹")
        self.refused(str(self.project), "文件夹", None, [str(self.project)])
        self.refused("~/nope.txt", "文件不存在")
        os.mkfifo(self.home / "pipe")
        self.refused("~/pipe", "不是普通文件")
        (self.home / "null").symlink_to("/dev/null")
        self.refused("~/null", "链接指向项目和主目录之外")
        self.refused("/dev/null", "不是普通文件", None, ["/dev"])                     # even inside a root, devices are refused
        self.refused("", "路径无效"); self.refused("a\0b", "路径无效")

    def test_root_slash_is_never_a_root(self):
        self.refused(str(self.outside / "secret.txt"), "只能查看", None, ["/"])

    def test_handle_uses_the_records_project_folder(self):
        claude = self.home / ".claude/projects/-work-project"; claude.mkdir(parents=True)
        (claude / (THREAD + ".jsonl")).write_text(json.dumps({"type": "user", "sessionId": THREAD, "cwd": str(self.project), "message": {"content": "t"}}) + "\n")
        record = next(x for x in bridge.transcript_catalog(write_cache=False) if x["thread"] == THREAD)["id"]
        req = {"v": 1, "op": "fileView", "path": "src/app.js", "cwd": str(self.project), "record_id": record, "provider": "claude"}
        self.assertEqual(bridge.handle(req)["text"], "const a = 1;\n// 中文注释\n")
        # Without the record the project (outside home) is not readable; a client cwd is no root.
        with self.assertRaises(bridge.BridgeError): bridge.handle(dict(req, record_id=None))
        with self.assertRaises(bridge.BridgeError): bridge.handle(dict(req, provider="other"))


class RemoteFileViewTests(unittest.TestCase):
    """The same rules on the other computer of a ch route, through the stored adapter."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        base = Path(tmp.name).resolve()
        self.home = base / "here"; self.home.mkdir()
        self.far = base / "there"; self.far.mkdir()
        self.outside = base / "outside"; self.outside.mkdir(); (self.outside / "x.txt").write_text("no\n")
        hp = patch.object(bridge.Path, "home", return_value=self.home); hp.start(); self.addCleanup(hp.stop)
        self.workspace = self.far / ".local/share/ch/workspaces/w1"; self.workspace.mkdir(parents=True)
        (self.workspace / "README.md").write_text("远端的说明\n")
        (self.far / ".ssh").mkdir(); (self.far / ".ssh/id_rsa").write_text("KEY\n")
        self.route = {"ssh": ["-p", "2222", "box"], "workspace": "~/.local/share/ch/workspaces/w1", "key": "k" * 24}
        rp = patch.object(bridge, "route_for_context", return_value=self.route); rp.start(); self.addCleanup(rp.stop)
        self.sent = []
        run = patch.object(bridge.subprocess, "run", side_effect=self.fake_ssh); run.start(); self.addCleanup(run.stop)
        self.program, self.digest = bridge.remote_program()

    def fake_ssh(self, args, input=None, **kw):
        if "-O" in args: return subprocess.CompletedProcess(args, 0, b"", b"")
        self.assertEqual(args[-1], bridge.REMOTE_COMMAND + " " + self.digest)
        self.sent.append(input)
        return REAL_RUN(["python3", "-I", "-c", bridge.REMOTE_LOADER, self.digest], input=input, capture_output=True, timeout=30,
                        cwd=self.far, env={"HOME": str(self.far), "PATH": os.environ.get("PATH", "/usr/bin")})

    def view(self, path, **extra):
        return bridge.handle({"v": 1, "op": "fileView", "path": path, "remote": {"session": "s", "target": "w1:p1", "identity": "i", "provider": "claude"}, **extra})

    def test_reads_on_the_far_side_relative_to_the_workspace(self):
        r = self.view("README.md", cwd=str(self.workspace))
        self.assertEqual(r["text"], "远端的说明\n")
        self.assertEqual(r["path"], str(self.workspace / "README.md"))
        self.assertFalse((self.home / ".local/share/ch/workspaces/w1/README.md").exists())
        self.assertEqual(self.view("~/.local/share/ch/workspaces/w1/README.md")["text"], "远端的说明\n")
        # The request travels on stdin, never in the command.
        self.assertIn(b'"op": "fileView"', self.sent[-1])

    def test_same_refusals_on_the_far_side(self):
        for path, text in (("~/.ssh/id_rsa", "敏感文件"), (str(self.outside / "x.txt"), "只能查看项目目录或主目录"), ("~/missing.txt", "文件不存在")):
            with self.assertRaises(bridge.BridgeError) as ctx: self.view(path)
            self.assertIn(text, str(ctx.exception))
        (self.far / "link").symlink_to(self.outside / "x.txt")
        with self.assertRaises(bridge.BridgeError) as ctx: self.view("~/link")
        self.assertIn("链接指向项目和主目录之外", str(ctx.exception))

    def test_far_side_size_cap(self):
        (self.far / "big.txt").write_bytes(b"y" * (bridge.VIEW_LIMIT + 5000))
        r = self.view("~/big.txt")
        self.assertTrue(r["truncated"]); self.assertEqual(len(r["text"]), bridge.VIEW_LIMIT)


if __name__ == "__main__":
    unittest.main()
