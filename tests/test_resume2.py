"""Picking an old conversation up again: `create` / `tmuxNew` with `resume`. Herdr and tmux are
recorded fakes and /proc is a fake process list: nothing is started, resumed or read for real."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_bridge import bridge
import test_create
import test_tmux_only
# Their fixtures are reused; the classes are not bound here by name, so their tests do not run twice.
UUID = test_create.UUID

CLAUDE_ID = "b02fa480-ee6b-403e-95f9-ea269c8b42cf"
CODEX_ID = "01a14c4a-77b5-7011-82f0-56c046b68047"
CH_ID = "5fce5692-ae33-5ace-ca33-0f2f2a89b9ab"
UUID2 = "22345678-1234-4234-8234-123456789012"
RELAY = ["python3", "-c", "\"\"\"Raw PTY relay.\"\"\"", '["ssh","-tt","zhenyu@host","exec ch.route __native-attach ' + CH_ID + '"]',
         '["/home/u/.local/bin/ch","--host","zhenyu","share-image","--session","' + CH_ID + '"]', '["ssh"]',
         '["ch","--host","zhenyu","resume","' + CH_ID + '"]']
CH_SSH = ["ssh", "-tt", "-o", "BatchMode=yes", "-p", "22", "zhenyu@100.1.1.1",
          "exec \"$HOME\"/'.local/bin/ch.route' --state ~/.local/share/ch __native-attach " + CH_ID]


class HerdrResumeTests(unittest.TestCase):
    setUp_create = test_create.CreateTests.setUp
    call = test_create.CreateTests.call
    mutations = test_create.CreateTests.mutations

    def setUp(self):
        self.setUp_create()
        self.catalog = [{"provider": "claude", "thread": CLAUDE_ID, "id": "r1", "cwd": str(self.project), "parent": None, "modified": 5},
                        {"provider": "codex", "thread": CODEX_ID, "id": "r2", "cwd": str(self.project), "parent": None, "modified": 4},
                        {"provider": "claude", "thread": "aaaaaaaa-1111-4222-8333-444455556666", "id": "r3", "cwd": str(self.project),
                         "parent": CLAUDE_ID, "modified": 3}]
        p = patch.object(bridge, "transcript_catalog", side_effect=lambda *a, **k: list(self.catalog)); p.start(); self.addCleanup(p.stop)
        self.procs = []
        p = patch.object(bridge, "user_processes", side_effect=lambda *a, **k: iter(self.procs)); p.start(); self.addCleanup(p.stop)
        self.snapshots = {}
        p = patch.object(bridge, "process_snapshot", side_effect=lambda pid: self.snapshots.get(pid)); p.start(); self.addCleanup(p.stop)
        config = self.home / ".config/ch"; config.mkdir(parents=True)
        (config / "config.toml").write_text('default_host = "remote"\n\n[hosts.remote]\ntarget = "p@h"\n\n[hosts.zhenyu]\n'
                                            'target = "z@h"\nidentity = "/secret/key"\n\n[hosts."dotted.name"]\n')
        p = patch.dict(os.environ, {"XDG_CONFIG_HOME": ""}); p.start(); self.addCleanup(p.stop)

    def req(self, **kw):
        r = dict(v=1, op="create", session="default", id=UUID, kind="claude", cwd=str(self.project), workspace="w1",
                 resume={"id": CLAUDE_ID})
        r.update(kw); return r

    def starts(self): return [m for m in self.mutations() if m[:2] in (["agent", "start"], ["pane", "run"])]

    # ── Claude / Codex: argv after `--`, never a shell string ──
    def test_claude_resume_passes_argv_after_double_dash(self):
        r = bridge.handle(self.req(), self.state)
        self.assertEqual((r["created"], r["state"], r["resume"]), (True, "ready", {"id": CLAUDE_ID}))
        start = self.starts()[0]
        self.assertEqual(start[:7], ["agent", "start", "pocket-12345678", "--kind", "claude", "--pane", "w1:p9"])
        self.assertEqual(start[-3:], ["--", "--resume", CLAUDE_ID])
        self.assertEqual(len(self.starts()), 1)

    def test_codex_resume_subcommand(self):
        r = bridge.handle(self.req(kind="codex", resume={"id": CODEX_ID}), self.state)
        self.assertTrue(r["created"])
        self.assertEqual(self.starts()[0][-3:], ["--", "resume", CODEX_ID])

    def test_plain_create_still_has_no_agent_arguments(self):
        bridge.handle({k: v for k, v in self.req(kind="codex").items() if k != "resume"}, self.state)
        self.assertNotIn("--", self.starts()[0])

    def test_ids_are_strictly_checked_before_anything(self):
        bad = ["", "B02FA480-EE6B-403E-95F9-EA269C8B42CF", CLAUDE_ID + " ", CLAUDE_ID + ";rm -rf ~", "$(id)", "--help",
               "b02fa480ee6b403e95f9ea269c8b42cf", 12, None, ["x"]]
        for value in bad:
            with self.subTest(value=value), self.assertRaisesRegex(bridge.BridgeError, "^没继续"):
                bridge.handle(self.req(resume={"id": value}), self.state)
        for resume in ("b02fa480", [CLAUDE_ID], {"id": CLAUDE_ID, "args": ["--dangerously-skip-permissions"]},
                       {"id": CLAUDE_ID, "host": "zhenyu"}, {}):
            with self.subTest(resume=resume), self.assertRaisesRegex(bridge.BridgeError, "^没继续"):
                bridge.handle(self.req(resume=resume), self.state)
        for kind in ("opencode", "gemini"):
            with self.subTest(kind=kind), self.assertRaisesRegex(bridge.BridgeError, "^没继续"):
                bridge.handle(self.req(kind=kind), self.state)
        self.assertEqual(self.mutations(), [])
        self.assertFalse((self.state / "receipts.sqlite").exists(), "no receipt was taken")

    def test_conversation_must_be_a_local_root_record(self):
        with self.assertRaisesRegex(bridge.BridgeError, "^没继续：这台电脑上没找到这段对话"):
            bridge.handle(self.req(resume={"id": "cccccccc-1111-4222-8333-444455556666"}), self.state)
        with self.assertRaisesRegex(bridge.BridgeError, "^没继续：这是子 Agent"):
            bridge.handle(self.req(resume={"id": "aaaaaaaa-1111-4222-8333-444455556666"}), self.state)
        # A Codex id is not a Claude conversation.
        with self.assertRaisesRegex(bridge.BridgeError, "^没继续：这台电脑上没找到"):
            bridge.handle(self.req(resume={"id": CODEX_ID}), self.state)
        self.assertEqual(self.mutations(), [])

    def test_missing_directory_and_missing_cli_say_so(self):
        with self.assertRaisesRegex(bridge.BridgeError, r"^没继续：目录 .*gone 不存在了"):
            bridge.handle(self.req(cwd=str(self.project) + "/gone"), self.state)
        with patch.object(bridge, "find_executable", return_value=None), \
                self.assertRaisesRegex(bridge.BridgeError, "^没继续：这台电脑上没找到 claude 命令"):
            bridge.handle(self.req(), self.state)
        self.assertEqual(self.mutations(), [])

    def test_offline_session_is_a_resume_refusal(self):
        with self.assertRaisesRegex(bridge.BridgeError, "^没继续：Session is offline"):
            bridge.handle(self.req(session="other"), self.state)

    def test_running_somewhere_refuses_a_second_start(self):
        # A Claude started with --resume of that id (no runtime folder seen): running.
        self.procs = [(41, ["node", "/opt/claude", "--resume", CLAUDE_ID])]
        with self.assertRaisesRegex(bridge.BridgeError, "^没继续：这段对话已经在运行了"):
            bridge.handle(self.req(), self.state)
        # Its runtime task folder says it switched to another conversation since (/resume): not running.
        self.snapshots[41] = {"active_threads": ["dddddddd-1111-4222-8333-444455556666"]}
        self.assertTrue(bridge.handle(self.req(), self.state)["created"])

    def test_running_by_runtime_folder_and_codex_tui_only(self):
        self.procs = [(50, ["claude"])]; self.snapshots[50] = {"active_threads": [CLAUDE_ID]}
        with self.assertRaisesRegex(bridge.BridgeError, "已经在运行"):
            bridge.handle(self.req(), self.state)
        # The Codex app-server keeps rollouts open after the TUI quits: not a running conversation.
        self.procs = [(60, ["/home/u/.codex/packages/bin/codex", "app-server", "--listen", "unix://"]), (61, ["codex", "exec", "resume", CODEX_ID])]
        self.assertTrue(bridge.handle(self.req(kind="codex", resume={"id": CODEX_ID}), self.state)["created"])
        self.procs = [(62, ["codex", "resume", CODEX_ID])]
        with self.assertRaisesRegex(bridge.BridgeError, "已经在运行"):
            bridge.handle(self.req(id=UUID2, kind="codex", resume={"id": CODEX_ID}), self.state)

    def test_receipt_answers_before_the_running_check(self):
        first = bridge.handle(self.req(), self.state)
        # Now it runs (we started it): the same id still reports the same pane, starts nothing.
        self.procs = [(70, ["claude", "--resume", CLAUDE_ID])]
        self.assertEqual(bridge.handle(self.req(), self.state), first)
        self.assertEqual(len(self.starts()), 1)
        with self.assertRaisesRegex(bridge.BridgeError, "different content"):
            bridge.handle(self.req(resume={"id": CODEX_ID}, kind="codex"), self.state)

    def test_auto_workspace_follows_the_directory(self):
        r = bridge.handle(self.req(workspace="auto"), self.state)
        self.assertEqual(self.mutations()[0], ["tab", "create", "--workspace", "w1", "--cwd", str(self.project), "--no-focus"])
        self.assertEqual((r["workspace_label"], r["new_workspace"]), ("site", False))
        # Nobody works in the home directory's sub folder yet: a new workspace.
        other = self.home / "notes"; other.mkdir()
        self.catalog[0]["cwd"] = str(other)
        r = bridge.handle(self.req(id=UUID2, workspace="auto", cwd=str(other)), self.state)
        self.assertEqual(self.mutations()[-2], ["workspace", "create", "--cwd", str(other), "--no-focus"])
        self.assertTrue(r["new_workspace"])

    # ── ch: fixed words plus a configured host and a uuid ──
    def test_ch_resume_types_the_checked_command(self):
        self.pane_after = {"pane_id": "w1:p9", "agent": "claude", "agent_status": "idle"}
        r = bridge.handle(self.req(kind="ch", resume={"id": CH_ID, "host": "zhenyu"}), self.state)
        self.assertEqual(self.starts(), [["pane", "run", "w1:p9", "ch --host zhenyu resume " + CH_ID]])
        self.assertEqual((r["state"], r["resume"]), ("ready", {"id": CH_ID, "host": "zhenyu"}))

    def test_ch_host_must_be_configured_and_plain(self):
        for host in ("nope", "zhenyu;id", "-x", "zhenyu ", "", None, "a" * 70):
            with self.subTest(host=host), self.assertRaisesRegex(bridge.BridgeError, "^没继续"):
                bridge.handle(self.req(kind="ch", resume={"id": CH_ID, "host": host}), self.state)
        with self.assertRaisesRegex(bridge.BridgeError, "^没继续"):
            bridge.handle(self.req(kind="ch", resume={"id": CH_ID}), self.state)
        self.assertEqual(bridge.ch_hosts(), {"remote", "zhenyu", "dotted.name"})
        (self.home / ".config/ch/config.toml").unlink()
        with self.assertRaisesRegex(bridge.BridgeError, "^没继续：读不到 ch 的主机配置"):
            bridge.handle(self.req(kind="ch", resume={"id": CH_ID, "host": "zhenyu"}), self.state)
        self.assertEqual(self.mutations(), [])

    def test_ch_session_attached_somewhere_is_running(self):
        self.procs = [(80, CH_SSH)]
        with self.assertRaisesRegex(bridge.BridgeError, "已经在运行"):
            bridge.handle(self.req(kind="ch", resume={"id": CH_ID, "host": "zhenyu"}), self.state)

    def test_ch_resume_read_from_the_relay_argv(self):
        self.assertEqual(bridge.ch_resume_in_argv(RELAY), {"host": "zhenyu", "session": CH_ID})
        for argv in (["ch", "--host", "zhenyu", "resume", CH_ID],  # not the relay
                     RELAY[:3] + ['["ch","--host","zhenyu;id","resume","' + CH_ID + '"]'],
                     RELAY[:3] + ['["ch","--host","zhenyu","resume","' + CH_ID + '","--x"]'],
                     RELAY[:3] + ['["sh","--host","zhenyu","resume","' + CH_ID + '"]'], RELAY[:3] + ["[not json"]):
            with self.subTest(argv=argv[-1]):
                self.assertIsNone(bridge.ch_resume_in_argv(argv))


class TmuxResumeTests(unittest.TestCase):
    setUp_tmux = test_tmux_only.TmuxOnlyTests.setUp
    save = test_tmux_only.TmuxOnlyTests.save
    argvs = test_tmux_only.TmuxOnlyTests.argvs
    reset_log = test_tmux_only.TmuxOnlyTests.reset_log
    h = test_tmux_only.TmuxOnlyTests.h

    def setUp(self):
        self.setUp_tmux()
        self.catalog.append({"provider": "claude", "thread": CLAUDE_ID, "id": "r9", "cwd": str(self.home / "notes"), "parent": None,
                             "modified": 9.0, "_path": Path("/h/.claude/projects/n/x.jsonl")})
        self.procs_list = []
        p = patch.object(bridge, "user_processes", side_effect=lambda *a, **k: iter(self.procs_list)); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, "find_executable", side_effect=lambda name: "/usr/bin/" + name if name != "tmux" else str(self.dir / "bin/tmux"))
        p.start(); self.addCleanup(p.stop)

    def typed(self): return [a[1:] for a in self.argvs() if a[1] == "send-keys"]

    def test_new_session_then_the_resume_line_typed_into_its_pane(self):
        self.reset_log()
        r = self.h(op="tmuxNew", id=UUID, cwd="~/notes", resume={"kind": "claude", "id": CLAUDE_ID})
        self.assertEqual((r["created"], r["typed"], r["pane"]["pane_id"], r["resume"]), (True, True, "%7", {"kind": "claude", "id": CLAUDE_ID}))
        self.assertEqual(self.typed(), [["send-keys", "-t", "%7", "-l", "--", "claude --resume " + CLAUDE_ID], ["send-keys", "-t", "%7", "Enter"]])
        # The same id never types twice.
        self.reset_log()
        self.assertEqual(self.h(op="tmuxNew", id=UUID, cwd="~/notes", resume={"kind": "claude", "id": CLAUDE_ID}), r)
        self.assertEqual(self.typed(), [])

    def test_tmux_refusals(self):
        cases = [({"kind": "claude", "id": CLAUDE_ID + "; id"}, "^没继续"), ({"kind": "bash", "id": CLAUDE_ID}, "^没继续"),
                 ({"kind": "claude", "id": CLAUDE_ID, "args": "x"}, "^没继续"), ({"kind": "claude", "id": CODEX_ID}, "没找到这段对话")]
        for resume, msg in cases:
            with self.subTest(resume=resume), self.assertRaisesRegex(bridge.BridgeError, msg):
                self.h(op="tmuxNew", id=UUID, cwd="~/notes", resume=resume)
        with self.assertRaisesRegex(bridge.BridgeError, "^没继续：目录 .* 不存在了"):
            self.h(op="tmuxNew", id=UUID, cwd="~/gone", resume={"kind": "claude", "id": CLAUDE_ID})
        self.procs_list = [(5, ["claude", "--resume", CLAUDE_ID])]
        with patch.object(bridge, "process_snapshot", return_value=None), self.assertRaisesRegex(bridge.BridgeError, "已经在运行"):
            self.h(op="tmuxNew", id=UUID, cwd="~/notes", resume={"kind": "claude", "id": CLAUDE_ID})
        self.assertFalse(any(a[1] == "new-session" for a in self.argvs()))


if __name__ == "__main__":
    unittest.main()
