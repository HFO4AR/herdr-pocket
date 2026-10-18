"""A picker the agent draws in place of its input box, in a Herdr pane Herdr calls done.

Seen with Codex 0.163 near its weekly limit: after a turn it puts up "Approaching rate limits /
Switch to gpt-6-luna for lower credit usage?" (1. Switch … 2. Keep current model 3. Keep current
model (never show again), "enter select · esc back"). Herdr reported the agent done, the phone said
「已完成」 and its queued message kept being refused. The screen is the real capture
(fixtures/codex_tmux.json `model_menu`), redrawn for its cursor; Herdr is a fake."""
import importlib.util
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parents[1] / "bridge/pocket_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
CODEX = json.loads((Path(__file__).parent / "fixtures/codex_tmux.json").read_text(encoding="utf-8"))
IDS = ["%d2345678-1234-4234-8234-123456789012" % i for i in range(1, 10)]
ROW = re.compile(r"^(.*?)(\x1b\[1;7m)?(› |  )(\d\. .*)$")


class RateLimitPicker:
    """The captured screen with "›" (and the reverse-video band) on the cursor row. Herdr key names:
    down/up move, enter picks (then the idle composer shows), esc closes it. In the composer a paste
    shows as its draft (the real draft screen) and Enter submits it."""
    def __init__(self):
        self.lines = CODEX["model_menu"].split("\n")
        self.rows = [i for i, x in enumerate(self.lines) if ROW.match(bridge.strip_sgr(x))]
        self.cursor, self.picked, self.typed, self.submitted = 1, None, "", []

    def ansi(self):
        if self.picked is not None: return CODEX["draft"].replace("hello draft text", self.typed) if self.typed else CODEX["idle"]
        out = list(self.lines)
        for n, i in enumerate(self.rows, 1):
            body = ROW.match(bridge.strip_sgr(out[i]))[4]
            out[i] = ("\x1b[1;7m› " if n == self.cursor else "  ") + body + "\x1b[0m"
        return "\n".join(out)

    def key(self, name):
        if self.picked is not None:
            if name == "enter" and self.typed: self.submitted.append(self.typed); self.typed = ""
            return
        if name == "down": self.cursor = min(self.cursor + 1, len(self.rows))
        elif name == "up": self.cursor = max(self.cursor - 1, 1)
        elif name == "enter": self.picked = self.cursor
        elif name == "esc": self.picked = "esc"


class HerdrPickerTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name)
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term1", "agent": "codex", "agent_status": "done", "state_change_seq": 7}
        self.tui, self.commands = RateLimitPicker(), []
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
        if args[1] == "read":
            screen = self.tui.ansi()
            return {"text": screen if "ansi" in args else bridge.strip_sgr(screen)}
        if args[1] == "send-keys":
            for name in args[3:]: self.tui.key(name)
            return {"type": "ok"}
        if args[1] == "send-text" and self.tui.picked is not None:
            self.tui.typed += args[3].replace("\x1b[200~", "").replace("\x1b[201~", "")
        return {"type": "ok"}

    def h(self, op, **extra):
        return bridge.handle(dict(v=1, op=op, session="default", **extra), self.state)

    def target(self, **extra):
        return dict(target="w1:p1", identity=bridge.identity(self.agent), **extra)

    def keys(self):
        return [k for c in self.commands if c[1] == "send-keys" for k in c[3:]]

    def test_status_read_and_agents_say_it_waits_for_a_choice(self):
        row = self.h("status")["agents"][0]
        self.assertEqual((row["agent_status"], row["screen"], row["herdr_status"], row["picker"]), ("blocked", "menu", "done", True))
        self.assertEqual(row["identity"], bridge.identity(self.agent), "the identity stays Herdr's")
        listed = bridge.agents(["--session", "default"], screens=self.state)[0]
        self.assertEqual((listed["agent_status"], listed["picker"]), ("blocked", True))
        read = self.h("read", **self.target())
        menu = read["menu"]
        self.assertEqual((read["agent_status"], read["picker"]), ("blocked", True))
        self.assertEqual((menu["kind"], menu["picker"], menu["cursor"]), ("question", True, 1))
        self.assertEqual(menu["question"], "Approaching rate limits — Switch to gpt-6-luna for lower credit usage?")
        self.assertEqual(menu["context"], ["Approaching rate limits", "Switch to gpt-6-luna for lower credit usage?"])
        # "esc back": Esc closes the picker, it does not interrupt anything.
        self.assertEqual(menu["esc"], {"action": "back", "option": None})
        self.assertEqual([(o["n"], o["label"]) for o in menu["options"]],
                         [(1, "Switch to gpt-6-luna"), (2, "Keep current model"), (3, "Keep current model (never show again)")])
        self.assertEqual(self.keys(), [], "reading never answers it")

    def test_prompt_is_refused_until_it_is_answered_then_goes(self):
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：它正停在一个提问或选择框上"):
            self.h("prompt", **self.target(id=IDS[0], text="接着做"))
        self.assertFalse(any(c[1] in ("prompt", "send-text", "send-keys") for c in self.commands), "nothing typed into the picker")
        # Shift+Tab could pick a row there: refused as on any waiting dialog.
        with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：Agent 正等你确认"):
            self.h("key", **self.target(id=IDS[1], key="shift+tab"))
        # The answer: fingerprint, one key at a time with a re-read, Enter only on the verified row.
        fingerprint = self.h("read", **self.target())["menu"]["fingerprint"]
        result = self.h("answer", **self.target(id=IDS[2], fingerprint=fingerprint, action="select", option=2, label="Keep current model"))
        self.assertEqual((result["sent"], self.keys(), self.tui.picked), (True, ["down", "enter"], 2))
        # Its composer is back: Herdr's own state again, and the queued message can go.
        row = self.h("status")["agents"][0]
        self.assertEqual(row["agent_status"], "done")
        self.assertNotIn("screen", row); self.assertNotIn("picker", row)
        self.assertEqual(self.h("prompt", **self.target(id=IDS[3], text="接着做"))["verified"], True)
        self.assertEqual(self.tui.submitted, ["接着做"])

    def test_wrong_row_under_the_cursor_never_gets_enter(self):
        fingerprint = self.h("read", **self.target())["menu"]["fingerprint"]
        # The phone saw another label for row 2: the walk stops before Enter.
        with self.assertRaises(bridge.BridgeError):
            self.h("answer", **self.target(id=IDS[0], fingerprint=fingerprint, action="select", option=2, label="Switch to gpt-6-luna"))
        self.assertNotIn("enter", self.keys())
        self.assertIsNone(self.tui.picked)
        # A changed dialog (other fingerprint) is not touched at all.
        self.commands.clear()
        with self.assertRaises(bridge.BridgeError):
            self.h("answer", **self.target(id=IDS[1], fingerprint="0" * 20, action="select", option=2, label="Keep current model"))
        self.assertEqual(self.keys(), [])

    def test_picker_opened_while_herdr_stood_still_is_found_after_a_refused_prompt(self):
        # The composer settled long ago, so the screen is not read on every poll. A picker opened then
        # (the person typed /model on the computer) shows once a prompt finds it there.
        self.tui.picked = 1  # composer on screen
        clock = [1000.0]
        with patch.object(bridge.time, "time", side_effect=lambda: clock[0]):
            self.assertEqual(self.h("status")["agents"][0]["agent_status"], "done")
            clock[0] += bridge.SCREEN_SETTLE + 1
            self.h("status")
            self.tui.picked = None  # the picker comes up; Herdr's state does not change
            self.assertEqual(self.h("status")["agents"][0]["agent_status"], "done", "settled: not read again")
            with self.assertRaisesRegex(bridge.BridgeError, "^没发出去：它正停在一个提问或选择框上"):
                self.h("prompt", **self.target(id=IDS[0], text="接着做"))
            row = self.h("status")["agents"][0]
        self.assertEqual((row["agent_status"], row["picker"]), ("blocked", True))

    def test_picker_a_sent_slash_command_opened_is_found_on_the_next_status(self):
        # Seen live (Codex 0.163, Herdr 0.8.2): "/model" sent from the phone opens a picker and Herdr's
        # state stays idle. The bridge looks at the screen again after anything it typed.
        self.tui.picked = 1
        self.agent["agent_status"] = "idle"
        real_key = self.tui.key
        def key(name):
            if name == "enter" and self.tui.typed == "/model":
                self.tui.typed, self.tui.picked, self.tui.cursor = "", None, 1
                return
            real_key(name)
        self.tui.key = key
        clock = [1000.0]
        with patch.object(bridge.time, "time", side_effect=lambda: clock[0]):
            self.h("status"); clock[0] += bridge.SCREEN_SETTLE + 1; self.h("status")
            looks = sum(1 for c in self.commands if c[1] == "read")
            self.h("status")
            self.assertEqual(sum(1 for c in self.commands if c[1] == "read"), looks, "settled: not read")
            self.h("prompt", **self.target(id=IDS[0], text="/model"))
            row = self.h("status")["agents"][0]
        self.assertEqual((row["agent_status"], row["herdr_status"], row["picker"]), ("blocked", "idle", True))

    def test_other_questions_keep_their_kind(self):
        for name, kind in (("approval", "approval"), ("question", "question")):
            plain = bridge.strip_sgr(CODEX[name])
            menu = bridge.parse_menu(plain, "codex")
            self.assertEqual((menu["kind"], menu["picker"]), (kind, False), name)
        # request_user_input keeps its own question text (no title in front).
        self.assertEqual(bridge.parse_menu(bridge.strip_sgr(CODEX["question"]), "codex")["question"], "Which color?")
        # Other agents' menus are never called pickers.
        self.assertFalse(bridge.parse_menu(bridge.strip_sgr(CODEX["model_menu"]), "gemini")["picker"])


if __name__ == "__main__":
    unittest.main()
