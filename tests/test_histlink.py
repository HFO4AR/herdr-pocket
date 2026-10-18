"""History links that stay put: a ch relay reconnecting, a remote read failing for a moment, a
ch transfer copy, and the person's own pick surviving restarts and failed auto-matches."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from test_bridge import bridge

CH = "5fce5692-ae33-5ace-ca33-0f2f2a89b9ab"
LIVE = "32105474-0a80-4535-978f-cadcab7b51b0"
OLD = "9a33cfea-b7d5-4b65-a9c2-c0363475ad56"
SSH = ["ssh", "-tt", "-o", "BatchMode=yes", "-p", "22", "-i", "/fixture/key", "user@fixture.invalid"]


def ssh(kind):
    return SSH + ["exec \"$HOME\"/'.local/bin/ch.route'  __native-" + kind + " '" + CH + "'"]


RELAY = ["python3", "-c", "relay", json.dumps(ssh("attach")), json.dumps(["ch", "share-image"]), json.dumps(ssh("reconnect")),
         json.dumps(["ch", "--host", "fixture", "resume", CH])]


def remote_record(route_key, thread=LIVE, title="远端"):
    return {"id": "remote:" + route_key + ":" + "a" * 64, "thread": thread, "provider": "claude", "parent": None, "title": title, "cwd": "/r",
            "remote": {"session": "default", "target": "w1:p1", "identity": "x", "provider": "claude"}}


class Pane(unittest.TestCase):
    """One Herdr pane whose process tree the test sets (`tree`: pid -> argv, children)."""
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name); self.state = self.home / "state"
        self.roots = [("codex", self.home / "codex"), ("claude", self.home / "claude")]
        for _, root in self.roots: root.mkdir()
        for target, name, value in ((bridge, "transcript_roots", self.roots),):
            p = patch.object(target, name, return_value=value); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge.Path, "home", return_value=self.home); p.start(); self.addCleanup(p.stop)
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term_a", "agent": "claude", "agent_status": "done", "cwd": "/work/proj"}
        self.tree = {10: (RELAY, [11]), 11: (ssh("reconnect"), [])}
        self.info_fails = False
        self.calls = []
        p = patch.object(bridge, "call", side_effect=self.call); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, "process_snapshot", side_effect=self.snapshot); p.start(); self.addCleanup(p.stop)
        bridge._remote_results.clear(); self.addCleanup(bridge._remote_results.clear)

    def call(self, args):
        self.calls.append(args)
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
        if "process-info" in args:
            if self.info_fails: raise bridge.BridgeError("herdr busy")
            return {"process_info": {"foreground_processes": [{"pid": 10, "argv": self.tree[10][0]}]}}
        if args[2:4] == ["agent", "read"]: return {"text": ""}
        raise AssertionError("unexpected herdr call " + repr(args))

    def snapshot(self, pid):
        if pid not in self.tree: return None
        argv, children = self.tree[pid]
        return {"argv": argv, "children": children, "paths": [], "cwd": "/work/proj", "start": str(1000 + pid), "active_threads": []}

    def agents(self, state=True):
        return bridge.handle({"v": 1, "op": "agents", "session": "default"}, self.state if state else None)["agents"][0]["history_ref"]

    def route(self):
        return bridge.ch_ssh_route(ssh("attach"))


class RelayRouteTests(Pane):
    def test_relay_argv_names_the_same_route_as_its_ssh_child(self):
        relay = bridge.ch_relay_route(RELAY)
        self.assertEqual(relay, bridge.ch_ssh_route(ssh("reconnect")))
        self.assertEqual(relay["key"], self.route()["key"])
        # Disagreeing commands, other hosts, or a non-relay program: no route.
        other = list(RELAY); other[5] = json.dumps(SSH[:-1] + ["other@fixture.invalid", ssh("reconnect")[-1]])
        self.assertIsNone(bridge.ch_relay_route(other))
        self.assertIsNone(bridge.ch_relay_route(["bash"] + RELAY[1:]))
        self.assertIsNone(bridge.ch_relay_route(["python3", "-c", json.dumps(["sh", "-c", "ssh x"])]))

    def test_reconnecting_relay_is_a_moment_not_a_local_guess(self):
        self.tree = {10: (RELAY, [])}   # between two SSH connections: no ssh child
        with patch.object(bridge, "remote_read", side_effect=AssertionError("nothing to read while reconnecting")):
            ref = self.agents(state=False)
            with patch.object(bridge, "transcript_catalog", side_effect=AssertionError("never this computer's history")):
                follow = bridge.handle({"v": 1, "op": "agents", "session": "default", "target": "w1:p1", "identity": "x"})
        self.assertEqual(follow["agents"][0]["history_ref"]["status"], "remote_error")
        self.assertEqual((ref["status"], ref["transient"]), ("remote_error", True))
        self.assertIn("重新连接", ref["reason"])
        self.assertEqual(ref["remote"]["target"], "w1:p1")
        self.assertNotIn("candidates", ref)
        # Input never goes to the relay while it reconnects (it would drop it, Ctrl+C would end it).
        self.assertFalse(bridge.relay_pane(self.agent, ["--session", "default"]))
        with self.assertRaisesRegex(bridge.BridgeError, "重新连接"):
            bridge.route_for_context({"session": "default", "target": "w1:p1", "identity": bridge.identity(self.agent)})

    def test_failed_remote_read_and_failed_process_lookup_are_transient(self):
        with patch.object(bridge, "remote_read", side_effect=bridge.BridgeError("远端电脑响应超时")):
            ref = self.agents(state=False)
        self.assertEqual((ref["status"], ref.get("transient")), ("remote_error", True))
        self.info_fails = True
        ref = self.agents(state=False)
        self.assertEqual((ref["status"], ref.get("transient")), ("retry", True))
        self.assertNotIn("candidates", ref)


class LastGoodTests(Pane):
    def reply(self, status="matched", record=True):
        key = self.route()["key"]; rec = remote_record(key)
        rec = dict(rec, id=rec["id"].split(":")[-1]); rec.pop("remote")
        return {"routes": {"~/.local/share/ch/workspaces/" + CH: {"active": {"status": status, "thread": LIVE if status == "matched" else None},
                                                                 "record": rec if record else None, "source": "native-process", "candidates": []}}}

    def test_flap_keeps_the_last_confirmed_conversation(self):
        with patch.object(bridge, "remote_read", return_value=self.reply()):
            good = self.agents()
        self.assertEqual((good["status"], good["source"]), ("matched", "native-process"))
        self.assertTrue((self.state / "links-v1.json").is_file())
        self.assertEqual(oct((self.state / "links-v1.json").stat().st_mode & 0o777), "0o600")
        # The network drops: the relay reconnects, then reads time out.
        self.tree = {10: (RELAY, [])}
        stale = self.agents()
        self.assertEqual((stale["status"], stale["record_id"], stale["stale"], stale["transient"]), ("matched", good["record_id"], True, True))
        self.tree = {10: (RELAY, [12]), 12: (ssh("reconnect"), [])}
        with patch.object(bridge, "remote_read", side_effect=bridge.BridgeError("远端电脑响应超时")):
            stale = self.agents()
        self.assertTrue(stale["stale"]); self.assertEqual(stale["record"]["remote"]["identity"], bridge.identity(self.agent))
        # Back: the live evidence again, unmarked.
        with patch.object(bridge, "remote_read", return_value=self.reply()):
            again = self.agents()
        self.assertNotIn("stale", again)

    def test_a_real_answer_is_never_papered_over(self):
        with patch.object(bridge, "remote_read", return_value=self.reply()): self.agents()
        # The other computer answered: no live session id now (e.g. after /clear): not transient.
        with patch.object(bridge, "remote_read", return_value=self.reply("unavailable", record=False)):
            ref = self.agents()
        self.assertEqual(ref["status"], "remote_missing"); self.assertNotIn("record", ref)

    def test_another_agent_process_forgets_the_link(self):
        with patch.object(bridge, "remote_read", return_value=self.reply()): self.agents()
        # A new relay (same pid number, another start time), reconnecting: nothing stands in for it.
        new_run = {"argv": RELAY, "children": [], "paths": [], "cwd": "/", "start": "9", "active_threads": []}
        with patch.object(bridge, "process_snapshot", return_value=new_run):
            ref = self.agents()
        self.assertEqual(ref["status"], "remote_error"); self.assertNotIn("stale", ref)


class ManualLinkTests(Pane):
    def setUp(self):
        super().setUp()
        self.tree = {10: (["claude"], [])}
        self.path = dict(self.roots)["claude"] / "-work-proj" / (OLD + ".jsonl")
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({"type": "user", "sessionId": OLD, "cwd": "/work/proj", "message": {"content": "那段对话"}}) + "\n")
        self.record = next(x for x in bridge.transcript_catalog() if x["thread"] == OLD)

    def link(self, **extra):
        return bridge.handle(dict({"v": 1, "op": "link", "session": "default", "target": "w1:p1", "identity": bridge.identity(self.agent),
                                   "record_id": self.record["id"]}, **extra), self.state)

    def test_pick_sticks_across_restarts_and_wins_over_a_failed_match(self):
        self.assertEqual(self.agents()["status"], "unavailable")
        self.assertEqual(self.link()["linked"]["source"], "manual")
        # A new bridge process (an app restart) reads it back from the state file.
        ref = self.agents()
        self.assertEqual((ref["status"], ref["source"], ref["record_id"], ref["auto_status"]), ("matched", "manual", self.record["id"], "unavailable"))
        self.info_fails = True
        self.assertEqual(self.agents()["source"], "manual")
        # Herdr reporting a session id later changes the identity, not the pick.
        self.agent["agent_session"] = {"kind": "id", "value": "unknown"}
        self.info_fails = False
        self.assertEqual(self.agents()["source"], "manual")
        follow = bridge.handle({"v": 1, "op": "agents", "session": "default", "target": "w1:p1", "identity": "x"}, self.state)
        self.assertEqual(follow["agents"][0]["history_ref"]["source"], "manual")

    def test_strong_evidence_or_a_new_process_ends_the_pick(self):
        self.link()
        live = dict(self.roots)["claude"] / "-work-proj" / (LIVE + ".jsonl")
        live.write_text(json.dumps({"type": "user", "sessionId": LIVE, "cwd": "/work/proj", "message": {"content": "现在"}}) + "\n")
        native = {"argv": ["claude"], "children": [], "paths": [], "cwd": "/work/proj", "start": "1010", "active_threads": [LIVE]}
        with patch.object(bridge, "process_snapshot", return_value=native):
            ref = self.agents()
        self.assertEqual((ref["source"], ref["thread"]), ("native-process", LIVE))
        self.assertNotIn("manual", json.loads((self.state / "links-v1.json").read_text())["links"].popitem()[1])
        self.link()
        restarted = {"argv": ["claude"], "children": [], "paths": [], "cwd": "/work/proj", "start": "77", "active_threads": []}
        with patch.object(bridge, "process_snapshot", return_value=restarted):
            ref = self.agents()
        self.assertEqual(ref["status"], "unavailable")

    def test_only_records_of_the_right_computer_and_kind(self):
        with self.assertRaisesRegex(bridge.BridgeError, "没找到"): self.link(record_id="b" * 64)
        with self.assertRaises(bridge.BridgeError): self.link(record_id="../etc/passwd")
        with self.assertRaises(bridge.BridgeError): self.link(identity="stale")
        # A ch pane: its history is on the other computer; a local record is refused, and so is
        # a remote id of another route.
        self.tree = {10: (RELAY, [11]), 11: (ssh("reconnect"), [])}
        with self.assertRaisesRegex(bridge.BridgeError, "远端"): self.link()
        with self.assertRaisesRegex(bridge.BridgeError, "不在"): self.link(record_id="remote:" + "0" * 24 + ":" + "a" * 64)
        key = self.route()["key"]; rec = remote_record(key)
        with patch.object(bridge, "remote_catalog", return_value=[rec]):
            self.assertEqual(self.link(record_id=rec["id"])["linked"]["record_id"], rec["id"])
        with patch.object(bridge, "remote_read", side_effect=bridge.BridgeError("远端电脑响应超时")):
            ref = self.agents()
        self.assertEqual((ref["source"], ref["record"]["remote"]["identity"]), ("manual", bridge.identity(self.agent)))
        self.assertEqual(self.link(clear=True), {"linked": None})
        with patch.object(bridge, "remote_read", side_effect=bridge.BridgeError("远端电脑响应超时")):
            self.assertEqual(self.agents()["status"], "remote_error")

    def test_without_a_state_folder_nothing_is_written(self):
        self.agents(state=False)
        self.assertFalse(self.state.exists())


class TransferTests(unittest.TestCase):
    """The remote side: a ch transfer copy the live Claude was started on."""
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.roots = [("codex", self.home / ".codex/sessions"), ("claude", self.home / ".claude/projects")]
        for _, root in self.roots: root.mkdir(parents=True)
        p = patch.object(bridge, "transcript_roots", return_value=self.roots); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge.Path, "home", return_value=self.home); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, "kids_save", return_value=None); p.start(); self.addCleanup(p.stop)
        self.workspace = str(self.home / "ws" / CH)
        self.copy = self.home / ".local/share/ch/transfers" / LIVE / (OLD + ".jsonl")
        self.copy.parent.mkdir(parents=True)
        rows = [{"type": "user", "sessionId": OLD, "cwd": "/elsewhere/proj", "message": {"content": "搬过来的对话"}},
                {"type": "assistant", "sessionId": OLD, "message": {"content": [{"type": "text", "text": "好的"}]}}]
        self.copy.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        kid = self.copy.parent / OLD / "subagents" / "agent-k1.jsonl"; kid.parent.mkdir(parents=True)
        kid.write_text(json.dumps({"type": "user", "sessionId": OLD, "message": {"content": "子任务"}}) + "\n")

    def active(self, path=None):
        return {"status": "unavailable", "thread": None, "source": "native-process", "resume_path": str(path or self.copy)}

    def resolve(self, active):
        with patch.object(bridge, "remote_active_history", return_value=active):
            return bridge.remote_resolve([{"workspace": self.workspace, "provider": "claude"}])[self.workspace]

    def test_unused_fork_shows_the_transfer_copy(self):
        item = self.resolve(self.active())
        self.assertEqual((item["source"], item["record"]["thread"]), ("ch-transfer", OLD))
        self.assertNotIn("resume_path", item["active"])
        self.assertNotIn(str(self.copy), json.dumps(item))
        with patch.object(bridge, "remote_active_history", return_value=self.active()):
            page = bridge.remote_history_page({"record_id": item["record"]["id"], "workspace": self.workspace, "provider": "claude"})
            records = bridge.remote_catalog_records("claude", self.workspace)
        self.assertEqual([m["text"] for m in page["messages"]], ["搬过来的对话", "好的"])
        self.assertNotIn("resume_path", page["active_status"])
        self.assertEqual(len(page["children"]), 1)
        child = bridge.catalog_for_history(page["children"][0]["id"], "claude")
        self.assertEqual([x["id"] for x in child if x.get("parent")], [page["children"][0]["id"]])
        self.assertEqual([x["id"] for x in records], [item["record"]["id"]])
        # Through the remote entry point as the phone's request reaches it.
        with patch.object(bridge, "remote_active_history", return_value=self.active()):
            listed = bridge.remote_dispatch({"op": "catalog", "workspace": self.workspace, "provider": "claude"})
        self.assertEqual(listed["records"][0]["thread"], OLD)

    def test_once_the_route_wrote_its_own_transcript_the_copy_is_only_a_candidate(self):
        own = bridge.claude_project_dir(dict(self.roots)["claude"], self.workspace) / (LIVE + ".jsonl")
        own.parent.mkdir(parents=True)
        own.write_text(json.dumps({"type": "user", "sessionId": LIVE, "cwd": self.workspace, "message": {"content": "后来"}}) + "\n")
        item = self.resolve(self.active())
        self.assertIsNone(item["record"])
        self.assertEqual({x["thread"] for x in item["candidates"]}, {LIVE, OLD})
        # A live session id always beats the copy.
        item = self.resolve({"status": "matched", "thread": LIVE, "resume_path": str(self.copy)})
        self.assertEqual((item["source"], item["record"]["thread"]), ("native-process", LIVE))

    def test_only_real_transfer_copies(self):
        outside = self.home / "elsewhere" / LIVE / (OLD + ".jsonl"); outside.parent.mkdir(parents=True); outside.write_text(self.copy.read_text())
        link = self.copy.parent.parent / CH / (OLD + ".jsonl"); link.parent.mkdir(); link.symlink_to(outside)
        deep = self.copy.parent / "x" / (OLD + ".jsonl"); deep.parent.mkdir(); deep.write_text(self.copy.read_text())
        named = self.copy.parent / "notes.jsonl"; named.write_text(self.copy.read_text())
        for path in (outside, link, deep, named, self.copy.parent / ".." / LIVE / (OLD + ".jsonl")):
            self.assertIsNone(self.resolve(self.active(path))["record"], path)
        with patch.object(bridge.os, "getuid", return_value=os.getuid() + 1):
            self.assertIsNone(bridge.ch_transfer_entry(str(self.copy)))
        self.assertEqual(self.resolve(self.active())["source"], "ch-transfer")

    def test_resume_path_comes_from_the_one_native_agent(self):
        snaps = {1: {"argv": ["bash"], "children": [2], "start": "1"},
                 2: {"argv": ["claude", "--resume", str(self.copy), "--fork-session"], "children": [], "start": "2", "active_threads": []}}
        extra = {}
        with patch.object(bridge, "process_snapshot", side_effect=snaps.get):
            self.assertIsNone(bridge.active_threads_in_pane(1, "claude", extra=extra))
        self.assertEqual(extra["resume_path"], str(self.copy))
        self.assertIsNone(bridge.resume_path_in_argv(["claude", "--resume", OLD]))
        self.assertEqual(bridge.resume_path_in_argv(["claude", "--resume=" + str(self.copy)]), str(self.copy))


if __name__ == "__main__":
    unittest.main()
