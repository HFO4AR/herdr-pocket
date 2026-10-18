"""Claude's settings panel (/status, /usage): `panelTour` reads every tab, then closes the panel.

Claude Code 2.1.268 draws /status, /usage, /config and /stats as one panel with tabs ("Settings
Status   Config   Usage   Stats"); the phone used to see only the tab it opened on. The screens are
real captures (fixtures/claude_panel.json); ClaudePanel switches between them with the keys the real
panel takes (→/←/Tab switch and wrap, ↓ scrolls Status, ↓ on Config enters its search box and then
its list, where Enter/Space would change a setting, Esc closes). Herdr and tmux are fakes."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parents[1] / "bridge/pocket_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
PANEL = json.loads((Path(__file__).parent / "fixtures/claude_panel.json").read_text(encoding="utf-8"))
IDS = ["%d2345678-1234-4234-8234-123456789012" % i for i in range(1, 10)]
TABS = ["Status", "Config", "Usage", "Stats"]
TAB_FOOTER = "←/→/tab to switch · ↓ to return · Esc to close"
FOCUS_FOOTER = {"search": "Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear",
                "list": "Enter/Space to change · / to search · Esc to close"}
TMUX_NAMES = {"Right": "right", "Left": "left", "Down": "down", "Up": "up", "Escape": "esc", "Enter": "enter", "Tab": "tab"}


class ClaudePanel:
    """The panel as a fake pane. `small`: the 90×20 captures, where Status needs one ↓ to show its
    last row and footer. `focus` on Config: "tabs" (reached with →), "search" (/config opens there)
    or "list". `changed` records any key that would have changed a setting."""
    def __init__(self, small=False, tab="Status", focus="tabs"):
        p = "small" if small else ""
        self.pages = {"Status": [PANEL["small0"], PANEL["small1"]] if small else [PANEL["status"]],
                      "Config": [PANEL[p + "config"]], "Usage": [PANEL[p + "usage"]], "Stats": [PANEL[p + "stats"]]}
        self.closed_screen = PANEL[p + "closed"]
        self.tab, self.scroll, self.focus, self.open = tab, 0, focus, True
        self.pressed, self.changed, self.stuck = [], [], False

    def screen(self):
        if not self.open: return self.closed_screen
        text = self.pages[self.tab][self.scroll]
        if self.tab == "Config" and self.focus in FOCUS_FOOTER: text = text.replace(TAB_FOOTER, FOCUS_FOOTER[self.focus])
        return text

    def key(self, name):
        name = TMUX_NAMES.get(name, name)
        self.pressed.append(name)
        if not self.open or self.stuck: return
        if self.tab == "Config" and self.focus != "tabs":
            if name == "esc":
                if self.focus == "search": self.focus = "list"
                else: self.open = False
            elif name == "up": self.focus = "tabs" if self.focus == "search" else "search"
            elif name == "down": self.focus = "list"
            elif name in ("enter", "space") and self.focus == "list": self.changed.append("Auto-compact")
            return
        if name in ("right", "tab", "left"):
            self.tab = TABS[(TABS.index(self.tab) + (-1 if name == "left" else 1)) % len(TABS)]
            self.scroll, self.focus = 0, "tabs"
        elif name == "down":
            if self.tab == "Status": self.scroll = min(self.scroll + 1, len(self.pages["Status"]) - 1)
            elif self.tab == "Config": self.focus = "search"
        elif name == "esc": self.open = False
        elif name == "enter": self.changed.append("enter on " + self.tab)


class HerdrPanelTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name)
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term1", "agent": "claude", "agent_status": "idle", "state_change_seq": 3}
        self.tui, self.commands, self.fail_on = ClaudePanel(), [], None
        for name, fake in (("call", self.call), ("probe_pane", lambda *a: {"ok": True, "route": None, "native": True})):
            p = patch.object(bridge, name, side_effect=fake); p.start(); self.addCleanup(p.stop)
        for name, value in (("ANSWER_PAUSE", 0), ("ANSWER_PATIENCE", 0.05)):
            p = patch.object(bridge, name, value); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge.time, "sleep", side_effect=lambda s: None); p.start(); self.addCleanup(p.stop)

    def call(self, args):
        if args == ["session", "list", "--json"]: return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]: return {"agents": [self.agent]}
        if args[:2] == ["--session", "default"]: args = args[2:]
        self.commands.append(args)
        if args[1] == "read": return {"text": self.tui.screen()}
        if args[1] == "send-keys":
            if self.fail_on and len(self.tui.pressed) == self.fail_on: raise bridge.BridgeError("Herdr timeout; mutation outcome may be unknown. Do not resend blindly.")
            for name in args[3:]: self.tui.key(name)
            return {"type": "ok"}
        raise AssertionError(args)

    def tour(self, command="status", **extra):
        request = dict(v=1, op="panelTour", session="default", target="w1:p1", identity=bridge.identity(self.agent),
                       id=IDS[0], command=command)
        request.update(extra)
        return bridge.handle(request, self.state)

    def tabs(self, result): return {t["tab"]: t for t in result["tabs"]}

    def test_status_reads_every_tab_then_closes(self):
        result = self.tour()
        self.assertEqual(self.tui.pressed, ["right", "right", "right", "esc"])
        self.assertEqual((result["sent"], result["closed"], result["start"], result["order"]), (True, True, "Status", TABS))
        self.assertEqual([t["tab"] for t in result["tabs"]], TABS)
        tabs = self.tabs(result)
        self.assertTrue(tabs["Status"]["text"].startswith("   Version:                    2.1.268"))
        self.assertIn("Organization policy:", tabs["Status"]["text"])
        self.assertNotIn("Esc to cancel", tabs["Status"]["text"], "the key hint is not content")
        self.assertIn("Auto-compact", tabs["Config"]["text"])
        self.assertTrue(tabs["Config"]["more"], "Config says ↓ 10 more below: the card says the rest stays in the terminal")
        self.assertFalse(tabs["Status"]["more"])
        self.assertIn("Total cost:", tabs["Usage"]["text"])
        self.assertIn("Favorite model:", tabs["Stats"]["text"])
        self.assertNotIn("stopped", result)
        self.assertEqual(self.tui.changed, [], "no setting was touched")
        self.assertFalse(self.tui.open)
        self.assertTrue(all(c[0] == "agent" for c in self.commands), "Herdr's agent commands, never raw pane input")

    def test_a_short_pane_scrolls_status_one_row_at_a_time(self):
        self.tui = ClaudePanel(small=True)
        result = self.tour()
        self.assertEqual(self.tui.pressed, ["down", "right", "right", "right", "esc"])
        status = self.tabs(result)["Status"]
        lines = status["text"].split("\n")
        self.assertEqual((lines[0].split()[0], lines.count("   Organization policy:        not fetched with a custom ANTHROPIC_BASE_URL")), ("Version:", 1))
        self.assertEqual(sum("Session ID:" in x for x in lines), 1, "the rows seen twice are merged")
        self.assertFalse(status["more"])
        # Stats takes ↓ into its own view: never scrolled, so the card says the rest is in the terminal.
        self.assertTrue(self.tabs(result)["Stats"]["more"])
        self.assertTrue(result["closed"])

    def test_a_status_tab_found_scrolled_goes_back_to_its_top_first(self):
        # Seen live in a 20-row Herdr pane: a panel already one row down marks its top row with ↑.
        self.tui = ClaudePanel(small=True)
        self.tui.pages["Status"] = [PANEL["small0"], PANEL["edge"], PANEL["small1"]]
        self.tui.scroll = 1
        real = self.tui.key
        def key(name):
            if name == "up" and self.tui.tab == "Status": self.tui.pressed.append(name); self.tui.scroll = max(0, self.tui.scroll - 1); return
            real(name)
        self.tui.key = key
        result = self.tour()
        self.assertEqual(self.tui.pressed, ["up", "down", "down", "right", "right", "right", "esc"])
        status = self.tabs(result)["Status"]["text"].split("\n")
        self.assertTrue(status[0].startswith("   Version:"))
        self.assertEqual(sum("Session name:" in x for x in status), 1)

    def test_usage_starts_on_its_own_tab_and_goes_round(self):
        self.tui = ClaudePanel(tab="Usage")
        result = self.tour(command="usage")
        self.assertEqual(self.tui.pressed, ["right", "right", "right", "esc"])
        self.assertEqual((result["start"], [t["tab"] for t in result["tabs"]]), ("Usage", TABS))
        self.assertEqual(self.tui.changed, [])

    def test_config_with_its_search_box_focused_gets_no_key(self):
        # /config opens with the search box focused: Esc there only clears it, ↓ walks into the list.
        self.tui = ClaudePanel(tab="Config", focus="search")
        with self.assertRaisesRegex(bridge.BridgeError, "^没按键：面板的焦点在搜索框或设置列表里"):
            self.tour()
        self.tui.focus = "list"
        with self.assertRaisesRegex(bridge.BridgeError, "^没按键：面板的焦点在搜索框或设置列表里"):
            self.tour(id=IDS[1])
        self.assertEqual(self.tui.pressed, [])

    def test_nothing_is_pressed_without_the_panel(self):
        self.tui.open = False
        with self.assertRaisesRegex(bridge.BridgeError, "^没按键：屏幕上没看到 Claude 的设置面板"):
            self.tour()
        self.assertEqual(self.tui.pressed, [])

    def test_busy_waiting_or_other_agents_are_refused(self):
        for status in ("working", "blocked"):
            self.agent["agent_status"] = status
            with self.assertRaisesRegex(bridge.BridgeError, "^没按键：Agent 不是空闲状态"):
                self.tour()
        self.agent.update(agent_status="idle", agent="codex")
        with self.assertRaisesRegex(bridge.BridgeError, "^没按键：只有 Claude"):
            self.tour()
        self.agent["agent"] = "claude"
        for bad in ({"command": "config"}, {"key": "enter"}):
            with self.assertRaises(bridge.BridgeError):
                self.tour(**bad)
        self.assertEqual(self.tui.pressed, [])

    def test_a_tab_that_does_not_come_stops_the_walk_and_closes(self):
        self.tui.stuck = True  # → does nothing: the screen still shows Status
        result = self.tour()
        self.assertEqual(self.tui.pressed, ["right", "esc"])
        self.assertIn("没认出 Config", result["stopped"])
        self.assertEqual([t["tab"] for t in result["tabs"]], ["Status"])
        # The fake ignored Esc as well: the result says the panel is still up.
        self.assertFalse(result["closed"])

    def test_a_panel_closed_on_the_computer_gets_no_more_keys(self):
        real = self.tui.key
        def closing(name):
            real(name); self.tui.open = False
        self.tui.key = closing
        result = self.tour()
        self.assertEqual(self.tui.pressed, ["right"], "no Esc for a screen that no longer shows the panel")
        self.assertTrue(result["closed"])
        self.assertIn("stopped", result)

    def test_same_id_answers_from_its_receipt_and_an_unknown_outcome_is_not_replayed(self):
        first = self.tour()
        pressed = list(self.tui.pressed)
        self.tui = ClaudePanel()
        self.assertEqual(self.tour(), first)
        self.assertEqual(self.tui.pressed, [], "a handled request never presses again")
        self.assertEqual(pressed, ["right", "right", "right", "esc"])
        self.fail_on = 2
        with self.assertRaisesRegex(bridge.BridgeError, "Herdr timeout"):
            self.tour(id=IDS[2])
        self.tui = ClaudePanel()
        with self.assertRaisesRegex(bridge.BridgeError, "^上次翻面板的结果未知"):
            self.tour(id=IDS[2])
        self.assertEqual(self.tui.pressed, [])

    def test_the_panel_is_not_a_waiting_dialog(self):
        # Herdr says idle while the panel is up (seen live); the screen check must not call it a menu.
        for name in ("status", "config", "usage", "stats", "small0", "small1", "edge"):
            self.assertIsNone(bridge.parse_menu(PANEL[name], "claude"), name)
        row = bridge.handle({"v": 1, "op": "status", "session": "default"}, self.state)["agents"][0]
        self.assertEqual(row["agent_status"], "idle")
        self.assertNotIn("picker", row)


class PanelViewTests(unittest.TestCase):
    def test_tabs_are_told_apart_by_what_they_show(self):
        seen = {name: (bridge.panel_view(PANEL[name]) or {}).get("tab") for name in
                ("status", "config", "usage", "stats", "small0", "small1", "smallconfig", "smallusage", "smallstats", "edge", "closed", "codex")}
        self.assertEqual(seen, {"status": "Status", "config": "Config", "usage": "Usage", "stats": "Stats", "small0": "Status",
                                "small1": "Status", "smallconfig": "Config", "smallusage": "Usage", "smallstats": "Stats",
                                "edge": "Status", "closed": None, "codex": None})
        self.assertIsNone(bridge.panel_view(PANEL["closed"]))
        self.assertIsNone(bridge.panel_view(PANEL["codex"]), "Codex /status is one screen, no panel")

    def test_scroll_marks_and_footer_are_not_content(self):
        view = bridge.panel_view(PANEL["edge"])
        self.assertEqual(view["footer"], "")
        self.assertEqual(view["body"][0], "   Session name:               /rename to add a name")
        self.assertEqual(view["body"][-1], "   Organization policy:        not fetched with a custom ANTHROPIC_BASE_URL")
        self.assertEqual(bridge.panel_view(PANEL["status"])["footer"], "Esc to cancel")
        self.assertEqual(bridge.panel_view(PANEL["config"])["footer"], TAB_FOOTER)
        self.assertTrue(bridge.panel_view(PANEL["config"])["safe"])
        self.assertFalse(bridge.panel_view(PANEL["config"].replace(TAB_FOOTER, FOCUS_FOOTER["list"]))["safe"])

    def test_merge(self):
        self.assertEqual(bridge.panel_merge(["a", "b", "c"], ["b", "c", "d"]), ["a", "b", "c", "d"])
        self.assertEqual(bridge.panel_merge(["a", "b"], ["a", "b"]), ["a", "b"])
        self.assertEqual(bridge.panel_merge(["a"], ["x", "y"]), ["a", "x", "y"])


if __name__ == "__main__":
    unittest.main()
