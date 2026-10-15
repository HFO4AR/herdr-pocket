import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from test_bridge import bridge

CLAUDE_THREAD = "11111111-2222-4333-8444-555555555555"
CODEX_THREAD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"


def claude(kind, content, ts="2026-10-15T08:00:00.000Z", **extra):
    return {"type": kind, "timestamp": ts, "cwd": "/work/demo", "sessionId": CLAUDE_THREAD, "message": {"role": kind, "content": content}, **extra}


def codex(payload, ts="2026-10-15T08:00:00.000Z"):
    return {"type": "response_item", "timestamp": ts, "payload": payload}


def codex_msg(role, text, phase=None, ts="2026-10-15T08:00:00.000Z"):
    p = {"type": "message", "role": role, "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}]}
    if phase: p["phase"] = phase
    return codex(p, ts)


class GlanceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.roots = [("codex", self.home / "codex"), ("claude", self.home / "claude")]
        for _, root in self.roots: root.mkdir()
        for target, value in (("transcript_roots", self.roots),):
            p = patch.object(bridge, target, return_value=value); p.start(); self.addCleanup(p.stop)
        p = patch.object(bridge.Path, "home", return_value=self.home); p.start(); self.addCleanup(p.stop)

    def write(self, provider, rel, rows, prefix=""):
        root = dict(self.roots)[provider]; path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(prefix + "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        return path

    def key(self, provider, rel):
        return hashlib.sha256((provider + ":" + rel).encode()).hexdigest()

    def claude_item(self, rel, **extra):
        return dict({"key": "default/a", "provider": "claude", "thread": CLAUDE_THREAD, "record_id": self.key("claude", rel), "cwd": "/work/demo"}, **extra)

    def ask(self, *items):
        return bridge.handle({"v": 1, "op": "glance", "items": list(items)})["previews"]

    def test_claude_finished_turn_reply_and_counts(self):
        rel = "-work-demo/" + CLAUDE_THREAD + ".jsonl"
        self.write("claude", rel, [
            claude("user", "修一下登录页的样式"),
            claude("assistant", [{"type": "tool_use", "id": "t1", "name": "Edit", "input": {"file_path": "/work/demo/a.css", "old_string": "x", "new_string": "y"}}]),
            claude("user", [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]),
            claude("assistant", [{"type": "tool_use", "id": "t2", "name": "Write", "input": {"file_path": "/work/demo/b.css", "content": "z"}}]),
            claude("user", [{"type": "tool_result", "tool_use_id": "t2", "content": "ok"}]),
            claude("assistant", [{"type": "tool_use", "id": "t3", "name": "Bash", "input": {"command": "npm test"}}]),
            claude("user", [{"type": "tool_result", "tool_use_id": "t3", "content": "boom", "is_error": True}]),
            claude("assistant", [{"type": "text", "text": "## 改好了\n\n**登录页**的 `按钮` 已对齐。\n- 细节"}], ts="2026-10-15T08:05:00.000Z"),
        ])
        out = self.ask(self.claude_item(rel))["default/a"]
        self.assertEqual(out["task"]["text"], "修一下登录页的样式")
        self.assertEqual(out["reply"]["text"], "改好了")
        self.assertTrue(out["reply"]["current"])
        self.assertEqual(out["turn"], {"tools": 3, "files": 2, "failed": 1})
        self.assertEqual(out["at"], "2026-10-15T08:05:00.000Z")
        self.assertEqual(out["activity"]["kind"], "note")
        self.assertTrue(out["stamp"])

    def test_claude_pending_question_and_running_command(self):
        rel = "-work-demo/" + CLAUDE_THREAD + ".jsonl"
        self.write("claude", rel, [
            claude("user", "发布吗"),
            claude("assistant", [{"type": "tool_use", "id": "q", "name": "AskUserQuestion", "input": {"questions": [{"question": "现在就发 0.6.0 吗？\n第二行", "options": []}]}}]),
        ])
        out = self.ask(self.claude_item(rel))["default/a"]
        self.assertEqual(out["activity"], {"verb": "ask", "text": "现在就发 0.6.0 吗？", "kind": "tool", "at": "2026-10-15T08:00:00.000Z", "open": True})
        self.assertNotIn("reply", out)
        self.write("claude", rel, [
            claude("user", "跑测试"),
            claude("assistant", [{"type": "text", "text": "先跑一下全量测试。"}]),
            claude("assistant", [{"type": "tool_use", "id": "b", "name": "Bash", "input": {"command": "python3 -m unittest discover -s tests\necho done"}}]),
        ])
        out = self.ask(self.claude_item(rel))["default/a"]
        self.assertEqual(out["activity"]["verb"], "run")
        self.assertEqual(out["activity"]["text"], "python3 -m unittest discover -s tests")
        self.assertTrue(out["activity"]["open"])
        # The previous turn's reply is not this turn's.
        self.assertTrue(out["reply"]["current"])

    def test_codex_final_answer_commentary_and_patch(self):
        rel = "2026/10/15/rollout-2026-10-15T08-00-00-" + CODEX_THREAD + ".jsonl"
        self.write("codex", rel, [
            {"type": "session_meta", "payload": {"id": CODEX_THREAD, "cwd": "/work/demo"}},
            codex_msg("user", "把缓存加上"),
            codex_msg("assistant", "我先看看缓存层。", phase="commentary"),
            codex({"type": "custom_tool_call", "name": "apply_patch", "call_id": "p", "input": "*** Begin Patch\n*** Update File: ui/cache.js\n*** Add File: ui/x.js\n*** End Patch"}),
            codex({"type": "custom_tool_call_output", "call_id": "p", "output": "ok"}),
            codex({"type": "function_call", "name": "exec_command", "call_id": "c", "arguments": json.dumps({"cmd": "npm test"})}),
        ])
        item = {"key": "s/b", "provider": "codex", "thread": CODEX_THREAD, "record_id": self.key("codex", rel)}
        out = self.ask(item)["s/b"]
        self.assertEqual(out["activity"]["verb"], "run"); self.assertEqual(out["activity"]["text"], "npm test"); self.assertTrue(out["activity"]["open"])
        self.assertEqual(out["turn"]["files"], 2)
        self.assertNotIn("reply", out)  # commentary is progress, not the reply
        path = self.write("codex", rel, [codex_msg("user", "把缓存加上"), codex_msg("assistant", "缓存加好了，测试都过了。", phase="final_answer")])
        out = self.ask(item)["s/b"]
        self.assertEqual(out["reply"]["text"], "缓存加好了，测试都过了。")
        # Unchanged file: stat only.
        again = self.ask(dict(item, stamp=out["stamp"]))["s/b"]
        self.assertEqual(again, {"same": True, "stamp": out["stamp"]})

    def test_reads_only_the_tail(self):
        rel = "-work-demo/" + CLAUDE_THREAD + ".jsonl"
        filler = [claude("user", "旧消息 " + "x" * 2000) for _ in range(800)]
        self.write("claude", rel, filler + [claude("user", "最新任务"), claude("assistant", [{"type": "text", "text": "完成"}])])
        reads = []
        real = bridge.glance_tail
        def spy(path, provider, window, modes=None):
            reads.append(window); return real(path, provider, window, modes)
        with patch.object(bridge, "glance_tail", side_effect=spy):
            out = self.ask(self.claude_item(rel))["default/a"]
        self.assertEqual(out["reply"]["text"], "完成")
        self.assertEqual(reads, [bridge.GLANCE_WINDOWS[0]])

    def test_rejects_unknown_or_mismatched_records(self):
        rel = "-work-demo/" + CLAUDE_THREAD + ".jsonl"
        self.write("claude", rel, [claude("user", "hi")])
        outside = self.home / "secret.jsonl"; outside.write_text("{}\n")
        bad = [
            self.claude_item(rel, key="wrong-id", record_id="0" * 64),
            self.claude_item(rel, key="traversal", thread="../../secret"),
            self.claude_item(rel, key="provider", provider="bash"),
            self.claude_item(rel, key="codex-mismatch", provider="codex"),
        ]
        out = self.ask(*bad)
        for k in ("wrong-id", "traversal", "provider", "codex-mismatch"): self.assertEqual(out[k], {"missing": True}, k)
        link = dict(self.roots)["claude"] / "-work-demo" / (CODEX_THREAD + ".jsonl"); link.symlink_to(outside)
        out = self.ask(self.claude_item("-work-demo/" + CODEX_THREAD + ".jsonl", key="link", thread=CODEX_THREAD))
        self.assertEqual(out["link"], {"missing": True})
        with self.assertRaises(bridge.BridgeError): self.ask(*[self.claude_item(rel)] * 41)

    def test_codex_script_tools(self):
        run = bridge.glance_tool("exec", 'text(await tools.exec_command({cmd:"npm test -- --grep \\"a}b\\"\\necho ok","max_output_tokens":500}));\n')
        self.assertEqual(run, {"verb": "run", "text": 'npm test -- --grep "a}b"'})
        patch_call = 'text(await tools.apply_patch("*** Begin Patch\\n*** Update File: app/x.js\\n@@\\n*** Add File: y.css\\n*** End Patch"));'
        self.assertEqual(bridge.glance_tool("exec", patch_call), {"verb": "edit", "text": "x.js, y.css"})
        files = set(); bridge.glance_edits({"title": "exec", "text": patch_call}, files)
        self.assertEqual(files, {"app/x.js", "y.css"})
        self.assertEqual(bridge.glance_tool("exec", "text(ALL_TOOLS.length)"), {"verb": "run", "text": ""})
        self.assertEqual(bridge.glance_tool("request_user_input_async", json.dumps({"questions": [{"title": "选哪个？"}]})), {"verb": "ask", "text": "选哪个？"})
        ask = 'await tools.request_user_input_async({questions:[{id:"q",question:"现在发布？","options":[]}]})'
        self.assertEqual(bridge.glance_tool("exec", ask), {"verb": "ask", "text": "现在发布？"})
        self.assertEqual(bridge.glance_tool("sleep", '{"duration_ms": 5}')["verb"], "wait")

    def test_line_cleanup(self):
        self.assertEqual(bridge.glance_line("```py\ncode\n```\n> **注意**：[链接](http://x) 好了"), "注意：链接 好了")
        self.assertEqual(bridge.glance_line("1. 第一步\n2. 第二步"), "第一步")
        self.assertEqual(len(bridge.glance_line("长" * 500)), bridge.GLANCE_TEXT)


if __name__ == "__main__":
    unittest.main()
