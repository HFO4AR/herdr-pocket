"""Agents other than Claude and Codex (OpenCode, Gemini, Pi …): Herdr detects them, the bridge
lists, reads, prompts, interrupts, answers and closes them the same generic way. Herdr is a
recorded fake; no real agent is started or sent anything. Screens are sanitized reconstructions."""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parents[1] / "bridge/pocket_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

UUID = "12345678-1234-1234-1234-123456789012"
# Field shapes as `herdr agent list` (0.8.2) prints them.
OPENCODE = {"agent": "opencode", "agent_status": "idle", "cwd": "/home/u/site", "foreground_cwd": "/home/u/site",
            "pane_id": "w1:p7", "revision": 2, "state_change_seq": 9, "tab_id": "w1:t3", "terminal_id": "term_oc",
            "terminal_title": "OpenCode", "terminal_title_stripped": "OpenCode", "workspace_id": "w1",
            "agent_session": {"agent": "opencode", "kind": "id", "source": "herdr:opencode", "value": "ses_abc"}}
GEMINI = {"agent": "gemini", "agent_status": "blocked", "cwd": "/home/u/api", "pane_id": "w1:p8", "tab_id": "w1:t3",
          "terminal_id": "term_ge", "terminal_title": "api: gemini", "workspace_id": "w1"}

GEMINI_MENU = "\n".join([
    "✦ 我先看一下目录。",
    "╭──────────────────────────────────────────╮",
    "│ ?  Shell ls -la                          │",
    "│                                          │",
    "│ Allow execution of: 'ls'?                │",
    "│                                          │",
    "│ ● 1. Yes, allow once                     │",
    "│   2. Yes, allow always                   │",
    "│   3. No, suggest changes (esc)           │",
    "╰──────────────────────────────────────────╯",
])


def arrow_screen(cursor):
    """An unnumbered picker (OpenCode-style permission list) with the pointer on row `cursor` (1-based)."""
    rows = ["Allow once", "Allow always", "Reject"]
    return "\n".join(["  Bash  rm -rf dist", "", "  Allow this command?", ""]
                     + [("  ❯ " if i + 1 == cursor else "    ") + r for i, r in enumerate(rows)]
                     + ["", "  ↑/↓ select · enter confirm · esc dismiss"])


class GenericAgentTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(); self.addCleanup(directory.cleanup)
        self.state = Path(directory.name)
        self.listed = [dict(OPENCODE), dict(GEMINI)]
        self.commands, self.screen, self.cursor = [], "", None
        self.probe = {"ok": True, "route": None, "native": True, "ids": set(), "paths": set(), "active": set(), "cwd": ""}
        self.relay = False
        for target, name, side in ((bridge, "call", self.call), (bridge, "probe_pane", lambda *a: dict(self.probe)),
                                   (bridge.time, "sleep", lambda s: None)):
            p = patch.object(target, name, side_effect=side); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge, "transcript_catalog", side_effect=AssertionError("no transcript read for other agents")); p.start(); self.addCleanup(p.stop)

    def call(self, args, timeout=20):
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]: return {"agents": [dict(a) for a in self.listed]}
        args = args[2:] if args[:1] == ["--session"] else args
        self.commands.append(args)
        if args[:2] == ["agent", "read"]:
            return {"text": arrow_screen(self.cursor) if self.cursor else self.screen}
        if self.relay and args[0] == "agent":
            raise bridge.HerdrRejected("agent_not_ready", "agent is no longer the pane foreground process")
        if args[:2] == ["agent", "send-keys"] and self.cursor:
            self.cursor = max(1, min(3, self.cursor + {"down": 1, "up": -1}.get(args[3], 0)))
        if args[:2] == ["pane", "get"]: return {"pane": {"pane_id": args[2], "terminal_id": "term_oc", "workspace_id": "w1", "tab_id": "w1:t3"}}
        if args[:2] == ["workspace", "list"]: return {"workspaces": [{"workspace_id": "w1", "label": "site"}]}
        if args[:2] == ["tab", "list"]: return {"tabs": [{"tab_id": "w1:t3", "label": "3", "pane_count": 2}]}
        return {"type": "ok"}

    def agent(self, kind="opencode"):
        return next(a for a in self.listed if a["agent"] == kind)

    def send(self, op, kind="opencode", **extra):
        a = self.agent(kind)
        return bridge.handle(dict(v=1, op=op, session="default", target=a["pane_id"], identity=bridge.identity(a), id=UUID, **extra), self.state)

    def sent(self):
        return [c for c in self.commands if c[:2] != ["agent", "read"]]

    def test_listed_with_status_and_no_history_lookup(self):
        agents = bridge.handle({"v": 1, "op": "agents", "session": "default"})["agents"]
        self.assertEqual([(a["agent"], a["agent_status"]) for a in agents], [("opencode", "idle"), ("gemini", "blocked")])
        self.assertTrue(all("history_ref" not in a and len(a["identity"]) == 64 for a in agents))
        status = bridge.handle({"v": 1, "op": "status", "session": "default"})["agents"]
        self.assertEqual(status[0]["agent_session"]["source"], "herdr:opencode")

    def test_prompt_goes_through_herdr(self):
        self.assertTrue(self.send("prompt", text="把测试跑一下")["sent"])
        self.assertEqual(self.sent(), [["agent", "prompt", "w1:p7", "把测试跑一下"]])

    def test_busy_agent_is_not_prompted(self):
        with self.assertRaisesRegex(bridge.BridgeError, "busy"): self.send("prompt", kind="gemini", text="hi")
        self.assertEqual(self.sent(), [])

    def test_esc_interrupts_like_any_key(self):
        self.agent()["agent_status"] = "working"
        self.send("key", key="esc")
        self.assertEqual(self.sent(), [["agent", "send-keys", "w1:p7", "esc"]])

    def test_shift_tab_only_when_the_footer_offers_it(self):
        self.screen = "  > \n  build · gpt-6\n  tab switch agent · ctrl+p commands"
        with self.assertRaisesRegex(bridge.BridgeError, "没提到 Shift\\+Tab"): self.send("key", key="shift+tab")
        self.assertEqual(self.sent(), [])
        # Cline-style footer: "(Tab) … Shift+Tab" under the input.
        self.screen = "  ❯ \n  ──────────\n  (Tab) Plan/Act · Shift+Tab auto-approve"
        self.send("key", key="shift+tab")
        self.assertEqual(self.sent(), [["agent", "send-keys", "w1:p7", "shift+tab"]])

    def test_read_reports_generic_modes(self):
        self.screen = "  ❯ hi\n  Shift+Tab cycle mode"
        self.assertEqual(self.send("read")["modes"], {"agent": "opencode", "generic": True, "cycle": True})
        self.screen = "  just output, Shift+Tab is mentioned in the conversation far above\n" + "\n".join("line %d" % i for i in range(12))
        self.assertIsNone(self.send("read")["modes"])

    def test_opencode_exits_with_its_own_command(self):
        result = self.send("exitAgent")
        self.assertEqual((result["command"], self.sent()), ("/exit", [["agent", "prompt", "w1:p7", "/exit"]]))

    def test_unknown_exit_command_is_never_guessed(self):
        self.agent("gemini")["agent_status"] = "idle"
        with self.assertRaisesRegex(bridge.BridgeError, "没法让它自己退出"): self.send("exitAgent", kind="gemini")
        self.assertEqual(self.sent(), [])
        info = bridge.handle({"v": 1, "op": "closeInfo", "session": "default", "target": "w1:p8", "identity": bridge.identity(self.agent("gemini"))})
        self.assertIsNone(info["exit_command"])
        info = bridge.handle({"v": 1, "op": "closeInfo", "session": "default", "target": "w1:p7", "identity": bridge.identity(self.agent())})
        self.assertEqual(info["exit_command"], "/exit")

    def test_relay_fallback_applies_to_any_kind(self):
        self.relay, self.probe = True, dict(self.probe, route={"ssh": ["remote"], "workspace": "~/x", "key": "k"}, native=False)
        self.send("prompt", text="hi")
        self.assertEqual(self.sent(), [["agent", "prompt", "w1:p7", "hi"], ["pane", "run", "w1:p7", "hi"]])

    def test_numbered_menu_with_a_dot_pointer(self):
        menu = bridge.parse_menu(GEMINI_MENU, "gemini")
        self.assertEqual((menu["kind"], menu["cursor"], [o["label"] for o in menu["options"]]),
                         ("approval", 1, ["Yes, allow once", "Yes, allow always", "No, suggest changes (esc)"]))
        self.assertEqual(menu["esc"], {"action": "cancel", "option": 3})
        self.assertFalse(any(o["input"] for o in menu["options"]), "typed text only on Claude question dialogs")
        # Claude keeps its own stricter pointer set: a "●" row there is a reply bullet.
        self.assertIsNone(bridge.parse_menu(GEMINI_MENU, "claude"))

    def test_unnumbered_picker_is_parsed_only_for_other_agents(self):
        menu = bridge.parse_menu(arrow_screen(1), "opencode")
        self.assertEqual((menu["cursor"], [o["label"] for o in menu["options"]], menu["question"]),
                         (1, ["Allow once", "Allow always", "Reject"], "Allow this command?"))
        self.assertIsNone(bridge.parse_menu(arrow_screen(1), "claude"))
        self.assertIsNone(bridge.parse_menu(arrow_screen(1), "codex"))
        # No key hint under it, or a prompt line that is just text: not a menu.
        self.assertIsNone(bridge.parse_menu("  ❯ Allow once\n    Allow always\n", "opencode"))
        self.assertIsNone(bridge.parse_menu("❯ 帮我看看\n  这段代码\n\n  enter to send", "pi"))

    def test_answering_an_unnumbered_picker_walks_and_verifies(self):
        self.agent()["agent_status"] = "blocked"
        self.cursor = 1
        fingerprint = bridge.parse_menu(arrow_screen(1), "opencode")["fingerprint"]
        result = self.send("answer", action="select", option=3, label="Reject", fingerprint=fingerprint)
        self.assertEqual(result["result"]["steps"], ["down", "down", "enter"])
        self.assertEqual(self.cursor, 3)

    def test_process_names_and_script_hosts(self):
        self.assertTrue(bridge.is_agent_process(["/usr/bin/opencode"], "opencode"))
        self.assertTrue(bridge.is_agent_process(["node", "/home/u/.npm-global/bin/gemini", "--yolo"], "gemini"))
        self.assertTrue(bridge.is_agent_process(["/home/u/.local/bin/cursor-agent"], "cursor"))
        self.assertFalse(bridge.is_agent_process(["node", "server.js"], "gemini"))
        self.assertFalse(bridge.is_agent_process(["bash"], ""))
        # Session switches stay a Claude / Codex thing.
        self.assertEqual(bridge.explicit_session_ids(["opencode", "-s", "01a14035-2079-7513-be2e-a886caefc891"], "opencode"), set())

    def test_receipts_still_guard_every_send(self):
        self.send("prompt", text="一次")
        with self.assertRaisesRegex(bridge.BridgeError, "reused"): self.send("prompt", text="另一句")
        self.assertEqual(len(self.sent()), 1)
        rows = sqlite3.connect(self.state / "receipts.sqlite").execute("SELECT COUNT(*) FROM receipts").fetchone()[0]
        self.assertEqual(rows, 1)


class GenericCreateTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name); (self.home / "site").mkdir()
        self.calls = []
        found = {"codex", "claude", "opencode", "kimi"}
        for target, name, kw in ((bridge.Path, "home", {"return_value": self.home}),
                                 (bridge, "find_executable", {"side_effect": lambda n: "/usr/bin/" + n if n in found else None}),
                                 (bridge, "transcript_catalog", {"return_value": []}),
                                 (bridge, "call", {"side_effect": self.call}), (bridge.time, "sleep", {"side_effect": lambda s: None})):
            p = patch.object(target, name, **kw); p.start(); self.addCleanup(p.stop)

    def call(self, args, timeout=20):
        self.calls.append(args)
        cmd = args[2:] if args[:1] == ["--session"] else args
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if cmd == ["workspace", "list"]: return {"workspaces": [{"workspace_id": "w1", "label": "site"}]}
        if cmd[:2] == ["pane", "list"]: return {"panes": [{"pane_id": "w1:p1", "cwd": str(self.home / "site")}]}
        if cmd[:2] == ["tab", "create"]: return {"tab": {"tab_id": "w1:t5"}, "root_pane": {"pane_id": "w1:p9", "tab_id": "w1:t5"}}
        if cmd[:2] == ["agent", "start"]: return {"type": "agent_started"}
        raise AssertionError("unexpected herdr call " + repr(args))

    def test_installed_kinds_are_offered_separately(self):
        info = bridge.handle({"v": 1, "op": "createInfo", "session": "default"})
        self.assertEqual([k["kind"] for k in info["kinds"]], ["codex", "claude", "ch"])
        self.assertEqual(info["more"], [{"kind": "opencode", "found": True}, {"kind": "kimi", "found": True}])

    def test_opencode_starts_with_its_herdr_kind(self):
        r = bridge.handle(dict(v=1, op="create", session="default", id=UUID, kind="opencode", cwd=str(self.home / "site"), workspace="w1"), self.home / "state")
        self.assertEqual((r["state"], r["kind"]), ("ready", "opencode"))
        start = next(a[2:] for a in self.calls if a[2:4] == ["agent", "start"])
        self.assertEqual(start[3:7], ["--kind", "opencode", "--pane", "w1:p9"])

    def test_unknown_or_missing_kinds_are_refused(self):
        for kind, why in (("bash", "不支持"), ("gemini", "没找到 gemini")):
            with self.subTest(kind=kind), self.assertRaisesRegex(bridge.BridgeError, why):
                bridge.handle(dict(v=1, op="create", session="default", id=UUID, kind=kind, cwd=str(self.home / "site"), workspace="w1"), self.home / "state")


if __name__ == "__main__":
    unittest.main()
