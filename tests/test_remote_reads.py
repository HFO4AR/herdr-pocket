import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from test_bridge import bridge

REAL_RUN = subprocess.run
THREAD = "11111111-2222-3333-4444-555555555555"


class RemoteReadTests(unittest.TestCase):
    """Fast reads over a ch route. The other computer is a second temporary home reached through a
    fake ssh that runs the real remote command locally; no network, SSH, Herdr or agent is involved."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name) / "here"; self.home.mkdir()
        self.far = Path(tmp.name) / "there"; self.far.mkdir()
        hp = patch.object(bridge.Path, "home", return_value=self.home); hp.start(); self.addCleanup(hp.stop)
        project = self.far / ".claude/projects/-fixture"; project.mkdir(parents=True)
        (project / (THREAD + ".jsonl")).write_text(json.dumps({"type": "user", "sessionId": THREAD, "cwd": "/fixture", "message": {"content": "synthetic title"}}) + "\n")
        self.route = {"ssh": ["-p", "2222", "-S", "/home/user/.ssh/their-socket", "box"], "workspace": "/fixture", "key": "k"}
        self.ssh = []; self.mode = "run"
        run = patch.object(bridge.subprocess, "run", side_effect=self.fake_ssh); run.start(); self.addCleanup(run.stop)
        self.program, self.digest = bridge.remote_program()

    def fake_ssh(self, args, input=None, **kw):
        self.ssh.append((args, input))
        if "-O" in args: return subprocess.CompletedProcess(args, 0, b"", b"")
        if self.mode == "timeout": raise subprocess.TimeoutExpired(args, kw.get("timeout"))
        if self.mode == "down" or (self.mode == "stale" and "ControlMaster=auto" in args):
            return subprocess.CompletedProcess(args, 255, b"", b"mux_client_request_session: read from master failed")
        command = args[-1]
        self.assertEqual(command, bridge.REMOTE_COMMAND + " " + self.digest)
        return REAL_RUN(["python3", "-I", "-c", bridge.REMOTE_LOADER, self.digest], input=input, capture_output=True, timeout=30,
                        cwd=self.far, env={"HOME": str(self.far), "PATH": os.environ.get("PATH", "/usr/bin")})

    def read(self):
        return bridge.remote_read(self.route, {"op": "catalog", "workspace": "/fixture", "provider": "claude"})

    def helper(self):
        return self.far / ".herdr-pocket/bridge" / (self.digest + ".py")

    def test_first_read_installs_adapter_then_reuses_it(self):
        records = self.read()["records"]
        self.assertEqual([r["thread"] for r in records], [THREAD])
        self.assertEqual(len(self.ssh), 2)
        self.assertTrue(self.ssh[0][1].startswith(b"0\n"))                      # first: try the stored copy
        self.assertTrue(self.ssh[1][1].startswith(str(len(self.program)).encode() + b"\n" + self.program[:20]))
        self.assertEqual(self.helper().read_bytes(), self.program)
        self.assertEqual(stat.S_IMODE(self.helper().stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.helper().parent.stat().st_mode), 0o700)
        self.ssh.clear()
        self.assertEqual(self.read()["records"][0]["thread"], THREAD)
        self.assertEqual(len(self.ssh), 1)                                       # warm: no adapter shipped
        self.assertLess(len(self.ssh[0][1]), 1000)
        self.assertNotIn(b"synthetic", self.ssh[0][1])

    def test_ssh_options_use_our_own_control_socket_and_keep_safety(self):
        self.read()
        args = self.ssh[0][0]
        for option in ("BatchMode=yes", "StrictHostKeyChecking=yes", "ClearAllForwardings=yes", "ControlMaster=auto",
                       "ControlPath=" + str(self.home / ".herdr-pocket/ssh") + "/cm-%C", "ControlPersist=" + str(bridge.REMOTE_PERSIST)):
            self.assertIn(option, args)
        self.assertNotIn("-S", args)                                             # never the route's / user's socket
        self.assertNotIn("/home/user/.ssh/their-socket", args)
        self.assertEqual(args[-4:-1], ["-p", "2222", "box"])
        folder = self.home / ".herdr-pocket/ssh"
        self.assertEqual(stat.S_IMODE(folder.stat().st_mode), 0o700)
        self.assertNotIn("{", args[-1].split("'")[-1])                           # the request is not in the command

    def test_unsafe_control_folder_connects_without_reuse(self):
        elsewhere = self.home / "elsewhere"; elsewhere.mkdir()
        (self.home / ".herdr-pocket").mkdir(); (self.home / ".herdr-pocket/ssh").symlink_to(elsewhere)
        self.read()
        args = self.ssh[0][0]
        self.assertIn("ControlMaster=no", args); self.assertIn("ControlPath=none", args)
        self.assertNotIn("ControlMaster=auto", args)

    def test_tampered_or_linked_adapter_is_never_executed(self):
        self.read()
        self.helper().write_bytes(self.program.replace(b"def remote_main():", b"def remote_main():\n    print('{\"records\":[\"tampered\"]}');return\n", 1))
        self.ssh.clear()
        self.assertEqual(self.read()["records"][0]["thread"], THREAD)
        self.assertEqual(len(self.ssh), 2)                                       # hash mismatch: shipped again
        self.assertEqual(self.helper().read_bytes(), self.program)               # and repaired
        evil = self.far / "evil.py"; evil.write_bytes(self.program)
        self.helper().unlink(); self.helper().symlink_to(evil)
        self.ssh.clear(); self.read()
        self.assertEqual(len(self.ssh), 2)                                       # a symlink is refused
        self.assertFalse(self.helper().is_symlink())

    def test_old_adapter_versions_are_pruned(self):
        folder = self.far / ".herdr-pocket/bridge"; folder.mkdir(parents=True, mode=0o700)
        for n in range(5):
            old = folder / (("%x" % n) * 64 + ".py"); old.write_text("old"); os.utime(old, (n, n))
        keep = folder / "notes.txt"; keep.write_text("not ours")
        self.read()
        names = sorted(p.name for p in folder.iterdir())
        self.assertIn(self.digest + ".py", names); self.assertIn("notes.txt", names)
        self.assertEqual(len([n for n in names if n.endswith(".py")]), bridge.REMOTE_HELPER_KEEP)

    def test_timeout_drops_the_shared_connection(self):
        self.mode = "timeout"
        with self.assertRaisesRegex(bridge.BridgeError, "超时"): self.read()
        self.assertTrue(any("-O" in a and "exit" in a for a, _ in self.ssh))

    def test_stale_shared_socket_retries_once_unshared(self):
        self.mode = "stale"
        self.assertEqual(self.read()["records"][0]["thread"], THREAD)
        kinds = ["exit" if "-O" in a else "auto" if "ControlMaster=auto" in a else "no" for a, _ in self.ssh]
        self.assertEqual(kinds[:3], ["auto", "exit", "no"])
        self.mode = "down"; self.ssh.clear()
        with self.assertRaisesRegex(bridge.BridgeError, "连不上远端电脑"): self.read()
        self.assertEqual(len([a for a, _ in self.ssh if "-O" not in a]), 2)     # one retry, no loop

    def test_remote_history_page_and_error_message(self):
        catalog = self.read()["records"]
        page = bridge.remote_read(self.route, {"op": "history", "record_id": catalog[0]["id"], "workspace": "/fixture", "provider": "claude"})
        self.assertEqual(page["messages"][0]["text"], "synthetic title")
        with self.assertRaisesRegex(bridge.BridgeError, "历史记录已不存在"):
            bridge.remote_read(self.route, {"op": "history", "record_id": "f" * 64, "workspace": "/fixture", "provider": "claude"})


if __name__ == "__main__":
    unittest.main()
