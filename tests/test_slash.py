"""Slash commands: transcript rows for Claude commands, the read-only `commands` op, and menu reads.

Transcript fixtures follow what Claude Code 2.1.268 writes: a user row (or, in newer sessions, a
`system`/`local_command` row) holding `<command-name>/model</command-name>…`, then the printed result
in `<local-command-stdout>`; the caveat row is `isMeta`.
"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parents[1] / "bridge/pocket_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

COMMAND = "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>"


def user(content, **extra):
    return dict({"type": "user", "message": {"role": "user", "content": content}, "timestamp": "2026-10-15T08:00:00Z"}, **extra)


class TranscriptTests(unittest.TestCase):
    def rows(self, row):
        return bridge.normalize_record(row, "claude", 10)

    def test_command_and_output_become_user_rows(self):
        cmd = self.rows(user(COMMAND))
        self.assertEqual([(m["kind"], m["text"]) for m in cmd], [("user", COMMAND)])
        out = self.rows(user("<local-command-stdout>Set model to `x`\x1b[22m and saved</local-command-stdout>"))
        self.assertEqual(out[0]["text"], "<local-command-stdout>Set model to `x` and saved</local-command-stdout>")

    def test_system_local_command_rows(self):
        row = {"type": "system", "subtype": "local_command", "content": "<command-name>/resume</command-name>\n<command-args></command-args>",
               "timestamp": "2026-10-15T08:00:00Z", "isMeta": False}
        self.assertEqual(self.rows(row)[0]["kind"], "user")
        row["content"] = "<local-command-stdout>Resume cancelled</local-command-stdout>"
        self.assertIn("Resume cancelled", self.rows(row)[0]["text"])
        self.assertEqual(self.rows({"type": "system", "subtype": "other", "content": "<local-command-stdout>x</local-command-stdout>"}), [])

    def test_caveat_reminders_and_meta_stay_hidden(self):
        self.assertEqual(self.rows(user("<local-command-caveat>Caveat: …</local-command-caveat>")), [])
        self.assertEqual(self.rows(user("<system-reminder>x</system-reminder>")), [])
        self.assertEqual(self.rows(user(COMMAND, isMeta=True)), [])

    def test_prompt_commands_keep_their_message_form(self):
        text = "<command-message>find-skills is running…</command-message>\n<command-name>/find-skills</command-name>\n<command-args>pdf</command-args>"
        self.assertEqual(self.rows(user(text))[0]["text"], text)
        # A plain message that only mentions a tag is untouched.
        self.assertEqual(self.rows(user("/status 是什么"))[0]["text"], "/status 是什么")


class CommandsTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.home = Path(directory.name) / "home"; self.project = self.home / "work/proj"
        for path in ("home/.claude/commands/git", "home/.claude/skills/pdf-tools", "home/.claude/skills/no-skill-file",
                     "home/work/proj/.claude/commands", "home/work/.claude/skills/team", "home/.codex/prompts"):
            (Path(directory.name) / path).mkdir(parents=True)
        files = {".claude/commands/deploy.md": "secret body", ".claude/commands/git/commit.md": "", ".claude/commands/bad name.md": "",
                 ".claude/commands/notes.txt": "", ".claude/skills/pdf-tools/SKILL.md": "", "work/proj/.claude/commands/ship.md": "",
                 "work/.claude/skills/team/SKILL.md": "", ".codex/prompts/fix.md": "", ".codex/prompts/draft.md": ""}
        for name, body in files.items(): (self.home / name).write_text(body)
        for target, value in (("home", lambda: self.home),):
            p = patch.object(bridge.Path, target, staticmethod(value)); p.start(); self.addCleanup(p.stop)
        p = patch.dict(os.environ, {}, clear=False); p.start(); self.addCleanup(p.stop); os.environ.pop("CODEX_HOME", None)

    def test_claude_lists_names_only_project_first(self):
        found = bridge.custom_commands({"agent": "claude", "cwd": str(self.project)})
        self.assertEqual(found["provider"], "claude")
        self.assertEqual([(c["name"], c["kind"], c["scope"]) for c in found["commands"]], [
            ("ship", "command", "project"), ("team", "skill", "project"),
            ("deploy", "command", "user"), ("git:commit", "command", "user"), ("pdf-tools", "skill", "user")])
        self.assertNotIn("secret body", json.dumps(found))

    def test_codex_prompts(self):
        found = bridge.custom_commands({"agent": "codex", "cwd": str(self.project)})
        self.assertEqual([c["name"] for c in found["commands"]], ["prompts:draft", "prompts:fix"])

    def test_relative_or_missing_cwd_skips_project(self):
        names = [c["name"] for c in bridge.custom_commands({"agent": "claude", "cwd": "work/proj"})["commands"]]
        self.assertNotIn("ship", names)
        self.assertEqual(bridge.custom_commands({"agent": "bash"})["commands"], [])

    def test_project_walk_stops_at_home(self):
        self.assertEqual(bridge.project_dirs(str(self.project)), [self.project.resolve(), (self.home / "work").resolve()])
        self.assertEqual(bridge.project_dirs("/"), [])


class HandleTests(unittest.TestCase):
    def setUp(self):
        self.agent = {"pane_id": "w1:p1", "terminal_id": "t1", "agent": "claude", "agent_status": "idle", "cwd": "/nonexistent/x"}
        self.screen = "❯ /model\n\n Select model\n\n ❯ 1. Default (recommended)\n   2. Opus\n   3. Haiku\n\n Enter to confirm · Esc to exit"
        p = patch.object(bridge, "call", side_effect=self.call); p.start(); self.addCleanup(p.stop)
        self.calls = []

    def call(self, args):
        self.calls.append(args)
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
        if args[2:4] == ["agent", "read"]: return {"text": self.screen}
        raise AssertionError(args)

    def request(self, op, **extra):
        return bridge.handle(dict(v=1, op=op, session="default", target="w1:p1", identity=bridge.identity(self.agent), **extra))

    def test_commands_op_is_read_only(self):
        self.assertEqual(self.request("commands")["provider"], "claude")
        self.assertTrue(all(a[2:4] != ["agent", "prompt"] and "send-keys" not in a for a in self.calls))

    def test_commands_checks_identity(self):
        with self.assertRaisesRegex(bridge.BridgeError, "changed or disappeared"):
            bridge.handle(dict(v=1, op="commands", session="default", target="w1:p1", identity="other"))

    def test_read_parses_a_picker_on_request_even_when_idle(self):
        self.assertNotIn("menu", self.request("read"))
        menu = self.request("read", menu=True)["menu"]
        self.assertEqual((menu["cursor"], [o["label"] for o in menu["options"]]), (1, ["Default (recommended)", "Opus", "Haiku"]))
        self.screen = "❯ /status\n Claude Code v2.1.268\n Esc to cancel"
        self.assertIsNone(self.request("read", menu=True)["menu"])
        self.assertNotIn("menu", self.request("read", menu="yes"))


if __name__ == "__main__":
    unittest.main()
