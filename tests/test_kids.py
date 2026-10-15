import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
from test_bridge import bridge

# Synthetic fixtures only: the shapes follow what Claude Code and Codex write (tool ids, launch
# results, <task-notification> rows, subagents/*.meta.json, spawn_agent / FINAL_ANSWER, forked
# rollouts with task_started / task_complete), never real conversation content.
PARENT = "11111111-2222-4333-8444-555555555555"
CODEX_PARENT = "01a13593-4ac1-7312-b1cd-4f3c5ac17a1d"
CODEX_CHILD = "01a13e78-5710-7000-8000-000000000001"
PROJECT = "-work-demo"
REAL_RUN = subprocess.run


def iso(offset=0):
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + offset))


def claude(kind, content, ts=None, **extra):
    return {"type": kind, "timestamp": ts or iso(-600), "cwd": "/work/demo", "sessionId": PARENT, "message": {"role": kind, "content": content}, **extra}


def agent_use(use_id, description, background=True, ts=None):
    return claude("assistant", [{"type": "tool_use", "id": use_id, "name": "Agent",
                                 "input": {"description": description, "subagent_type": "general-purpose", "prompt": "synthetic", "run_in_background": background}}], ts)


def launched(use_id, agent_id, ts=None):
    return claude("user", [{"type": "tool_result", "tool_use_id": use_id, "content": [{"type": "text", "text": "Async agent launched successfully.\nagentId: " + agent_id}]}], ts,
                  toolUseResult={"isAsync": True, "status": "async_launched", "agentId": agent_id})


def finished(use_id, ts=None):
    return claude("user", [{"type": "tool_result", "tool_use_id": use_id, "content": [{"type": "text", "text": "synthetic report"}]}], ts)


def notification(agent_id, use_id, queued=True, ts=None):
    text = "<task-notification>\n<task-id>%s</task-id>\n<tool-use-id>%s</tool-use-id>\n<status>completed</status>\n</task-notification>" % (agent_id, use_id)
    if queued: return {"type": "queue-operation", "operation": "enqueue", "timestamp": ts or iso(-60), "sessionId": PARENT, "content": text}
    return claude("user", text, ts)


def child_rows(done):
    rows = [claude("user", "synthetic task", isSidechain=True),
            claude("assistant", [{"type": "tool_use", "id": "c1", "name": "Bash", "input": {"command": "true"}}], isSidechain=True)]
    rows[-1]["message"]["stop_reason"] = "tool_use"
    if done:
        rows.append(claude("user", [{"type": "tool_result", "tool_use_id": "c1", "content": "ok"}], isSidechain=True))
        rows.append(claude("assistant", [{"type": "text", "text": "synthetic summary"}], isSidechain=True))
        rows[-1]["message"]["stop_reason"] = "end_turn"
    return rows


def codex_row(kind, payload, ts=None):
    return {"type": kind, "timestamp": ts or iso(-600), "payload": payload}


class KidsBase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name) / "home"; self.home.mkdir()
        self.roots = [("codex", self.home / ".codex/sessions"), ("claude", self.home / ".claude/projects")]
        for _, root in self.roots: root.mkdir(parents=True)
        for target, value in (("transcript_roots", self.roots),):
            p = patch.object(bridge, target, return_value=value); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge.Path, "home", return_value=self.home); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, "_kids_state", None); p.start(); self.addCleanup(p.stop)

    def write(self, path, rows, age=None, mode="w"):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open(mode) as out: out.write("".join(json.dumps(r) + "\n" for r in rows))
        if age is not None: os.utime(path, (time.time() - age, time.time() - age))
        return path

    def claude_parent(self, rows):
        return self.write(self.home / ".claude/projects" / PROJECT / (PARENT + ".jsonl"), rows)

    def claude_child(self, agent_id, use_id, done, age, description="synthetic child"):
        folder = self.home / ".claude/projects" / PROJECT / PARENT / "subagents"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / ("agent-" + agent_id + ".meta.json")).write_text(json.dumps({"agentType": "general-purpose", "description": description, "toolUseId": use_id}))
        return self.write(folder / ("agent-" + agent_id + ".jsonl"), child_rows(done), age)

    def report(self, provider="claude", path=None, thread=PARENT):
        bridge._kids_state = None   # every call is a fresh bridge process; state comes from the file
        path = path or self.home / ".claude/projects" / PROJECT / (PARENT + ".jsonl")
        try: return bridge.kids_report(path, provider, thread)
        finally: bridge.kids_save()

    def record_id(self, provider, rel):
        return hashlib.sha256((provider + ":" + rel).encode()).hexdigest()


class ClaudeKidsTests(KidsBase):
    def test_foreground_task_runs_until_its_result(self):
        self.claude_parent([claude("user", "synthetic ask"), agent_use("toolu_fg", "Check layout", background=False)])
        self.claude_child("a1", "toolu_fg", done=False, age=600, description="Check layout")   # long command: quiet for 10 min
        r = self.report()
        self.assertEqual((r["total"], r["running"]), (1, 1))
        self.assertEqual(r["items"][0]["title"], "Check layout")
        self.assertTrue(r["items"][0]["running"])
        self.write(self.home / ".claude/projects" / PROJECT / (PARENT + ".jsonl"), [finished("toolu_fg", iso(-5))], mode="a")
        self.claude_child("a1", "toolu_fg", done=True, age=200)
        r = self.report()
        self.assertEqual((r["total"], r["running"]), (1, 0))
        self.assertEqual(r["items"][0]["state"], "done")

    def test_background_agent_runs_until_its_notification(self):
        parent = self.claude_parent([agent_use("toolu_bg", "Background job"), launched("toolu_bg", "abc123")])
        self.claude_child("abc123", "toolu_bg", done=False, age=1200)     # past the "recently written" window
        self.assertEqual(self.report()["running"], 1)                     # the launch is still open
        self.write(parent, [notification("abc123", "toolu_bg", ts=iso(-1))], mode="a")
        r = self.report()
        self.assertEqual(r["running"], 0, "a queued <task-notification> closes it, even mid-turn (killed/failed)")
        # SendMessage to a finished agent resumes it.
        self.write(parent, [claude("assistant", [{"type": "tool_use", "id": "toolu_msg", "name": "SendMessage", "input": {"to": "abc123", "message": "more"}}], iso(0))], mode="a")
        self.claude_child("abc123", "toolu_bg", done=False, age=0)
        self.assertEqual(self.report()["running"], 1)
        self.write(parent, [notification("abc123", "toolu_bg", queued=False, ts=iso(5))], mode="a")
        self.claude_child("abc123", "toolu_bg", done=True, age=0)
        self.assertEqual(self.report()["running"], 0)

    def test_parent_is_scanned_incrementally(self):
        parent = self.claude_parent([agent_use("toolu_1", "One"), launched("toolu_1", "aa1")])
        self.claude_child("aa1", "toolu_1", done=False, age=1200)
        self.report()
        state = json.loads((self.home / ".local/state/herdr-pocket/kids-v1.json").read_text())
        entry = next(iter(state["parents"].values()))
        self.assertEqual(entry["off"], parent.stat().st_size)
        with patch.object(bridge, "claude_kid_row", wraps=bridge.claude_kid_row) as rows:
            self.report()
            self.assertEqual(rows.call_count, 0, "an unchanged parent is not read again")
            self.write(parent, [claude("assistant", [{"type": "text", "text": "noise"}]), notification("aa1", "toolu_1")], mode="a")
            self.assertEqual(self.report()["running"], 0)
            self.assertEqual(rows.call_count, 1, "only the new notification row is parsed")

    def test_recent_writes_count_and_stale_children_do_not(self):
        self.claude_parent([claude("user", "synthetic ask")])                 # no record of the launch (e.g. compacted)
        self.claude_child("n1", "toolu_gone", done=False, age=5)
        self.claude_child("n2", "toolu_old", done=False, age=bridge.KIDS_QUIET + 60)
        self.claude_child("n3", "toolu_done", done=True, age=5)
        r = self.report()
        self.assertEqual((r["total"], r["running"]), (3, 1))
        self.assertEqual([x["running"] for x in r["items"]], [True, False, False])

    def test_launch_without_transcript_yet_is_starting(self):
        self.claude_parent([agent_use("toolu_new", "Fresh helper", ts=iso(-3))])
        r = self.report()
        self.assertEqual((r["total"], r["running"]), (1, 1))
        self.assertEqual(r["items"][0]["state"], "starting")
        self.assertEqual(r["items"][0]["id"], "")

    def test_glance_and_history_carry_kids(self):
        self.claude_parent([claude("user", "synthetic ask"), agent_use("toolu_bg", "Background job"), launched("toolu_bg", "abc123")])
        child = self.claude_child("abc123", "toolu_bg", done=False, age=1200)
        rel = PROJECT + "/" + PARENT + ".jsonl"
        item = {"key": "s/a", "provider": "claude", "thread": PARENT, "record_id": self.record_id("claude", rel), "cwd": "/work/demo", "kids": True}
        first = bridge.handle({"v": 1, "op": "glance", "items": [item]})["previews"]["s/a"]
        self.assertEqual(first["kids"]["running"], 1)
        again = bridge.handle({"v": 1, "op": "glance", "items": [dict(item, stamp=first["stamp"])]})["previews"]["s/a"]
        self.assertTrue(again["same"]); self.assertEqual(again["kids"]["running"], 1, "kids come even when the preview is unchanged")
        watch = bridge.handle({"v": 1, "op": "glance", "items": [dict(item, preview=False)]})["previews"]["s/a"]
        self.assertEqual(set(watch), {"kids_only", "kids"})
        plain = bridge.handle({"v": 1, "op": "glance", "items": [dict(item, kids=False)]})["previews"]["s/a"]
        self.assertNotIn("kids", plain)
        page = bridge.handle({"v": 1, "op": "history", "record_id": item["record_id"]})
        self.assertEqual(page["kids"]["running"], 1)
        kid = bridge.handle({"v": 1, "op": "history", "record_id": page["kids"]["items"][0]["id"]})
        self.assertEqual(kid["kid"], {"running": True})
        self.assertEqual(kid["record"]["parent"], PARENT)
        self.assertNotIn("kids", bridge.handle({"v": 1, "op": "history", "record_id": item["record_id"], "before": page["before"]}))


class CodexKidsTests(KidsBase):
    def setUp(self):
        super().setUp()
        self.day = self.home / ".codex/sessions/2026/10/15"
        self.parent = self.write(self.day / ("rollout-2026-10-15T09-00-00-" + CODEX_PARENT + ".jsonl"), [
            codex_row("session_meta", {"id": CODEX_PARENT, "cwd": "/work/demo", "source": "cli"}),
            codex_row("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "synthetic ask"}]}),
            codex_row("response_item", {"type": "function_call", "name": "spawn_agent", "call_id": "s1", "arguments": json.dumps({"task_name": "layout_check", "message": "x"})}),
            codex_row("response_item", {"type": "function_call_output", "call_id": "s1", "output": json.dumps({"task_name": "/root/layout_check"})})])

    def child(self, marks, age):
        rows = [codex_row("session_meta", {"id": CODEX_CHILD, "parent_thread_id": CODEX_PARENT, "agent_path": "/root/layout_check", "cwd": "/work/demo",
                                           "source": {"subagent": {"thread_spawn": {"parent_thread_id": CODEX_PARENT, "agent_path": "/root/layout_check"}}}}),
                codex_row("response_item", {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "synthetic child task"}]})]
        rows += [codex_row("event_msg", {"type": m}) for m in marks]
        return self.write(self.day / ("rollout-2026-10-15T09-01-00-" + CODEX_CHILD + ".jsonl"), rows, age)

    def report(self):
        return super().report("codex", self.parent, CODEX_PARENT)

    def test_spawned_child_runs_until_its_turn_completes(self):
        self.child(["task_started"], age=900)                               # a long command in the child
        r = self.report()
        self.assertEqual((r["total"], r["running"]), (1, 1))
        self.assertEqual(r["items"][0]["role"], "layout_check")
        self.assertEqual(r["items"][0]["title"], "synthetic child task")
        self.child(["task_started", "task_complete"], age=1)
        self.assertEqual(self.report()["running"], 0, "a finished turn wins over a recent write")
        self.child(["task_started", "task_complete", "task_started"], age=1)  # followup_task
        self.assertEqual(self.report()["running"], 1)

    def test_final_answer_closes_and_unrelated_rollouts_are_ignored(self):
        self.write(self.day / "rollout-2026-10-15T09-02-00-01a13e78-5710-7000-8000-0000000000ff.jsonl",
                   [codex_row("session_meta", {"id": "other", "cwd": "/elsewhere", "source": "cli"})], age=1)
        child = self.child([], age=bridge.KIDS_QUIET + 60)                    # no turn markers: parent decides
        self.assertEqual(self.report()["running"], 1, "spawn_agent without FINAL_ANSWER is open")
        self.write(self.parent, [codex_row("response_item", {"type": "agent_message", "author": "/root/layout_check", "recipient": "/root",
                    "content": [{"type": "input_text", "text": "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/layout_check\nPayload:\n"}]}, iso(0))], mode="a")
        os.utime(child, (time.time() - 600, time.time() - 600))
        r = self.report()
        self.assertEqual((r["total"], r["running"]), (1, 0))
        state = json.loads((self.home / ".local/state/herdr-pocket/kids-v1.json").read_text())
        self.assertEqual(sorted(state["heads"].values()), ["", CODEX_PARENT], "first lines are read once and remembered")


class RemoteKidsTests(KidsBase):
    """ch panes: the report comes from the other computer through the stored remote helper."""

    def setUp(self):
        super().setUp()
        self.far = self.home.parent / "there"; self.far.mkdir()
        folder = self.far / ".claude/projects" / PROJECT
        self.write(folder / (PARENT + ".jsonl"), [claude("user", "synthetic ask"), agent_use("toolu_bg", "Remote job"), launched("toolu_bg", "abc123")])
        sub = folder / PARENT / "subagents"; sub.mkdir(parents=True)
        (sub / "agent-abc123.meta.json").write_text(json.dumps({"agentType": "general-purpose", "description": "Remote job", "toolUseId": "toolu_bg"}))
        self.write(sub / "agent-abc123.jsonl", child_rows(False), 1200)
        self.route = {"ssh": ["box"], "workspace": "/fixture", "key": "k" * 24}
        self.ssh = []
        run = patch.object(bridge.subprocess, "run", side_effect=self.fake_ssh); run.start(); self.addCleanup(run.stop)
        _, self.digest = bridge.remote_program()
        self.record = self.record_id("claude", PROJECT + "/" + PARENT + ".jsonl")

    def fake_ssh(self, args, input=None, **kw):
        self.ssh.append(args)
        if "-O" in args: return subprocess.CompletedProcess(args, 0, b"", b"")
        return REAL_RUN(["python3", "-I", "-c", bridge.REMOTE_LOADER, self.digest], input=input, capture_output=True, timeout=30,
                        cwd=self.far, env={"HOME": str(self.far), "PATH": os.environ.get("PATH", "/usr/bin")})

    def test_remote_kids_one_call_per_route_and_wrapped_records(self):
        context = {"session": "default", "target": "w1:p1", "identity": "x", "provider": "claude"}
        items = [{"key": "s/a", "provider": "claude", "thread": PARENT, "record_id": "remote:" + self.route["key"] + ":" + self.record, "remote": context, "kids": True},
                 {"key": "s/b", "provider": "claude", "thread": PARENT, "record_id": "remote:" + self.route["key"] + ":" + self.record, "remote": dict(context, target="w1:p2"), "kids": True}]
        with patch.object(bridge, "route_for_context", return_value=self.route):
            out = bridge.handle({"v": 1, "op": "glance", "items": items})["previews"]
        reads = [a for a in self.ssh if "-O" not in a]
        self.assertEqual(len([a for a in reads]), 2, "first read ships the helper once, still one route")
        self.assertTrue(out["s/a"]["kids_only"])
        report = out["s/a"]["kids"]
        self.assertEqual((report["total"], report["running"]), (1, 1))
        self.assertTrue(report["items"][0]["id"].startswith("remote:" + self.route["key"] + ":"))
        self.assertEqual(report["items"][0]["remote"], context)
        self.assertEqual(out["s/b"]["kids"]["items"][0]["remote"]["target"], "w1:p2")
        # Nothing running and nothing changed: the remote answers "same".
        stamp = report["stamp"]
        sub = self.far / ".claude/projects" / PROJECT / PARENT / "subagents" / "agent-abc123.jsonl"
        self.write(sub, child_rows(True), 1200)
        with patch.object(bridge, "route_for_context", return_value=self.route):
            done = bridge.handle({"v": 1, "op": "glance", "items": [dict(items[0], kids_stamp=stamp)]})["previews"]["s/a"]["kids"]
            self.assertEqual(done["running"], 0)
            same = bridge.handle({"v": 1, "op": "glance", "items": [dict(items[0], kids_stamp=done["stamp"])]})["previews"]["s/a"]["kids"]
        self.assertEqual(same, {"same": True})
        self.assertTrue((self.far / ".local/state/herdr-pocket/kids-v1.json").is_file())
        self.assertFalse((self.home / ".local/state/herdr-pocket/kids-v1.json").exists())

    def test_remote_failure_is_reported_per_item(self):
        with patch.object(bridge, "route_for_context", side_effect=bridge.BridgeError("远端窗格已改变，请刷新会话列表")):
            out = bridge.handle({"v": 1, "op": "glance", "items": [{"key": "s/a", "provider": "claude", "thread": PARENT, "record_id": "remote:x:" + self.record,
                                                                     "remote": {"target": "w1:p1"}, "kids": True}]})["previews"]
        self.assertIn("远端窗格已改变", out["s/a"]["kids_error"])
        self.assertEqual(self.ssh, [])

    def test_remote_dispatch_allows_only_reads(self):
        page = bridge.remote_read(self.route, {"op": "kids", "items": [{"key": "k", "provider": "claude", "thread": PARENT, "record_id": self.record}]})
        self.assertEqual(page["kids"]["k"]["running"], 1)
        self.assertEqual(bridge.remote_dispatch({"op": "prompt"}), {"error": "unknown remote op"})


if __name__ == "__main__":
    unittest.main()
