"""Starting a new agent from the phone. Herdr is a recorded fake: nothing is created for real."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_bridge import bridge

UUID = "12345678-1234-4234-8234-123456789012"


class CreateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / "home"; self.project = self.home / "work/site"; self.project.mkdir(parents=True)
        (self.home / ".ssh").mkdir()
        self.outside = Path(self.tmp.name) / "mnt/project"; self.outside.mkdir(parents=True)
        self.state = Path(self.tmp.name) / "state"
        self.calls = []
        self.start_errors = []        # HerdrRejected codes raised by successive `agent start` calls
        self.pane_after = {"pane_id": "w1:p9", "agent": "codex", "agent_status": "idle"}
        self.created = {"tab": {"tab_id": "w1:t5"}, "root_pane": {"pane_id": "w1:p9", "tab_id": "w1:t5", "workspace_id": "w1"}}
        self.create_error = None
        for target, value in ((bridge.Path, "home"),):
            p = patch.object(target, value, return_value=self.home); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, "call", side_effect=self.call); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, "find_executable", side_effect=lambda name: "/usr/bin/" + name); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, "transcript_catalog", return_value=[{"cwd": str(self.outside / "missing"), "modified": 5},
                                                                      {"cwd": "/tmp", "modified": 4}]); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge.time, "sleep", lambda s: None); p.start(); self.addCleanup(p.stop)

    def call(self, args, timeout=20):
        self.calls.append(args)
        cmd = args[2:]
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if cmd == ["workspace", "list"]:
            return {"workspaces": [{"workspace_id": "w1", "label": "site", "focused": True}, {"workspace_id": "w3", "label": "other"}]}
        if cmd[:2] == ["pane", "list"]:
            if cmd[-1] == "w1": return {"panes": [{"pane_id": "w1:p1", "cwd": str(self.project), "agent": "codex"},
                                                  {"pane_id": "w1:p2", "cwd": str(self.outside), "agent": None}]}
            return {"panes": [{"pane_id": "w3:p1", "cwd": str(self.home)}]}
        if cmd[:2] in (["tab", "create"], ["workspace", "create"]):
            if self.create_error: raise bridge.HerdrRejected(self.create_error, "nope")
            if cmd[0] == "workspace": return {"workspace": {"workspace_id": "w7"}, "tab": {"tab_id": "w7:t1"}, "root_pane": {"pane_id": "w7:p1"}}
            return self.created
        if cmd[:2] == ["agent", "start"]:
            if self.start_errors:
                code = self.start_errors.pop(0)
                if code == "TIMEOUT": raise bridge.BridgeError("Herdr timeout")
                raise bridge.HerdrRejected(code, "x")
            return {"type": "agent_started"}
        if cmd[:2] == ["pane", "get"]: return {"pane": self.pane_after}
        if cmd[:2] == ["pane", "run"]: return {"sent": True}
        raise AssertionError("unexpected herdr call " + repr(args))

    def req(self, **kw):
        r = dict(v=1, op="create", session="default", id=UUID, kind="codex", cwd=str(self.project), workspace="w1")
        r.update(kw); return r

    def mutations(self):
        return [a[2:] for a in self.calls if a[2:4] in (["tab", "create"], ["workspace", "create"], ["agent", "start"], ["pane", "run"])]

    def test_info_lists_kinds_workspaces_and_dirs(self):
        info = bridge.handle({"v": 1, "op": "createInfo", "session": "default"})
        self.assertEqual([k["kind"] for k in info["kinds"]], ["codex", "claude", "ch"])
        self.assertEqual([w["workspace_id"] for w in info["workspaces"]], ["w1", "w3"])
        paths = [d["path"] for d in info["dirs"]]
        self.assertEqual(paths[0], str(self.project))
        self.assertIn(str(self.outside), paths)
        self.assertNotIn("/tmp", paths)  # temp and missing history dirs are not offered
        self.assertEqual(self.mutations(), [])

    def test_codex_new_tab_and_start_with_generated_name(self):
        r = bridge.handle(self.req(), self.state)
        self.assertEqual((r["created"], r["state"], r["pane_id"], r["tab_id"], r["workspace_id"]), (True, "ready", "w1:p9", "w1:t5", "w1"))
        self.assertEqual(self.mutations()[0], ["tab", "create", "--workspace", "w1", "--cwd", str(self.project), "--no-focus"])
        start = self.mutations()[1]
        self.assertEqual(start[:7], ["agent", "start", "pocket-12345678", "--kind", "codex", "--pane", "w1:p9"])
        self.assertEqual(start[7], "--timeout")
        self.assertLessEqual(int(start[8]), 22000)
        self.assertNotIn("--", start)  # no agent arguments from the phone

    def test_receipt_never_replays(self):
        first = bridge.handle(self.req(), self.state)
        self.assertEqual(bridge.handle(self.req(), self.state), first)
        self.assertEqual(len(self.mutations()), 2)
        with self.assertRaisesRegex(bridge.BridgeError, "different content"):
            bridge.handle(self.req(kind="claude"), self.state)
        self.assertEqual(len(self.mutations()), 2)

    def test_unknown_outcome_is_not_retried(self):
        db, _ = bridge.receipt_open(self.state, UUID, __import__("hashlib").sha256(
            __import__("json").dumps(self.req(), sort_keys=True).encode()).hexdigest())
        db.close()  # crashed before saving any result
        with self.assertRaisesRegex(bridge.BridgeError, "结果未知"):
            bridge.handle(self.req(), self.state)
        self.assertEqual(self.mutations(), [])

    def test_new_workspace(self):
        r = bridge.handle(self.req(workspace="new"), self.state)
        self.assertEqual(self.mutations()[0], ["workspace", "create", "--cwd", str(self.project), "--no-focus"])
        self.assertEqual((r["pane_id"], r["workspace_id"], r["new_workspace"]), ("w7:p1", "w7", True))

    def test_ch_types_only_the_fixed_command_and_waits_for_claude(self):
        self.pane_after = {"pane_id": "w1:p9", "agent": "claude", "agent_status": "idle"}
        r = bridge.handle(self.req(kind="ch"), self.state)
        self.assertEqual(self.mutations()[1], ["pane", "run", "w1:p9", "ch new"])
        self.assertEqual(len(self.mutations()), 2)
        self.assertEqual((r["state"], r["detected"]), ("ready", True))

    def test_ch_not_detected_in_time_reports_starting(self):
        self.pane_after = {"pane_id": "w1:p9", "agent": None}
        clock = iter(range(0, 1000, 5))
        with patch.object(bridge.time, "monotonic", side_effect=lambda: next(clock)):
            r = bridge.handle(self.req(kind="ch"), self.state)
        self.assertEqual((r["created"], r["state"], r["detected"]), (True, "starting", False))

    def test_shell_not_ready_is_retried_then_blocked_startup(self):
        self.start_errors = ["agent_pane_unavailable", "agent_pane_unavailable"]
        r = bridge.handle(self.req(), self.state)
        self.assertEqual(r["state"], "ready")
        self.assertEqual(sum(m[:2] == ["agent", "start"] for m in self.mutations()), 3)
        self.start_errors = ["agent_not_ready"]; self.pane_after = {"agent": "codex", "agent_status": "blocked"}
        r = bridge.handle(self.req(id=UUID.replace("1234-4", "1234-5")), self.state)
        self.assertEqual(r["state"], "blocked")

    def test_start_failure_keeps_pane_and_says_so(self):
        self.start_errors = ["agent_start_failed"]; self.pane_after = {"agent": None}
        r = bridge.handle(self.req(), self.state)
        self.assertEqual((r["created"], r["state"], r["code"], r["typed"], r["pane_id"]), (True, "failed", "agent_start_failed", True, "w1:p9"))
        self.assertFalse(any(m[:2] in (["pane", "close"], ["tab", "close"]) for m in self.mutations()))

    def test_start_timeout_is_starting_not_failed(self):
        self.start_errors = ["TIMEOUT"]; self.pane_after = {"agent": None}
        self.assertEqual(bridge.handle(self.req(), self.state)["state"], "starting")
        self.start_errors = ["TIMEOUT"]; self.pane_after = {"agent": "codex", "agent_status": "idle"}
        self.assertEqual(bridge.handle(self.req(id=UUID.replace("1234-4", "1234-6")), self.state)["state"], "ready")

    def test_rejected_tab_creation_creates_nothing(self):
        self.create_error = "workspace_not_found"
        with self.assertRaisesRegex(bridge.BridgeError, "^没创建"):
            bridge.handle(self.req(), self.state)
        self.assertFalse(any(m[:2] == ["agent", "start"] for m in self.mutations()))

    def test_directory_rules(self):
        bad = ["relative/dir", str(self.project) + "/../site", str(self.home / "nope"), str(self.home / ".ssh"),
               str(Path(self.tmp.name)), "~/work/site\n", "", 5, str(self.project / "f")]
        (self.project / "f").write_text("x")
        for cwd in bad:
            with self.assertRaisesRegex(bridge.BridgeError, "没创建", msg=repr(cwd)):
                bridge.handle(self.req(cwd=cwd), self.state)
        self.assertEqual(self.mutations(), [])
        # ~ expands to $HOME; a directory outside $HOME is fine when a pane already uses it.
        self.assertEqual(bridge.handle(self.req(cwd="~/work/site"), self.state)["cwd"], str(self.project.resolve()))
        r = bridge.handle(self.req(cwd=str(self.outside), id=UUID.replace("1234-4", "1234-7")), self.state)
        self.assertEqual(r["cwd"], str(self.outside.resolve()))

    def test_symlink_escape_rejected(self):
        os.symlink(Path(self.tmp.name), self.home / "link")
        with self.assertRaisesRegex(bridge.BridgeError, "没创建"):
            bridge.handle(self.req(cwd=str(self.home / "link")), self.state)

    def test_strict_arguments(self):
        cases = [dict(kind="bash"), dict(kind="ch; rm -rf ~"), dict(workspace="w1:t1"), dict(workspace="--focus"),
                 dict(id="not-a-uuid"), dict(text="hi"), dict(args=["--yolo"]), dict(command="ls")]
        for kw in cases:
            with self.assertRaises(bridge.BridgeError, msg=repr(kw)):
                bridge.handle(self.req(**kw), self.state)
        with self.assertRaisesRegex(bridge.BridgeError, "不在了"):
            bridge.handle(self.req(workspace="w9"), self.state)
        self.assertEqual(self.mutations(), [])

    def test_missing_executable(self):
        with patch.object(bridge, "find_executable", return_value=None):
            with self.assertRaisesRegex(bridge.BridgeError, "没找到 ch"):
                bridge.handle(self.req(kind="ch"), self.state)
        self.assertEqual(self.mutations(), [])

    def test_offline_session_never_created(self):
        with self.assertRaises(bridge.BridgeError):
            bridge.handle(self.req(session="other"), self.state)
        self.assertEqual(self.mutations(), [])


if __name__ == "__main__":
    unittest.main()
