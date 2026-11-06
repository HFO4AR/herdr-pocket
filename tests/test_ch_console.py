import json
import os
from pathlib import Path
import socket
import stat
import tempfile
import threading
import unittest
from unittest.mock import patch

from test_bridge import bridge

APPROVAL = "11111111-1111-4111-8111-111111111111"
OTHER = "22222222-2222-4222-8222-222222222222"
CANDIDATE = "a" * 32
BRIDGE_KEY = "b" * 64


class FakeConsole:
    """One request per connection, like `ch __control-serve`."""

    def __init__(self, path):
        self.requests = []
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.bind(str(path))
        os.chmod(path, 0o600)
        self.socket.listen()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        while True:
            try:
                connection, _ = self.socket.accept()
            except OSError:
                return
            with connection:
                data = b""
                while b"\n" not in data:
                    chunk = connection.recv(65536)
                    if not chunk:
                        break
                    data += chunk
                line, _, _ = data.partition(b"\n")
                try:
                    request = json.loads(line)
                except ValueError:
                    continue
                self.requests.append(request)
                reply = {"v": 1, "id": request.get("id", ""), "ok": True,
                         "result": {"seen": request.get("command")}}
                connection.sendall(json.dumps(reply).encode() + b"\n")

    def close(self):
        try:
            self.socket.close()
        except OSError:
            pass


class ChConsoleTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name) / "home"
        self.home.mkdir()
        self.base = self.home / "ch"
        self.control = self.base / "control"
        self.control.mkdir(parents=True)
        home = patch.object(bridge.Path, "home", return_value=self.home)
        home.start()
        self.addCleanup(home.stop)
        env = patch.dict(os.environ, {"CH_STATE_DIR": str(self.base),
                                      "XDG_DATA_HOME": str(self.home / "xdg")})
        env.start()
        self.addCleanup(env.stop)
        self.fake = None

    def pending(self, approval=APPROVAL, expires=None, pid=None, text="命令： ls\n在沙箱外运行",
                ports=None, standing=None, socket_path="/run/user/1000/ch/bridge.sock"):
        item = {"id": approval, "expires_at": expires or int(__import__("time").time()) + 120,
                "pid": pid if pid is not None else os.getpid(), "session": OTHER, "text": text,
                "queued_ms": int(__import__("time").time() * 1000), "asks": "读 /tmp"}
        if ports: item["ports"] = ports
        if standing is not None: item["standing"] = standing
        item["project"] = str(self.home / "project")
        item["socket"] = socket_path
        item["account"] = "local"
        folder = self.control / "pending"
        folder.mkdir(exist_ok=True)
        (folder / (approval + ".json")).write_text(json.dumps(item, ensure_ascii=False))
        return item

    def serve(self):
        self.fake = FakeConsole(self.control / "control.sock")
        self.addCleanup(self.fake.close)

    def test_summary_reads_pending_and_never_deletes(self):
        self.pending()
        expired = self.pending(approval=OTHER, expires=int(__import__("time").time()) - 1)
        summary = bridge.ch_summary()
        self.assertEqual(summary["count"], 1)
        self.assertEqual(summary["paused"], "running")
        self.assertTrue(summary["available"])
        self.assertTrue((self.control / "pending" / (expired["id"] + ".json")).exists())

    def test_paused_and_bridge_flags_are_reported(self):
        self.pending()
        (self.control / "paused").write_text("")
        self.assertEqual(bridge.ch_summary()["paused"], "paused")
        (self.control / "paused").unlink()
        key = __import__("hashlib").sha256(b"/run/user/1000/ch/bridge.sock").hexdigest()
        state = self.control / "bridge-state"
        state.mkdir()
        (state / (key + ".closed")).write_text("")
        approvals = bridge.ch_approvals()
        self.assertEqual(approvals["approvals"][0]["bridge_state"], "closed")
        self.assertFalse(approvals["approvals"][0]["approvable"])
        self.assertNotIn("socket", approvals["approvals"][0])
        self.assertNotIn("/run/user/1000/ch/bridge.sock", json.dumps(approvals))

    def test_a_decided_request_is_not_listed(self):
        self.pending()
        decisions = self.control / "decisions"
        decisions.mkdir()
        (decisions / APPROVAL).write_text("allow")
        self.assertEqual(bridge.ch_summary()["count"], 0)
        self.assertEqual(bridge.ch_approvals()["approvals"], [])

    def test_long_text_is_cut_and_flagged(self):
        self.pending(text="字" * (bridge.CH_APPROVAL_TEXT + 10))
        item = bridge.ch_approvals()["approvals"][0]
        self.assertTrue(item["truncated"])
        self.assertEqual(len(item["text"]), bridge.CH_APPROVAL_TEXT)
        self.assertFalse(item["approvable"])

    def test_symlinked_pending_file_is_ignored(self):
        target = self.home / "real.json"
        real = self.pending()
        target.write_text(json.dumps(real))
        (self.control / "pending" / (APPROVAL + ".json")).unlink()
        os.symlink(target, self.control / "pending" / (APPROVAL + ".json"))
        self.assertEqual(bridge.ch_summary()["count"], 0)

    def test_actions_are_mapped_to_the_server_command(self):
        self.serve()
        cases = [
            ({"action": "decide", "approval_id": APPROVAL, "decision": "allow"},
             {"op": "decide", "approval_id": APPROVAL, "decision": "allow"}),
            ({"action": "decide_and_open", "approval_id": APPROVAL},
             {"op": "decide_and_open", "approval_id": APPROVAL}),
            ({"action": "decide_standing", "approval_id": APPROVAL},
             {"op": "decide_standing", "approval_id": APPROVAL}),
            ({"action": "ports_open", "candidate": CANDIDATE, "ports": [3333]},
             {"op": "ports_open", "candidate": CANDIDATE, "ports": [3333]}),
            ({"action": "ports_close", "id": APPROVAL},
             {"op": "ports_close", "id": APPROVAL}),
            ({"action": "ports_extend", "id": APPROVAL},
             {"op": "ports_extend", "id": APPROVAL}),
            ({"action": "ports_extend_session", "id": APPROVAL},
             {"op": "ports_extend_session", "id": APPROVAL}),
            ({"action": "ports_close_session", "id": APPROVAL},
             {"op": "ports_close_session", "id": APPROVAL}),
            ({"action": "standing_remove", "id": APPROVAL},
             {"op": "standing_remove", "id": APPROVAL}),
            ({"action": "bridge_action", "bridge": BRIDGE_KEY, "bridge_do": "pause"},
             {"op": "bridge_action", "bridge": BRIDGE_KEY, "action": "pause"}),
            ({"action": "standing_add", "candidate": CANDIDATE, "kind": "port", "port": 3333},
             {"op": "standing_add", "candidate": CANDIDATE, "kind": "port", "port": 3333}),
            ({"action": "standing_add", "candidate": CANDIDATE, "kind": "ssh", "host": "build"},
             {"op": "standing_add", "candidate": CANDIDATE, "kind": "ssh", "host": "build"}),
            ({"action": "pause"}, {"op": "pause"}),
            ({"action": "resume"}, {"op": "resume"}),
            ({"action": "ports_close_all"}, {"op": "ports_close_all"}),
            ({"action": "ports_extend_all"}, {"op": "ports_extend_all"}),
            ({"action": "shutdown"}, {"op": "shutdown"}),
        ]
        for request, expected in cases:
            reply = bridge.ch_console_request(dict(request, request_id="test-id"))
            self.assertTrue(reply["ok"], request)
            self.assertEqual(self.fake.requests[-1]["command"], expected)
            self.assertEqual(self.fake.requests[-1]["id"], "test-id")

    def test_bad_actions_and_ids_are_refused_before_the_socket(self):
        for request in ({"action": "nope"},
                        {"action": "decide", "approval_id": "x", "decision": "allow"},
                        {"action": "decide", "approval_id": APPROVAL, "decision": "yes"},
                        {"action": "ports_open", "candidate": "x", "ports": [3333]},
                        {"action": "bridge_action", "bridge": BRIDGE_KEY, "bridge_do": "x"},
                        {"action": "standing_add", "candidate": CANDIDATE, "kind": "folder"}):
            with self.assertRaises(bridge.BridgeError):
                bridge.ch_console_request(request)

    def test_missing_ch_is_explained(self):
        home = patch.object(bridge, "find_executable", return_value=None)
        home.start()
        self.addCleanup(home.stop)
        with self.assertRaisesRegex(bridge.BridgeError, "没找到 ch"):
            bridge.ch_console_request({"action": "list"})

    def test_old_ch_is_told_apart_from_a_startup_failure(self):
        fake = self.home / "bin-ch"
        fake.write_text("#!/bin/sh\nexit 2\n")
        fake.chmod(0o755)
        patcher = patch.object(bridge, "find_executable", return_value=str(fake))
        patcher.start()
        self.addCleanup(patcher.stop)
        with self.assertRaisesRegex(bridge.BridgeError, "更新 ch"):
            bridge.ch_console_request({"action": "list"})

    def test_status_gets_the_summary_without_herdr(self):
        self.pending()
        result = bridge.with_ch_summary({"agents": []})
        self.assertEqual(result["ch"]["count"], 1)
        self.assertEqual(result["agents"], [])


if __name__ == "__main__":
    unittest.main()
