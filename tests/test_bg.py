import json
import os
from pathlib import Path
import time
import unittest
from unittest.mock import patch
from test_bridge import bridge
import test_kids
from test_kids import KidsBase, claude, codex_row, iso, PARENT, CODEX_PARENT, PROJECT

# Synthetic fixtures only. The shapes follow what Claude Code (2.1.2xx) and Codex (0.16x) write:
# Bash results with toolUseResult.backgroundTaskId and "Output is being written to: …",
# Monitor results with {taskId, timeoutMs, persistent}, <task-notification> rows (queued and
# delivered copies of the same note, monitor <event>s, the after-restart orphan summary), Codex
# code-mode exec calls answering {"session_id": N} and CommandExecution item_completed rows.


def bash_use(use_id, command, description="", background=True, ts=None):
    args = {"command": command, "description": description}
    if background: args["run_in_background"] = True
    return claude("assistant", [{"type": "tool_use", "id": use_id, "name": "Bash", "input": args}], ts)


def bash_bg(use_id, task, out, ts=None, **extra):
    text = "Command running in background with ID: %s. Output is being written to: %s. You will be notified when it completes." % (task, out)
    return claude("user", [{"type": "tool_result", "tool_use_id": use_id, "content": text, "is_error": False}], ts,
                  toolUseResult=dict({"stdout": "", "stderr": "", "interrupted": False, "backgroundTaskId": task}, **extra))


def monitor_use(use_id, description, ts=None):
    return claude("assistant", [{"type": "tool_use", "id": use_id, "name": "Monitor", "input": {"command": "bash watch.sh", "description": description, "timeout_ms": 1800000}}], ts)


def monitor_started(use_id, task, persistent=False, ts=None):
    text = "Monitor started (task %s, expires in 30m unless the source ends first). You will be notified on each event." % task
    return claude("user", [{"type": "tool_result", "tool_use_id": use_id, "content": text}], ts,
                  toolUseResult={"taskId": task, "timeoutMs": 1800000, "persistent": persistent})


def note(body, queued=True, ts=None):
    text = "<task-notification>\n" + body + "\n</task-notification>"
    if queued: return {"type": "queue-operation", "operation": "enqueue", "timestamp": ts or iso(-60), "sessionId": PARENT, "content": text}
    return claude("user", text, ts)


def ended(task, use_id, status, summary, out=None):
    return ("<task-id>%s</task-id>\n<tool-use-id>%s</tool-use-id>\n" % (task, use_id) + ("<output-file>%s</output-file>\n" % out if out else "")
            + "<status>%s</status>\n<summary>%s</summary>" % (status, summary))


class BgBase(KidsBase):
    def setUp(self):
        super().setUp()
        self.tmp = self.home.parent / "tmp"
        self.tasks = self.tmp / ("claude-%d" % os.getuid()) / PROJECT / PARENT / "tasks"
        self.tasks.mkdir(parents=True)
        self.held = set()
        p = patch.object(bridge, "bg_held", side_effect=lambda: set(self.held)); p.start(); self.addCleanup(p.stop)

    def out(self, task, text=""):
        path = self.tasks / (task + ".output"); path.write_text(text)
        return str(path)

    def bg(self, provider="claude", path=None, thread=PARENT):
        bridge._kids_state = None
        path = path or self.home / ".claude/projects" / PROJECT / (PARENT + ".jsonl")
        try: return bridge.bg_report(path, provider, thread)
        finally: bridge.kids_save()

    def output(self, task, provider="claude", path=None, thread=PARENT):
        bridge._kids_state = None
        path = path or self.home / ".claude/projects" / PROJECT / (PARENT + ".jsonl")
        try: return bridge.bg_output({"provider": provider, "thread": thread, "task": task}, path)
        finally: bridge.kids_save()

    def by_id(self, report):
        return {x["id"]: x for x in report["items"]}


class ClaudeBgTests(BgBase):
    def test_shell_runs_until_its_notification(self):
        out = self.out("b1shell", "building…\n")
        self.claude_parent([claude("user", "synthetic ask"), bash_use("toolu_1", "npm run build", "Build the app"), bash_bg("toolu_1", "b1shell", out),
                            bash_use("toolu_2", "ls", background=False),
                            claude("user", [{"type": "tool_result", "tool_use_id": "toolu_2", "content": "a b"}], toolUseResult={"stdout": "a b"})])
        self.held.add(out)
        first = self.bg()
        self.assertEqual((first["total"], first["running"], first["hold"]), (1, 1, 1), "a plain Bash call is not background work")
        item = first["items"][0]
        self.assertEqual((item["kind"], item["title"], item["command"], item["state"], item["output"]), ("shell", "Build the app", "npm run build", "running", True))
        self.held.clear()
        # Both copies of the note (queued and delivered) are the same end.
        self.write(Path(self.home / ".claude/projects" / PROJECT / (PARENT + ".jsonl")),
                   [note(ended("b1shell", "toolu_1", "completed", 'Background command "Build the app" completed (exit code 0)', out)),
                    note(ended("b1shell", "toolu_1", "completed", 'Background command "Build the app" completed (exit code 0)', out), queued=False)], mode="a")
        done = self.bg()["items"][0]
        self.assertEqual((done["state"], done["exit"], done["running"]), ("completed", 0, False))
        self.assertIn("ended", done)

    def test_failed_killed_and_auto_backgrounded(self):
        rows = [claude("user", "synthetic"), bash_use("t1", "make test", "Tests"), bash_bg("t1", "bfail", self.out("bfail")),
                bash_use("t2", "sleep 900", "", background=False), bash_bg("t2", "bauto", self.out("bauto"), timedOutAfterMs=120000),
                bash_use("t3", "tail -f log", "Follow"), bash_bg("t3", "bstop", self.out("bstop")),
                note(ended("bfail", "t1", "failed", 'Background command "Tests" failed with exit code 130')),
                note(ended("bstop", "t3", "stopped", 'Task "tail -f log" was stopped by main session'))]
        self.claude_parent(rows)
        self.held.add(str(self.tasks / "bauto.output"))
        items = self.by_id(self.bg())
        self.assertEqual((items["bfail"]["state"], items["bfail"]["exit"]), ("failed", 130))
        self.assertEqual(items["bstop"]["state"], "killed")
        self.assertEqual((items["bauto"]["state"], items["bauto"]["title"], items["bauto"].get("auto")), ("running", "sleep 900", True))
        self.assertEqual([x["id"] for x in self.bg()["items"]][0], "bauto", "running first")

    def test_stopped_without_a_marker_and_old_tasks(self):
        """Claude's UI can stop a shell without writing anything: nobody holds its file any more."""
        old = iso(-13 * 3600)
        self.claude_parent([claude("user", "synthetic"), bash_use("t1", "watch", "Gone"), bash_bg("t1", "bgone", self.out("bgone")),
                            bash_use("t2", "loop", "Ancient", ts=old), bash_bg("t2", "bold", self.out("bold"), ts=old)])
        self.held.add(str(self.tasks / "bold.output"))
        items = self.by_id(self.bg())
        self.assertEqual(items["bgone"]["state"], "ended")
        self.assertEqual(items["bold"]["state"], "unknown", "no end record for 12 h: not believed")
        with patch.object(bridge, "bg_held", return_value=None):
            self.assertEqual(self.by_id(self.bg())["bgone"]["state"], "running", "without /proc the time bound decides")

    def test_monitor_events_expiry_and_hold(self):
        self.claude_parent([claude("user", "synthetic"), monitor_use("m1", "CI status"), monitor_started("m1", "bmon1"),
                            monitor_use("m2", "Forever"), monitor_started("m2", "bmon2", persistent=True),
                            note("<task-id>bmon1</task-id>\n<summary>Monitor event: &quot;CI status&quot;</summary>\n<event>step 1 &amp; 2 ok</event>"),
                            note("<task-id>bmon1</task-id>\n<summary>Monitor event: &quot;CI status&quot;</summary>\n<event>step 1 &amp; 2 ok</event>", queued=False)])
        self.held.update({str(self.tasks / "bmon1.output"), str(self.tasks / "bmon2.output")})
        report = self.bg(); items = self.by_id(report)
        self.assertEqual((report["running"], report["hold"]), (2, 1), "a persistent monitor never holds the agent")
        self.assertEqual((items["bmon1"]["kind"], items["bmon1"]["events"], items["bmon1"]["timeout"]), ("monitor", 1, 1800))
        live = self.output("bmon1")
        self.assertEqual((live["source"], live["text"]), ("events", "step 1 & 2 ok"))
        self.write(self.home / ".claude/projects" / PROJECT / (PARENT + ".jsonl"),
                   [note("<task-id>bmon1</task-id>\n<summary>Monitor event</summary>\n<event>[Monitor expired after 30m with 1 events delivered.]</event>")], mode="a")
        self.assertEqual(self.by_id(self.bg())["bmon1"]["state"], "completed")

    def test_orphan_summary_after_restart(self):
        self.claude_parent([claude("user", "synthetic"), bash_use("t1", "a", "A"), bash_bg("t1", "borph1", self.out("borph1")),
                            monitor_use("m1", "B"), monitor_started("m1", "borph2"),
                            note("<task-id>borph1</task-id>\n<task-id>borph2</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n"
                                 "<summary>2 background shell command tasks didn't finish before the previous session ended. Task ids: borph1, borph2.</summary>")])
        self.held.update({str(self.tasks / "borph1.output")})
        self.assertEqual({x["state"] for x in self.bg()["items"]}, {"killed"})

    def test_sub_agent_notifications_are_not_background_tasks(self):
        self.claude_parent([claude("user", "synthetic"),
                            note(ended("a123", "toolu_x", "completed", 'Agent "x" finished'))])
        self.assertEqual(self.bg()["total"], 0)

    def test_state_is_bounded(self):
        rows = [claude("user", "synthetic")]
        for n in range(bridge.BG_TASKS + 15):
            rows += [bash_use("t%d" % n, "echo %d" % n, ""), bash_bg("t%d" % n, "bb%d" % n, str(self.tasks / ("bb%d.output" % n))),
                     note(ended("bb%d" % n, "t%d" % n, "completed", "exit code 0"))]
        self.claude_parent(rows)
        report = self.bg()
        self.assertEqual(report["total"], bridge.BG_TASKS)
        self.assertEqual(len(report["items"]), bridge.BG_LIST)
        state = json.loads((self.home / ".local/state/herdr-pocket/kids-v1.json").read_text())
        entry = next(iter(state["bg"].values()))
        self.assertLessEqual(len(entry["p"]), bridge.BG_PEND)


class BgOutputTests(BgBase):
    def setUp(self):
        super().setUp()
        self.secret = self.home / "secret.txt"; self.secret.write_text("TOP SECRET\n")

    def launch(self, task, out, use="toolu_o"):
        self.claude_parent([claude("user", "synthetic"), bash_use(use, "make", "Build"), bash_bg(use, task, out)])

    def test_tail_is_bounded_and_clean(self):
        body = "".join("line %d\n" % n for n in range(20000)) + "\x1b[31mred\x1b[0m done\rDONE\n\x07bell\x00\n"
        self.launch("bout1", self.out("bout1", body))
        r = self.output("bout1")
        self.assertEqual(r["source"], "file")
        self.assertTrue(r["truncated"])
        self.assertLessEqual(len(r["text"].encode()), bridge.BG_OUTPUT)
        self.assertTrue(r["text"].startswith("line "), "starts at a whole line")
        self.assertTrue(r["text"].endswith("DONE\nbell\n"), r["text"][-40:])
        self.assertNotIn("\x1b", r["text"])

    def test_symlinked_output_file_is_refused(self):
        link = self.tasks / "blink.output"; link.symlink_to(self.secret)
        self.launch("blink", str(link))
        with self.assertRaises(bridge.BridgeError) as ctx: self.output("blink")
        self.assertNotIn("SECRET", str(ctx.exception))

    def test_symlinked_folder_is_refused(self):
        real = self.home / "elsewhere"; real.mkdir(); (real / "bdir.output").write_text("TOP SECRET")
        other = self.tmp / ("claude-%d" % os.getuid()) / PROJECT / PARENT / "x"; other.mkdir()
        os.rmdir(other); other.symlink_to(real)
        path = str(self.tasks.parent / "x" / ".." / "tasks" / "bdir.output")
        self.launch("bdir", path)
        with self.assertRaises(bridge.BridgeError): self.output("bdir")
        tasks_link = self.tmp / ("claude-%d" % os.getuid()) / PROJECT / "fake"; tasks_link.symlink_to(real.parent)
        self.assertIsNone(bridge.bg_output_path({"out": str(tasks_link / PARENT / "tasks" / "bdir.output")}, "bdir", PARENT))

    def test_only_the_recorded_path_of_this_task(self):
        # A path recorded for another task id, another session, another user's folder, or outside.
        foreign = self.out("bother", "other task")
        wrong_session = self.tmp / ("claude-%d" % os.getuid()) / PROJECT / "99999999-2222-4333-8444-555555555555" / "tasks"
        wrong_session.mkdir(parents=True); (wrong_session / "bses.output").write_text("x")
        other_uid = self.tmp / ("claude-%d" % (os.getuid() + 1)) / PROJECT / PARENT / "tasks"
        other_uid.mkdir(parents=True); (other_uid / "buid.output").write_text("x")
        self.claude_parent([claude("user", "synthetic"),
                            bash_use("u1", "a", "A"), bash_bg("u1", "bmine", foreign),
                            bash_use("u2", "b", "B"), bash_bg("u2", "bses", str(wrong_session / "bses.output")),
                            bash_use("u3", "c", "C"), bash_bg("u3", "buid", str(other_uid / "buid.output")),
                            bash_use("u4", "d", "D"), bash_bg("u4", "bhome", str(self.secret))])
        for task in ("bmine", "bses", "buid"):
            with self.assertRaises(bridge.BridgeError, msg=task): self.output(task)
        with self.assertRaises(bridge.BridgeError): self.output("bnotthere")
        with self.assertRaises(bridge.BridgeError): self.output("../../secret")
        # "bhome" never got a valid path recorded (the regex needs .output): no file is read.
        self.assertEqual(self.output("bhome")["text"], "")

    def test_request_goes_through_the_record(self):
        self.launch("bok", self.out("bok", "hello\n"))
        rel = PROJECT + "/" + PARENT + ".jsonl"
        base = {"v": 1, "op": "bgOutput", "provider": "claude", "thread": PARENT, "record_id": self.record_id("claude", rel), "cwd": "/work/demo"}
        self.assertEqual(bridge.handle(dict(base, task="bok"))["text"], "hello\n")
        with self.assertRaises(bridge.BridgeError): bridge.handle(dict(base, task="bok", record_id="0" * 64))
        with self.assertRaises(bridge.BridgeError): bridge.handle(dict(base, task="bok", thread="99999999-2222-4333-8444-555555555555"))


class GlanceBgTests(BgBase):
    def test_glance_history_and_watcher_carry_bg(self):
        out = self.out("bg1", "x\n"); self.held.add(out)
        self.claude_parent([claude("user", "synthetic"), bash_use("t1", "serve", "Dev server"), bash_bg("t1", "bg1", out)])
        rel = PROJECT + "/" + PARENT + ".jsonl"
        item = {"key": "s/a", "provider": "claude", "thread": PARENT, "record_id": self.record_id("claude", rel), "cwd": "/work/demo", "bg": True}
        first = bridge.handle({"v": 1, "op": "glance", "items": [item]})["previews"]["s/a"]
        self.assertEqual((first["bg"]["running"], first["bg"]["hold"]), (1, 1))
        same = bridge.handle({"v": 1, "op": "glance", "items": [dict(item, bg_stamp=first["bg"]["stamp"])]})["previews"]["s/a"]["bg"]
        self.assertEqual(same, {"same": True, "running": 1, "hold": 1})
        watch = bridge.handle({"v": 1, "op": "glance", "items": [dict(item, preview=False)]})["previews"]["s/a"]
        self.assertEqual(set(watch), {"kids_only", "bg"})
        self.assertNotIn("bg", bridge.handle({"v": 1, "op": "glance", "items": [dict(item, bg=False)]})["previews"]["s/a"])
        page = bridge.handle({"v": 1, "op": "history", "record_id": item["record_id"]})
        self.assertEqual(page["bg"]["items"][0]["title"], "Dev server")

    def test_screen_footer_counts(self):
        claude_screen = "❯ \n──────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent · 3 shells · 1 monitor\n"
        self.assertEqual(bridge.screen_bg(claude_screen)["count"], 4)
        self.assertEqual(bridge.screen_bg("› Ask Codex\n  2 background terminals running · /ps to view\n")["count"], 2)
        self.assertIsNone(bridge.screen_bg("› Ask Codex\n  ← for agents · ? for shortcuts\n"))
        self.assertIsNone(bridge.screen_bg("we discussed 5 shells\n" + "\n".join("x" for _ in range(10))), "only the bottom lines count")


class CodexBgTests(BgBase):
    def setUp(self):
        super().setUp()
        self.day = self.home / ".codex/sessions/2026/10/15"
        self.path = self.day / ("rollout-2026-10-15T09-00-00-" + CODEX_PARENT + ".jsonl")

    def chunk(self, **value):
        return {"type": "input_text", "text": json.dumps(dict({"chunk_id": "a1", "wall_time_seconds": 1.0, "original_token_count": 3}, **value))}

    def test_code_mode_terminal_runs_until_its_command_execution(self):
        code = 'const r=await Promise.allSettled([tools.exec_command({cmd:"npm run dev -- --port 5173",yield_time_ms:1000}),tools.exec_command({cmd:"cargo build",yield_time_ms:1000})]);r.forEach(text);'
        self.write(self.path, [
            codex_row("session_meta", {"id": CODEX_PARENT, "cwd": "/work/demo"}),
            codex_row("response_item", {"type": "custom_tool_call", "name": "exec", "call_id": "c1", "input": code}),
            codex_row("response_item", {"type": "custom_tool_call_output", "call_id": "c1", "output": [self.chunk(session_id=41001, output="ready on 5173\n"), self.chunk(session_id=41002, output="")]}),
            codex_row("response_item", {"type": "custom_tool_call", "name": "exec", "call_id": "c2", "input": 'text(await tools.write_stdin({session_id:41002,chars:"",yield_time_ms:5000}));'}),
            codex_row("response_item", {"type": "custom_tool_call_output", "call_id": "c2", "output": [self.chunk(session_id=41002, output="Compiling demo\n")]}),
            codex_row("event_msg", {"type": "item_completed", "item": {"type": "CommandExecution", "id": "exec-1", "process_id": "41002", "command": ["/bin/zsh", "-lc", "cargo build"],
                                                                       "aggregated_output": "Compiling demo\nFinished\n", "exit_code": 0, "status": "completed"}}),
            codex_row("event_msg", {"type": "item_completed", "item": {"type": "CommandExecution", "id": "exec-2", "process_id": "777", "command": ["ls"], "exit_code": 0, "status": "completed"}})])
        report = self.bg("codex", self.path, CODEX_PARENT); items = self.by_id(report)
        self.assertEqual((report["total"], report["running"], report["hold"]), (2, 1, 0), "Codex is never held: it does not resume on its own")
        self.assertEqual((items["41001"]["kind"], items["41001"]["command"], items["41001"]["state"]), ("terminal", "npm run dev -- --port 5173", "running"))
        self.assertEqual((items["41002"]["command"], items["41002"]["state"], items["41002"]["exit"]), ("cargo build", "completed", 0))
        self.assertEqual(self.output("41001", "codex", self.path, CODEX_PARENT)["text"], "ready on 5173\n")
        self.assertEqual(self.output("41002", "codex", self.path, CODEX_PARENT)["text"], "Compiling demo\nFinished\n")

    def test_plain_exec_command_and_failure(self):
        self.write(self.path, [
            codex_row("session_meta", {"id": CODEX_PARENT, "cwd": "/work/demo"}),
            codex_row("response_item", {"type": "function_call", "name": "exec_command", "call_id": "f1", "arguments": json.dumps({"cmd": "pytest -x"})}),
            codex_row("response_item", {"type": "function_call_output", "call_id": "f1", "output": "Chunk ID: 1\nProcess running with session ID 5150\nOutput:\ncollecting\n"}),
            codex_row("event_msg", {"type": "item_completed", "item": {"type": "CommandExecution", "process_id": "5150", "command": ["pytest -x"], "aggregated_output": "1 failed", "exit_code": 1, "status": "failed"}})])
        item = self.bg("codex", self.path, CODEX_PARENT)["items"][0]
        self.assertEqual((item["id"], item["command"], item["state"], item["exit"]), ("5150", "pytest -x", "failed", 1))

    def test_open_terminal_is_bounded_in_time(self):
        old = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() - 7 * 3600))
        self.write(self.path, [codex_row("session_meta", {"id": CODEX_PARENT, "cwd": "/work/demo"}),
                               codex_row("response_item", {"type": "function_call_output", "call_id": "f1", "output": "Process running with session ID 9"}, old)])
        self.assertEqual(self.bg("codex", self.path, CODEX_PARENT)["items"][0]["state"], "unknown")


class RemoteBgTests(test_kids.RemoteKidsTests):
    """ch panes: the same report and output come from the other computer through the stored helper."""

    def setUp(self):
        super().setUp()
        folder = self.far / ".claude/projects" / PROJECT
        tasks = self.far / "tmp" / ("claude-%d" % os.getuid()) / PROJECT / PARENT / "tasks"; tasks.mkdir(parents=True)
        (tasks / "bfar.output").write_text("\x1b[32mremote ok\x1b[0m\n")
        self.write(folder / (PARENT + ".jsonl"), [bash_use("toolu_far", "make", "Remote build"), bash_bg("toolu_far", "bfar", str(tasks / "bfar.output"))], mode="a")
        (self.far / "secret.txt").write_text("TOP SECRET")

    def test_remote_glance_and_output(self):
        context = {"session": "default", "target": "w1:p1", "identity": "x", "provider": "claude"}
        record = "remote:" + self.route["key"] + ":" + self.record
        item = {"key": "s/a", "provider": "claude", "thread": PARENT, "record_id": record, "remote": context, "bg": True}
        with patch.object(bridge, "route_for_context", return_value=self.route):
            out = bridge.handle({"v": 1, "op": "glance", "items": [item]})["previews"]["s/a"]
            self.assertNotIn("kids", out)
            self.assertEqual(out["bg"]["items"][0]["title"], "Remote build")
            r = bridge.handle({"v": 1, "op": "bgOutput", "provider": "claude", "thread": PARENT, "record_id": record, "remote": context, "task": "bfar"})
            self.assertEqual(r["text"], "remote ok\n")
            with self.assertRaises(bridge.BridgeError):
                bridge.handle({"v": 1, "op": "bgOutput", "provider": "claude", "thread": PARENT, "record_id": record, "remote": context, "task": "bnope"})
            with self.assertRaises(bridge.BridgeError):
                bridge.handle({"v": 1, "op": "bgOutput", "provider": "claude", "thread": PARENT, "record_id": "remote:other:" + self.record, "remote": context, "task": "bfar"})

    def test_remote_dispatch_reads_only_recorded_tasks(self):
        page = bridge.remote_read(self.route, {"op": "bgOutput", "provider": "claude", "thread": PARENT, "record_id": self.record, "task": "bfar"})
        self.assertEqual(page["source"], "file")
        with self.assertRaises(bridge.BridgeError):
            bridge.remote_read(self.route, {"op": "bgOutput", "provider": "claude", "thread": PARENT, "record_id": "0" * 64, "task": "bfar"})
        self.assertEqual(bridge.remote_dispatch({"op": "paneRun"}), {"error": "unknown remote op"})


# The sub-agent tests themselves run in test_kids; only the setup is shared.
for _name in [n for n in vars(test_kids.RemoteKidsTests) if n.startswith("test_")]:
    if _name not in vars(RemoteBgTests): setattr(RemoteBgTests, _name, None)


if __name__ == "__main__":
    unittest.main()
