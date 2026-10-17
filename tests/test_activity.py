"""What an agent says it is doing (read → `activity`) and what each running sub-agent is doing
(kids items → `activity`, `started`). Synthetic screens shaped like Claude Code 2.x and Codex 0.16x
status lines, synthetic transcripts from test_kids; read-only, no real Herdr, tmux or agent."""
import json
import unittest
from unittest.mock import patch
from test_bridge import bridge
from test_kids import KidsBase, PROJECT, PARENT, claude, agent_use, launched, iso

RULE = "─" * 40


def claude_screen(above, footer="  ⏵⏵ accept edits on (shift+tab to cycle)"):
    return "\n".join(["⏺ Earlier reply.", "", above, "", RULE, "❯ ", RULE, footer])


class ScreenActivity(unittest.TestCase):
    def test_claude_status_line(self):
        a = bridge.screen_activity(claude_screen("✽ Ionizing… (42s · ↓ 1.2k tokens · esc to interrupt)"))
        self.assertEqual((a["verb"], a["seconds"], a["dir"], a["tokens"]), ("Ionizing", 42, "↓", "1.2k"))
        self.assertNotIn("thinking", a)
        self.assertEqual(a["line"], "✽ Ionizing… (42s · ↓ 1.2k tokens · esc to interrupt)")

    def test_claude_variants(self):
        # 2.1.2xx drops the interrupt hint; the todo list sits between the line and the box.
        a = bridge.screen_activity(claude_screen("· Ionizing… (4s · ↓ 28 tokens)"))
        self.assertEqual((a["seconds"], a["tokens"]), (4, "28"))
        a = bridge.screen_activity(claude_screen("✶ Ionizing… (esc to interrupt · ctrl+t to show todos)\n  ⎿  ◻ step one\n     ◻ step two"))
        self.assertEqual(a["verb"], "Ionizing"); self.assertNotIn("seconds", a)
        a = bridge.screen_activity(claude_screen("✢ Compacting conversation… (1m 34s)"))
        self.assertEqual((a["verb"], a["seconds"]), ("Compacting conversation", 94))
        a = bridge.screen_activity(claude_screen("✻ Ionizing… (2h 1m 3s · ↑ 3.4k tokens · thinking)"))
        self.assertEqual((a["seconds"], a["dir"], a["thinking"]), (7263, "↑", True))

    def test_codex_status_line(self):
        a = bridge.screen_activity("• Ran npm test\n\n• Working (1m 02s • esc to interrupt)\n\n› Ask Codex to do anything\n\n  ? for shortcuts")
        self.assertEqual((a["verb"], a["seconds"]), ("Working", 62))
        a = bridge.screen_activity("◦ Exploring the bridge (7s • esc to interrupt)\n\n› \n\n  42% context left")
        self.assertEqual(a["verb"], "Exploring the bridge")

    def test_not_activity(self):
        # Finished lines, tool lines and bullets in the conversation never read as activity.
        for screen in [claude_screen("✻ Crunched for 7s · done 17:51"), claude_screen("⏺ Update(app.js)"),
                       claude_screen("* Running tests...\n  some reply line"), "• Ran npm test\n• Explored (3 files)\n\n› \n  ? for shortcuts",
                       "", "plain shell $ "]:
            self.assertIsNone(bridge.screen_activity(screen), screen)
        # Only the line right above Claude's box counts, not one further up in the reply.
        self.assertIsNone(bridge.screen_activity("\n".join(["✽ Ionizing… (3s · esc to interrupt)", "⏺ Done.", "", RULE, "❯ ", RULE])))


class ReadCarriesActivity(unittest.TestCase):
    def setUp(self):
        self.agent = {"pane_id": "w1:p1", "terminal_id": "t1", "agent": "claude", "agent_status": "working"}
        self.text = claude_screen("✽ Ionizing… (42s · ↓ 1.2k tokens · esc to interrupt)")

    def fake(self, args):
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
        if "--format" in args: return {"text": self.text}
        return {"text": self.text}

    def read(self):
        with patch.object(bridge, "call", side_effect=self.fake):
            return bridge.handle({"v": 1, "op": "read", "session": "default", "target": "w1:p1", "identity": bridge.identity(self.agent)})

    def test_working_read_has_the_agents_words(self):
        r = self.read()
        self.assertEqual((r["activity"]["verb"], r["activity"]["seconds"]), ("Ionizing", 42))

    def test_idle_read_has_none(self):
        self.agent["agent_status"] = "idle"; self.text = claude_screen("⏺ All done.")
        self.assertNotIn("activity", self.read())


class KidActivity(KidsBase):
    def child(self, agent_id, use_id, rows, age=5):
        folder = self.home / ".claude/projects" / PROJECT / PARENT / "subagents"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / ("agent-" + agent_id + ".meta.json")).write_text(json.dumps({"agentType": "general-purpose", "description": "child " + agent_id, "toolUseId": use_id}))
        return self.write(folder / ("agent-" + agent_id + ".jsonl"), rows, age)

    def running_rows(self, command, started):
        tool = claude("assistant", [{"type": "tool_use", "id": "c1", "name": "Bash", "input": {"command": command}}], iso(-2), isSidechain=True)
        tool["message"]["stop_reason"] = "tool_use"
        return [claude("user", "synthetic task", started, isSidechain=True), tool]

    def test_running_child_says_its_step_and_start(self):
        started = iso(-80)
        self.claude_parent([agent_use("toolu_1", "child a1"), launched("toolu_1", "a1")])
        self.child("a1", "toolu_1", self.running_rows("pytest -k api_cursor", started))
        item = self.report()["items"][0]
        self.assertTrue(item["running"])
        act = item["activity"]
        self.assertEqual((act["kind"], act["verb"], act["text"], act["open"]), ("tool", "run", "pytest -k api_cursor", True))
        self.assertEqual(item["started"], started)
        self.assertEqual(item["tools"], 1)

    def test_a_note_after_the_command_is_output(self):
        rows = self.running_rows("true", iso(-30))
        rows.append(claude("user", [{"type": "tool_result", "tool_use_id": "c1", "content": "ok"}], iso(-2), isSidechain=True))
        rows.append(claude("assistant", [{"type": "text", "text": "Contrast is too low in 3 places."}], iso(-1), isSidechain=True))
        rows[-1]["message"]["stop_reason"] = "tool_use"     # mid-turn: more to come
        self.claude_parent([agent_use("toolu_1", "child a1"), launched("toolu_1", "a1")])
        self.child("a1", "toolu_1", rows)
        act = self.report()["items"][0]["activity"]
        self.assertEqual((act["kind"], act["text"]), ("note", "Contrast is too low in 3 places."))

    def test_finished_children_are_not_read(self):
        self.claude_parent([claude("user", "synthetic ask")])
        self.claude_child("d1", "toolu_done", done=True, age=5)
        with patch.object(bridge, "kid_activity", wraps=bridge.kid_activity) as reads:
            item = self.report()["items"][0]
        self.assertFalse(item["running"]); self.assertNotIn("activity", item)
        self.assertEqual(reads.call_count, 0)

    def test_at_most_a_few_running_children_are_read(self):
        rows = [agent_use("toolu_%d" % i, "child k%d" % i) for i in range(6)] + [launched("toolu_%d" % i, "k%d" % i) for i in range(6)]
        self.claude_parent(rows)
        for i in range(6): self.child("k%d" % i, "toolu_%d" % i, self.running_rows("sleep %d" % i, iso(-60)))
        with patch.object(bridge, "kid_activity", wraps=bridge.kid_activity) as reads:
            r = self.report()
        self.assertEqual(r["running"], 6)
        self.assertEqual(reads.call_count, bridge.KIDS_LIVE)
        self.assertEqual(sum(1 for x in r["items"] if "activity" in x), bridge.KIDS_LIVE)

    def test_glance_carries_it(self):
        self.claude_parent([agent_use("toolu_1", "child a1"), launched("toolu_1", "a1")])
        self.child("a1", "toolu_1", self.running_rows("make lint", iso(-20)))
        rel = PROJECT + "/" + PARENT + ".jsonl"
        item = {"key": "s/a", "provider": "claude", "thread": PARENT, "record_id": self.record_id("claude", rel), "cwd": "/work/demo", "kids": True}
        bridge._kids_state = None
        kids = bridge.handle({"v": 1, "op": "glance", "items": [item]})["previews"]["s/a"]["kids"]
        self.assertEqual(kids["items"][0]["activity"]["text"], "make lint")


if __name__ == "__main__":
    unittest.main()
