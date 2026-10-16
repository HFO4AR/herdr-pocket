"""Answering agent questions and approval menus from the phone.

Screen fixtures follow the layouts that Claude Code 2.1.268 renders for AskUserQuestion,
its permission dialog, and Codex 0.162 approval / request_user_input pickers (structure
reconstructed from their render code and Herdr's detection rules; wording anonymized).
"""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parents[1] / "bridge/pocket_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

RULE = "─" * 64

CLAUDE_SINGLE = "\n".join([
    "● 先确认两件事，再动手。",
    "",
    RULE,
    "←  ☐ 日志位置  ☐ 保留时长  ✔ Submit  →",
    "",
    "运行日志放在哪里？",
    "",
    "❯ 1. 写到项目目录（推荐）",
    "     放在 logs/ 下，和代码一起忽略提交。",
    "  2. 写到系统临时目录",
    "     重启后会清空，不占项目空间。",
    "  3. Type something.",
    RULE,
    "  4. Chat about this",
    "",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
])

CLAUDE_MULTI = "\n".join([
    RULE,
    "←  ☒ 日志位置  ☐ 清理范围  ✔ Submit  →",
    "",
    "这次要清理哪些目录？",
    "",
    "❯ 1. [ ] 构建产物",
    "     dist/ 和 build/。",
    "  2. [✔] 缓存",
    "     .cache/ 下的所有内容。",
    "  3. [ ] Type something",
    "     Next",
    "",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
])

# Captured from Claude Code 2.1.268: in a multi-select the Submit row sits under the last option,
# above the rule and the trailing "Chat about this" row.
CLAUDE_MULTI_CHAT = "\n".join([
    RULE,
    "←  ☒ Q1  ☒ Q2  ☐ Q3  ✔ Submit  →",
    "Which of the following options should be enabled (multiple",
    "choices allowed)?",
    "❯ 1. [ ] 选项一",
    "  这是一个较长的中文描述句子，用来说明该选项的具体含义与适用",
    "  场景，方便理解。",
    "  2. [ ] 选项二",
    "  这个选项的描述同样采用较长的中文句子。",
    "  3. [ ] 选项三",
    "  第三个选项也配有一段中文说明。",
    "  4. [ ] Type something",
    "     Submit",
    RULE,
    "  5. Chat about this",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
])

CLAUDE_BASH = "\n".join([
    "● 我先清掉旧的构建结果。",
    "",
    RULE,
    " Bash command",
    "",
    "   rm -rf dist .cache",
    "   Remove build outputs",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for rm commands in /home/demo/site",
    "   3. No, and tell Claude what to do differently (esc)",
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain",
])

CODEX_APPROVAL = "\n".join([
    "• 这会删除构建产物，先让你确认一下。",
    "",
    "  Would you like to run the following command?",
    "",
    "  Reason: 清理构建产物",
    "",
    "  $ rm -rf dist .cache",
    "",
    "› 1. Yes, proceed (y)",
    "  2. Yes, and don't ask again for commands that start with `rm -rf` (p)",
    "  3. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel",
])

CODEX_QUESTION = "\n".join([
    "  Question 1/2 (2 unanswered)",
    "  消息顺序",
    "  Agent 正在工作时，新发的消息怎么处理？",
    "",
    "  › 1. 按顺序等待 (Recommended)  进入队列，这一轮结束后再发。",
    "    2. 立即追加                  直接交给正在运行的 Agent。",
    "    3. None of the above         Optionally, add details in notes (tab).",
    "",
    "  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
])

CLAUDE_PREVIEW = "\n".join([
    RULE,
    "图放在哪里？",
    "",
    "❯ 1. 嵌入正文（推荐） ✔           ┌──────────────────────┐",
    "  2. 文末附图                     │ 4.4 失败处理流程       │",
    "                                  │   [ 图 3 ]             │",
    "                                  └──────────────────────┘",
    "",
    "Notes: press n to add notes",
    "",
    "  Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel",
])


class ParseMenuTests(unittest.TestCase):
    def test_claude_question_with_tabs_input_and_chat_rows(self):
        menu = bridge.parse_menu(CLAUDE_SINGLE, "claude")
        self.assertEqual(menu["kind"], "question")
        self.assertEqual(menu["cursor"], 1)
        self.assertEqual(menu["question"], "运行日志放在哪里？")
        self.assertEqual([t["label"] for t in menu["tabs"]], ["日志位置", "保留时长"])
        self.assertFalse(menu["multi"])
        rows = menu["options"]
        self.assertEqual([r["label"] for r in rows], ["写到项目目录（推荐）", "写到系统临时目录", "Type something.", "Chat about this"])
        self.assertEqual(rows[0]["description"], "放在 logs/ 下，和代码一起忽略提交。")
        self.assertEqual([r["input"] for r in rows], [False, False, True, False])
        self.assertEqual([r["chat"] for r in rows], [False, False, False, True])

    def test_claude_multi_select_reads_checkboxes_and_submit_row(self):
        menu = bridge.parse_menu(CLAUDE_MULTI, "claude")
        self.assertTrue(menu["multi"])
        self.assertEqual(menu["submit"], "Next")
        self.assertEqual([r["checked"] for r in menu["options"]], [False, True, False])
        self.assertEqual([r["label"] for r in menu["options"]], ["构建产物", "缓存", "Type something"])
        self.assertTrue(menu["options"][2]["input"])
        self.assertEqual(menu["tabs"], [{"label": "日志位置", "done": True}, {"label": "清理范围", "done": False}])
        focused = CLAUDE_MULTI.replace("❯ 1.", "  1.").replace("     Next", "❯    Next")
        self.assertEqual(bridge.parse_menu(focused, "claude")["cursor"], "submit")

    def test_claude_multi_select_submit_above_chat_row(self):
        menu = bridge.parse_menu(CLAUDE_MULTI_CHAT, "claude")
        self.assertTrue(menu["multi"])
        self.assertEqual(menu["submit"], "Submit")
        self.assertEqual([(r["n"], r["input"], r["chat"]) for r in menu["options"]],
                         [(1, False, False), (2, False, False), (3, False, False), (4, True, False), (5, False, True)])
        self.assertEqual(menu["options"][0]["description"], "这是一个较长的中文描述句子，用来说明该选项的具体含义与适用 场景，方便理解。")
        self.assertEqual(menu["options"][3]["description"], "")
        focused = CLAUDE_MULTI_CHAT.replace("❯ 1.", "  1.").replace("     Submit", "❯    Submit")
        self.assertEqual(bridge.parse_menu(focused, "claude")["cursor"], "submit")

    def test_claude_permission_dialog_is_an_approval_with_command_context(self):
        menu = bridge.parse_menu(CLAUDE_BASH, "claude")
        self.assertEqual(menu["kind"], "approval")
        self.assertEqual(menu["cursor"], 1)
        self.assertIn("rm -rf dist .cache", menu["context"])
        self.assertEqual(menu["question"], "Do you want to proceed?")
        self.assertEqual(len(menu["options"]), 3)
        self.assertFalse(any(r["input"] for r in menu["options"]))

    def test_what_esc_does_comes_from_the_screen(self):
        # Claude question: "Esc to cancel"; permission dialogs mark the row Esc picks.
        self.assertEqual(bridge.parse_menu(CLAUDE_SINGLE, "claude")["esc"], {"action": "cancel", "option": None})
        self.assertEqual(bridge.parse_menu(CLAUDE_BASH, "claude")["esc"], {"action": "cancel", "option": 3})
        self.assertEqual(bridge.parse_menu(CODEX_APPROVAL, "codex")["esc"], {"action": "cancel", "option": 3})
        # Codex's blocking question: Esc interrupts the whole turn.
        self.assertEqual(bridge.parse_menu(CODEX_QUESTION, "codex")["esc"], {"action": "interrupt", "option": None})
        # Not part of the fingerprint: an older screen parse keeps matching.
        bare = CLAUDE_SINGLE.replace(" · Esc to cancel", "")
        self.assertIsNone(bridge.parse_menu(bare, "claude")["esc"])
        self.assertEqual(bridge.parse_menu(bare, "claude")["fingerprint"], bridge.parse_menu(CLAUDE_SINGLE, "claude")["fingerprint"])

    def test_codex_approval_and_inline_descriptions(self):
        menu = bridge.parse_menu(CODEX_APPROVAL, "codex")
        self.assertEqual(menu["kind"], "approval")
        self.assertEqual(menu["options"][0]["label"], "Yes, proceed (y)")
        self.assertIn("$ rm -rf dist .cache", menu["context"])
        question = bridge.parse_menu(CODEX_QUESTION, "codex")
        self.assertEqual(question["kind"], "question")
        self.assertEqual(question["options"][0]["label"], "按顺序等待 (Recommended)")
        self.assertEqual(question["options"][0]["description"], "进入队列，这一轮结束后再发。")
        self.assertEqual(question["question"], "Agent 正在工作时，新发的消息怎么处理？")
        self.assertFalse(any(r["input"] for r in question["options"]))

    def test_preview_side_panel_is_not_part_of_labels(self):
        menu = bridge.parse_menu(CLAUDE_PREVIEW, "claude")
        self.assertEqual([r["label"] for r in menu["options"]], ["嵌入正文（推荐）", "文末附图"])
        self.assertTrue(menu["options"][0]["chosen"])
        self.assertEqual(menu["options"][1]["description"], "")

    def test_scroll_arrows_in_the_pointer_column(self):
        screen = "\n".join([RULE, "先修哪个？", "", "↑ 2. 修历史", "❯ 3. 修通知", "     后台提醒不响。", "↓ 4. 修登录", "", "Enter to select · ↑/↓ to navigate · Esc to cancel"])
        menu = bridge.parse_menu(screen, "claude")
        self.assertEqual([(r["n"], r["label"]) for r in menu["options"]], [(2, "修历史"), (3, "修通知"), (4, "修登录")])
        self.assertEqual(menu["cursor"], 3)
        self.assertEqual(menu["options"][1]["description"], "后台提醒不响。")
        lone = bridge.parse_menu(screen.replace("↓ 4. 修登录", "  4. 修登录\n  ↓"), "claude")
        self.assertEqual(lone["options"][2]["description"], "")

    def test_refuses_screens_it_does_not_understand(self):
        # A numbered list in the conversation is not a menu: no pointer.
        self.assertIsNone(bridge.parse_menu("计划：\n1. 读代码\n2. 改测试\n3. 提交", "codex"))
        two = CODEX_APPROVAL.replace("  2. Yes", "› 2. Yes")
        self.assertIsNone(bridge.parse_menu(two, "codex"))
        long_tail = CODEX_APPROVAL + "\n" + "\n".join("output line %d" % i for i in range(20))
        self.assertIsNone(bridge.parse_menu(long_tail, "codex"))

    def test_older_numbered_list_does_not_hide_the_live_menu(self):
        screen = "• 方案：\n  1. 先读\n  2. 再改\n\n" + CODEX_APPROVAL
        menu = bridge.parse_menu(screen, "codex")
        self.assertEqual(menu["options"][0]["label"], "Yes, proceed (y)")

    def test_fingerprint_ignores_cursor_checks_and_typed_text(self):
        base = bridge.parse_menu(CLAUDE_SINGLE, "claude")["fingerprint"]
        moved = CLAUDE_SINGLE.replace("❯ 1.", "  1.").replace("  2. 写到", "❯ 2. 写到")
        typed = CLAUDE_SINGLE.replace("  3. Type something.", "  3. 放到 /var/log")
        self.assertEqual(bridge.parse_menu(moved, "claude")["fingerprint"], base)
        self.assertEqual(bridge.parse_menu(typed, "claude")["fingerprint"], base)
        changed = CLAUDE_SINGLE.replace("运行日志放在哪里？", "缓存放在哪里？")
        self.assertNotEqual(bridge.parse_menu(changed, "claude")["fingerprint"], base)
        multi = bridge.parse_menu(CLAUDE_MULTI, "claude")["fingerprint"]
        self.assertEqual(bridge.parse_menu(CLAUDE_MULTI.replace("[✔]", "[ ]"), "claude")["fingerprint"], multi)


class FakeMenu:
    """A tiny TUI: renders rows with a pointer and reacts to Herdr key names."""

    def __init__(self, labels, cursor=1, multi=False, checked=(), input_row=None, chat_row=None, stuck=False):
        self.labels, self.cursor, self.multi = list(labels), cursor, multi
        self.checked, self.input_row, self.chat_row, self.stuck = set(checked), input_row, chat_row, stuck
        self.typed, self.submitted, self.question = "", None, "运行日志放在哪里？"
        self.after_key, self.swallow_text, self.window, self.top, self.jump = None, False, None, 1, 1

    def screen(self):
        lines = [RULE, self.question, ""]
        for n, label in enumerate(self.labels, 1):
            if self.multi and n == self.chat_row: continue
            if self.window and not self.top <= n < self.top + self.window: continue
            if n == self.input_row and self.typed and not self.swallow_text: label = self.typed
            box = ("[✔] " if n in self.checked else "[ ] ") if self.multi and n != self.chat_row else ""
            lines.append(("❯ " if self.cursor == n else "  ") + "%d. %s%s" % (n, box, label))
        if self.multi: lines.append(("❯" if self.cursor == "submit" else " ") + "    Submit")
        if self.multi and self.chat_row:
            lines += [RULE, ("❯ " if self.cursor == self.chat_row else "  ") + "%d. %s" % (self.chat_row, self.labels[self.chat_row - 1])]
        lines += ["", "Enter to select · ↑/↓ to navigate · Esc to cancel"]
        return "\n".join(lines)

    def key(self, name):
        last = len(self.labels)
        if self.after_key: self.after_key(self)
        if self.stuck: return
        if self.multi and self.chat_row: last -= 1
        if name == "down":
            if self.cursor == "submit" and self.chat_row: self.cursor = self.chat_row
            elif self.cursor == last and self.multi: self.cursor = "submit"
            elif self.cursor != "submit": self.cursor = min(last, self.cursor + self.jump)
        elif name == "up":
            self.cursor = last if self.cursor == "submit" else "submit" if self.multi and self.cursor == self.chat_row else max(1, self.cursor - self.jump)
        elif name == "enter":
            if self.multi and self.cursor != "submit": self.checked ^= {self.cursor}
            else: self.submitted = self.cursor
        # Scroll like Claude's select: keep the cursor inside the visible window.
        if self.window and isinstance(self.cursor, int):
            self.top = min(max(self.top, self.cursor - self.window + 1), self.cursor)


class AnswerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state = Path(self.directory.name)
        self.agent = {"pane_id": "w1:p1", "terminal_id": "term_test", "agent": "claude", "agent_status": "blocked"}
        self.fake = FakeMenu(["写到项目目录（推荐）", "写到系统临时目录", "Type something.", "Chat about this"], input_row=3, chat_row=4)
        self.writes = []
        for target, value in (("call", self.call), ):
            p = patch.object(bridge, target, side_effect=value); p.start(); self.addCleanup(p.stop)
        for name, value in (("ANSWER_PAUSE", 0), ("ANSWER_PATIENCE", 0.05)):
            p = patch.object(bridge, name, value); p.start(); self.addCleanup(p.stop)

    def call(self, args):
        if args == ["session", "list", "--json"]:
            return {"sessions": [{"name": "default", "running": True}]}
        if args[-2:] == ["agent", "list"]:
            return {"agents": [self.agent]}
        command = args[2:]
        if command[:2] == ["agent", "read"]:
            return {"text": self.fake.screen()}
        if command[:2] == ["agent", "send-keys"]:
            self.writes.append(("keys", command[3:]))
            for key in command[3:]: self.fake.key(key)
            return {}
        if command[:2] == ["pane", "send-text"]:
            self.writes.append(("text", command[3]))
            self.fake.typed += command[3]
            if getattr(self.fake, "auto_check", False): self.fake.checked.add(self.fake.input_row)
            return {}
        raise AssertionError(args)

    def fingerprint(self):
        return bridge.parse_menu(self.fake.screen(), "claude")["fingerprint"]

    def answer(self, request_id=None, **extra):
        self.counter = getattr(self, "counter", 0) + 1
        request_id = request_id or "12345678-1234-1234-1234-%012d" % self.counter
        request = dict(v=1, op="answer", session="default", target="w1:p1", identity=bridge.identity(self.agent),
                       id=request_id, fingerprint=self.fingerprint(), **extra)
        return bridge.handle(request, self.state)

    def keys(self):
        return [k for kind, value in self.writes if kind == "keys" for k in value]

    def test_select_moves_from_current_cursor_then_confirms(self):
        self.fake.cursor = 1
        result = self.answer(action="select", option=2, label="写到系统临时目录")
        self.assertEqual(self.keys(), ["down", "enter"])
        self.assertEqual(self.fake.submitted, 2)
        self.assertEqual(result["result"]["option"], 2)

    def test_select_moves_up_when_cursor_is_below(self):
        self.fake.cursor = 3
        self.answer(action="select", option=1, label="写到项目目录（推荐）")
        self.assertEqual(self.keys(), ["up", "up", "enter"])
        self.assertEqual(self.fake.submitted, 1)

    def test_duplicate_request_is_never_replayed(self):
        same = "12345678-1234-1234-1234-123456789012"
        first = self.answer(same, action="select", option=2, label="写到系统临时目录")
        self.fake.cursor = 1
        self.assertEqual(self.answer(same, action="select", option=2, label="写到系统临时目录"), first)
        self.assertEqual(self.keys(), ["down", "enter"])

    def test_changed_menu_is_refused_before_any_key(self):
        request = dict(v=1, op="answer", session="default", target="w1:p1", identity=bridge.identity(self.agent),
                       id="12345678-1234-1234-1234-123456789012", fingerprint=self.fingerprint(), action="select", option=2)
        self.fake.question = "缓存放在哪里？"
        with self.assertRaisesRegex(bridge.BridgeError, "选项已经变了"):
            bridge.handle(request, self.state)
        self.assertEqual(self.writes, [])

    def test_cursor_that_does_not_move_never_gets_enter(self):
        self.fake.stuck = True
        with self.assertRaisesRegex(bridge.BridgeError, "没有按确认"):
            self.answer(action="select", option=2)
        self.assertEqual(self.keys(), ["down"])
        self.assertIsNone(self.fake.submitted)

    def test_menu_replaced_while_moving_stops_without_enter(self):
        self.fake.after_key = lambda fake: setattr(fake, "question", "另一个问题？")
        with self.assertRaisesRegex(bridge.BridgeError, "菜单变了"):
            self.answer(action="select", option=2)
        self.assertNotIn("enter", self.keys())

    def test_label_mismatch_stops_without_enter(self):
        with self.assertRaisesRegex(bridge.BridgeError, "不一致"):
            self.answer(action="select", option=2, label="完全不同的选项")
        self.assertNotIn("enter", self.keys())

    def test_free_text_goes_into_the_input_row_and_is_verified_first(self):
        self.answer(action="text", option=3, text="放到 /var/log/demo")
        self.assertEqual(self.writes, [("keys", ["down"]), ("keys", ["down"]), ("text", "放到 /var/log/demo"), ("keys", ["enter"])])
        self.assertEqual(self.fake.submitted, 3)

    def test_free_text_that_never_shows_up_is_not_confirmed(self):
        self.fake.swallow_text = True
        with self.assertRaisesRegex(bridge.BridgeError, "没核对到"):
            self.answer(action="text", option=3, text="放到 /var/log/demo")
        self.assertNotIn("enter", self.keys())

    def test_free_text_rejects_newlines_and_regular_rows(self):
        for text in ("第一行\n第二行", "带\x1b控制符", " "):
            with self.assertRaises(bridge.BridgeError):
                self.answer(action="text", option=3, text=text)
        with self.assertRaisesRegex(bridge.BridgeError, "不能填写"):
            self.answer(action="text", option=1, text="随便")
        with self.assertRaisesRegex(bridge.BridgeError, "填写选项"):
            self.answer(action="select", option=3)
        with self.assertRaisesRegex(bridge.BridgeError, "没有这个选项"):
            self.answer(action="select", option=4)
        self.assertEqual(self.writes, [])

    def test_multi_select_toggles_only_differences_then_submits(self):
        self.fake = FakeMenu(["构建产物", "缓存", "Type something"], multi=True, checked={2}, input_row=3)
        self.answer(action="multi", options=[1])
        # 1 gets checked, 2 gets unchecked, then the submit row below the last option.
        self.assertEqual(self.keys(), ["enter", "down", "enter", "down", "down", "enter"])
        self.assertEqual(self.fake.checked, {1})
        self.assertEqual(self.fake.submitted, "submit")

    def test_multi_select_with_text_checks_the_input_row(self):
        self.fake = FakeMenu(["构建产物", "缓存", "Type something"], multi=True, input_row=3)
        self.answer(action="multi", options=[2], option=3, text="还有 tmp/")
        self.assertEqual(self.fake.checked, {2, 3})
        self.assertEqual(self.fake.submitted, "submit")
        self.assertIn(("text", "还有 tmp/"), self.writes)

    def test_multi_select_with_chat_row_below_submit(self):
        # The layout Claude Code really draws; typing into the input row checks it by itself.
        self.fake = FakeMenu(["选项一", "选项二", "选项三", "Type something", "Chat about this"], multi=True, input_row=4, chat_row=5)
        self.fake.auto_check = True
        self.answer(action="multi", options=[], option=4, text="全都不要")
        self.assertEqual(self.fake.checked, {4})
        self.assertEqual(self.fake.submitted, "submit")
        self.assertEqual(self.keys(), ["down", "down", "down", "down", "enter"])

    def test_option_scrolled_out_of_view_is_reached_and_verified(self):
        labels = ["选项一", "选项二", "选项三", "选项四", "Type something.", "Chat about this"]
        self.fake = FakeMenu(labels, input_row=5, chat_row=6)
        self.fake.window = 3
        self.assertNotIn("选项四", self.fake.screen())
        self.answer(action="select", option=4, label="选项四")
        self.assertEqual(self.keys(), ["down", "down", "down", "enter"])
        self.assertEqual(self.fake.submitted, 4)

    def test_hidden_option_with_a_different_label_is_not_confirmed(self):
        self.fake = FakeMenu(["选项一", "选项二", "选项三", "别的东西", "Type something.", "Chat about this"], input_row=5, chat_row=6)
        self.fake.window = 3
        with self.assertRaisesRegex(bridge.BridgeError, "不一致"):
            self.answer(action="select", option=4, label="选项四")
        self.assertNotIn("enter", self.keys())

    def test_cursor_skipping_rows_is_refused(self):
        # E.g. two arrow presses coalesced by the TUI: never guess, stop before Enter.
        self.fake = FakeMenu(["一", "二", "三", "四", "Type something.", "Chat about this"], input_row=5, chat_row=6)
        self.fake.jump = 2
        with self.assertRaisesRegex(bridge.BridgeError, "不一致"):
            self.answer(action="select", option=3, label="三")
        self.assertEqual(self.keys(), ["down"])

    def test_codex_menus_never_offer_free_text(self):
        screen = CODEX_QUESTION.replace("None of the above", "Other")
        self.assertFalse(any(r["input"] for r in bridge.parse_menu(screen, "codex")["options"]))
        self.assertFalse(any(r["input"] for r in bridge.parse_menu(CLAUDE_BASH.replace("3. No", "3. Other"), "claude")["options"]))

    def test_agent_must_be_blocked(self):
        self.agent["agent_status"] = "working"
        with self.assertRaisesRegex(bridge.BridgeError, "not waiting"):
            self.answer(action="select", option=2)
        self.assertEqual(self.writes, [])

    def test_identity_mismatch_is_refused(self):
        request = dict(v=1, op="answer", session="default", target="w1:p1", identity="0" * 64,
                       id="12345678-1234-1234-1234-123456789012", fingerprint=self.fingerprint(), action="select", option=2)
        with self.assertRaisesRegex(bridge.BridgeError, "changed or disappeared"):
            bridge.handle(request, self.state)
        self.assertEqual(self.writes, [])

    def test_read_attaches_menu_only_while_blocked(self):
        read = dict(v=1, op="read", session="default", target="w1:p1", identity=bridge.identity(self.agent))
        self.assertEqual(bridge.handle(read)["menu"]["cursor"], 1)
        self.agent["agent_status"] = "working"
        read["identity"] = bridge.identity(self.agent)
        self.assertNotIn("menu", bridge.handle(read))


if __name__ == "__main__":
    unittest.main()
