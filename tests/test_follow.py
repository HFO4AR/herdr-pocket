"""Following one pane: `agents` with a `target` re-resolves just that pane."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from test_bridge import bridge

OLD = "11111111-2222-3333-4444-555555555555"
NEW = "66666666-7777-8888-9999-000000000000"


def claude_rows(thread, text, cwd="/work/proj"):
    return [{"type": "user", "sessionId": thread, "cwd": cwd, "message": {"content": text}}]


def codex_rows(thread, text, cwd="/work/proj"):
    return [{"type": "session_meta", "payload": {"id": thread, "cwd": cwd}},
            {"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}}]


class FollowTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.roots = [("codex", self.home / "codex"), ("claude", self.home / "claude")]
        for _, root in self.roots: root.mkdir()
        for target, value in ((bridge, "transcript_roots"),):
            p = patch.object(target, value, return_value=self.roots); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge.Path, "home", return_value=self.home); p.start(); self.addCleanup(p.stop)
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term_a", "agent": "claude", "agent_status": "idle", "cwd": "/work/proj"}
        self.pane = None          # what `pane get` reports when the pane has no agent
        self.active = {OLD}       # Claude runtime session directory FD
        self.argv = ["claude"]
        self.commands = []
        p = patch.object(bridge, "call", side_effect=self.call); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, "process_snapshot", side_effect=self.snapshot); p.start(); self.addCleanup(p.stop)

    def call(self, args):
        self.commands.append(args)
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]: return {"agents": [self.agent] if self.agent else []}
        if "process-info" in args: return {"process_info": {"foreground_processes": [{"pid": 10, "argv": self.argv}]}}
        if args[-3:-1] == ["pane", "get"]:
            if self.pane is None: raise bridge.BridgeError(str({"code": "pane_not_found", "message": "pane not found"}))
            return {"pane": self.pane}
        raise AssertionError("unexpected herdr call " + repr(args))

    def snapshot(self, pid):
        return {"argv": self.argv, "children": [], "paths": [], "cwd": "/work/proj", "start": "1", "active_threads": sorted(self.active)}

    def write(self, provider, name, rows):
        path = dict(self.roots)[provider] / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        return path

    def follow(self, identity=None):
        return bridge.handle({"v": 1, "op": "agents", "session": "default", "target": "w1:p1",
                              "identity": identity or bridge.identity(self.agent or {})})

    def test_claude_clear_follows_runtime_session_directory(self):
        project = "-work-proj/"
        self.write("claude", project + OLD + ".jsonl", claude_rows(OLD, "旧对话"))
        self.write("claude", project + NEW + ".jsonl", claude_rows(NEW, "新对话"))
        before = self.follow()
        self.assertEqual(before["state"], "same")
        self.assertEqual(before["agents"][0]["history_ref"]["record"]["thread"], OLD)
        # /clear: same process, same Herdr identity, new runtime session directory.
        self.active = {NEW}
        after = self.follow()
        ref = after["agents"][0]["history_ref"]
        self.assertEqual((after["state"], ref["status"], ref["source"], ref["thread"]), ("same", "matched", "native-process", NEW))
        self.assertEqual(ref["record"]["title"], "新对话")
        self.assertNotIn("_path", json.dumps(ref, default=str))
        # The fast path only looks up the one file; no other pane is walked.
        self.assertEqual(sum("process-info" in c for c in self.commands), 2)

    def test_claude_new_session_without_transcript_is_pending(self):
        self.active = {NEW}
        ref = self.follow()["agents"][0]["history_ref"]
        self.assertEqual((ref["status"], ref["thread"]), ("pending", NEW))

    def test_startup_resume_argv_does_not_hide_clear(self):
        # The process was started with --resume OLD but now writes NEW.
        self.write("claude", "-work-proj/" + OLD + ".jsonl", claude_rows(OLD, "旧"))
        self.write("claude", "-work-proj/" + NEW + ".jsonl", claude_rows(NEW, "新"))
        self.argv = ["claude", "--resume", OLD]; self.active = {NEW}
        self.assertEqual(self.follow()["agents"][0]["history_ref"]["thread"], NEW)

    def test_codex_new_session_changes_identity_and_title_resolves(self):
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term_a", "agent": "codex", "agent_status": "idle", "cwd": "/work/proj",
                      "terminal_title": "旧任务 | proj", "agent_session": {"kind": "id", "value": OLD}}
        self.argv = ["codex", "resume", OLD]; self.active = set()
        self.write("codex", "a.jsonl", codex_rows(OLD, "旧任务"))
        self.write("codex", "b.jsonl", codex_rows(NEW, "新任务"))
        (self.home / ".codex").mkdir()
        (self.home / ".codex/session_index.jsonl").write_text(
            json.dumps({"id": OLD, "thread_name": "旧任务"}) + "\n" + json.dumps({"id": NEW, "thread_name": "新任务"}) + "\n")
        seen = bridge.identity(self.agent)
        # /new: Herdr reports the new session, the title follows; argv still says OLD.
        self.agent = dict(self.agent, terminal_title="新任务 | proj", agent_session={"kind": "id", "value": NEW})
        result = self.follow(seen)
        ref = result["agents"][0]["history_ref"]
        self.assertEqual(result["state"], "changed")
        self.assertNotEqual(result["agents"][0]["identity"], seen)
        self.assertEqual((ref["status"], ref["thread"], ref["source"]), ("matched", NEW, "title"))
        self.assertEqual(ref["record"]["thread"], NEW)

    def test_exited_agent_reports_plain_pane_without_reading_it(self):
        seen = bridge.identity(self.agent)
        self.agent = None
        self.pane = {"pane_id": "w1:p1", "terminal_id": "term_a", "agent": None, "cwd": "/work/proj",
                     "terminal_title_stripped": "~/proj", "agent_status": "unknown", "scroll": {"x": 1}}
        result = self.follow(seen)
        self.assertEqual((result["state"], result["agents"]), ("exited", []))
        self.assertEqual(result["pane"]["pane_id"], "w1:p1")
        self.assertNotIn("scroll", result["pane"])
        # The pane identity matches what paneRead/paneRun verify for plain panes.
        self.assertEqual(result["pane"]["identity"], bridge.identity(self.pane))
        self.assertFalse(any("read" in c for c in self.commands))
        self.assertFalse(any("process-info" in c for c in self.commands))

    def test_closed_pane_is_gone(self):
        self.agent = None; self.pane = None
        self.assertEqual(self.follow("x")["state"], "gone")

    def test_new_agent_in_same_pane_is_changed(self):
        seen = bridge.identity(self.agent)
        self.agent = dict(self.agent, agent="codex", terminal_title="")
        self.argv = ["codex"]; self.active = set()
        result = self.follow(seen)
        self.assertEqual(result["state"], "changed")
        self.assertEqual(result["agents"][0]["agent"], "codex")

    def test_target_is_validated_and_full_list_unchanged(self):
        with self.assertRaises(bridge.BridgeError):
            bridge.handle({"v": 1, "op": "agents", "session": "default", "target": "w1:p1; rm"})
        # Without a target `agents` still returns the full list (no `follow` marker).
        with patch.object(bridge, "transcript_catalog", return_value=[]):
            full = bridge.handle({"v": 1, "op": "agents", "session": "default"})
        self.assertNotIn("follow", full)
        self.assertEqual(len(full["agents"]), 1)

    def test_remote_route_resolves_only_this_route(self):
        route = {"ssh": ["host"], "workspace": "~/ws/route", "key": "k"}
        record = {"id": "a" * 64, "thread": NEW, "provider": "claude", "parent": None, "title": "远端", "cwd": "/r"}
        self.argv = ["ssh", "host", "exec ch __native-attach " + OLD]; self.active = set()
        reply = {"routes": {"~/ws/route": {"active": {"status": "matched", "thread": NEW}, "record": record, "candidates": []}}}
        with patch.object(bridge, "ch_ssh_route", return_value=route), \
             patch.object(bridge, "remote_read", return_value=reply) as read, \
             patch.object(bridge, "transcript_catalog", side_effect=AssertionError("no local scan for remote panes")):
            ref = self.follow()["agents"][0]["history_ref"]
        self.assertEqual(read.call_count, 1)
        self.assertEqual(read.call_args[0][1]["items"], [{"workspace": "~/ws/route", "provider": "claude"}])
        self.assertEqual((ref["status"], ref["thread"]), ("matched", NEW))
        self.assertTrue(ref["record"]["id"].startswith("remote:k:"))
        self.assertIsNone(bridge._remote_deadline)

    def test_mutations_still_verify_identity_after_session_switch(self):
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term_a", "agent": "codex", "agent_status": "idle",
                      "agent_session": {"kind": "id", "value": OLD}}
        seen = bridge.identity(self.agent)
        self.agent = dict(self.agent, agent_session={"kind": "id", "value": NEW})
        with tempfile.TemporaryDirectory() as state, self.assertRaises(bridge.BridgeError):
            bridge.handle({"v": 1, "op": "prompt", "session": "default", "target": "w1:p1", "identity": seen,
                           "text": "hi", "id": "12345678-1234-1234-1234-123456789012"}, Path(state))


if __name__ == "__main__":
    unittest.main()
