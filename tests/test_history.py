import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from test_bridge import bridge


def codex(role, text, **extra):
    return {"type": "response_item", "payload": {"type": "message", "role": role, "content": [{"type": "input_text" if role == "user" else "output_text", "text": text}], **extra}}


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        self.roots = [("codex", self.home / "codex"), ("claude", self.home / "claude")]
        for _, root in self.roots: root.mkdir()
        self.patch = patch.object(bridge, "transcript_roots", return_value=self.roots)
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.hp = patch.object(bridge.Path, "home", return_value=self.home)
        self.hp.start(); self.addCleanup(self.hp.stop)

    def write(self, provider, name, rows):
        root = dict(self.roots)[provider]; path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        return path

    def test_codex_messages_tools_and_private_reasoning(self):
        rows = [codex("user", "你好"), codex("assistant", "完成 **测试**"), codex("system", "secret instructions"),
                codex("assistant", "private thoughts", channel="analysis"),
                {"type": "response_item", "payload": {"type": "reasoning", "summary": ["hidden"]}},
                {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "arguments": '{"cmd":"pytest -q"}', "call_id": "a"}},
                {"type": "response_item", "payload": {"type": "function_call_output", "call_id": "a", "output": "2 passed"}}]
        values = sum([bridge.normalize_record(r, "codex", i) for i,r in enumerate(rows)], [])
        self.assertEqual([r["kind"] for r in values], ["user", "assistant", "tool", "result"])
        self.assertEqual(values[-2]["text"], "pytest -q")
        self.assertEqual(values[-2]["call_id"], values[-1]["call_id"])
        self.assertNotIn("private thoughts", json.dumps(values))

    def test_claude_tools_and_results(self):
        row = {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "private"}, {"type": "text", "text": "Testing"}, {"type": "tool_use", "name": "Bash", "id": "b", "input": {"command": "npm test"}}]}}
        values = bridge.normalize_record(row,"claude",0)
        self.assertEqual([x["kind"] for x in values],["assistant","tool"])
        self.assertEqual(values[1]["text"],"npm test")
        result=bridge.normalize_record({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"b","content":[{"type":"text","text":"OK"}]}]}},"claude",100)
        self.assertEqual(result[0]["call_id"],"b")
        self.assertEqual(result[0]["text"],"OK")

    def test_parent_and_child_discovery(self):
        self.write("codex","parent.jsonl",[{"type":"session_meta","payload":{"id":"root","cwd":"/work"}}])
        self.write("codex","child.jsonl",[{"type":"session_meta","payload":{"id":"child","parent_thread_id":"root","source":{"subagent":{"thread_spawn":{"parent_thread_id":"root"}}},"agent_nickname":"reviewer"}}])
        self.write("claude","project/root/subagents/agent-abc.jsonl",[{"type":"user","sessionId":"root","cwd":"/work","message":{"content":"check"}}])
        entries=bridge.transcript_catalog()
        parent=next(x for x in entries if x['thread']=='root')
        result=bridge.history_page({'record_id':parent['id']},entries)
        self.assertEqual([x['thread'] for x in result['children']],['child'])
        self.assertNotIn('_path',json.dumps(result))
        self.assertEqual(next(x for x in entries if x['provider']=='claude')['parent'],'root')

    def test_paging_is_stable_after_append(self):
        path=self.write('codex','root.jsonl',[codex('user',f'message {i}') for i in range(90)])
        entries=bridge.transcript_catalog();id=entries[0]['id']
        first=bridge.history_page({'record_id':id},entries)
        self.assertEqual(len(first['messages']),35)
        with path.open('a') as f:f.write(json.dumps(codex('assistant','new'))+'\n')
        second=bridge.history_page({'record_id':id,'before':first['before']},bridge.transcript_catalog())
        self.assertFalse(set(x['id'] for x in first['messages'])&set(x['id'] for x in second['messages']))
        self.assertEqual(second['messages'][-1]['text'],'message 54')

    def test_path_traversal_and_symlink_rejected(self):
        outside=self.home/'private.jsonl';outside.write_text(json.dumps(codex('user','private'))+'\n')
        (dict(self.roots)['codex']/'link.jsonl').symlink_to(outside)
        entries=bridge.transcript_catalog();self.assertEqual(entries,[])
        with self.assertRaises(bridge.BridgeError):bridge.history_page({'record_id':'../../private.jsonl'},entries)

    def test_partial_append_does_not_drop_prior_messages(self):
        path=self.write('codex','root.jsonl',[codex('user','complete')]);path.write_bytes(path.read_bytes()+b'{"type":')
        result=bridge.history_page({'record_id':bridge.transcript_catalog()[0]['id']},bridge.transcript_catalog())
        self.assertTrue(result['partial']);self.assertEqual(result['messages'][0]['text'],'complete')

    def test_oversized_record_progresses_cursor(self):
        self.write('codex','large.jsonl',[codex('user','x'*2_100_000),codex('assistant','end')])
        entries=bridge.transcript_catalog();page=bridge.history_page({'record_id':entries[0]['id']},entries)
        self.assertLess(page['before'],entries[0]['size'])
        self.assertEqual(page['messages'][-1]['text'],'end')

    def test_output_is_bounded_and_marked(self):
        value=bridge.normalize_record(codex('user','x'*20000),'codex',0)[0]
        self.assertEqual(len(value['text']),16000);self.assertTrue(value['truncated'])

    def test_account_only_contains_ssh_fields(self):
        self.assertEqual(set(bridge.ssh_info()),{'ssh_user','hostname'})

    def test_internal_guard_records_are_not_exposed(self):
        self.write('codex','guard.jsonl',[{'type':'session_meta','payload':{'id':'guard','source':{'subagent':{'other':'guardian'}}}},codex('assistant','internal')])
        self.assertEqual(bridge.transcript_catalog(),[])

    def test_nested_tool_output_is_readable(self):
        self.assertEqual(bridge.readable_output([{'type':'text','text':'{"output":"hello\\nworld","exit_code":0}'}]),'hello\nworld\nExit code: 0')

    def test_catalog_search_and_invalid_cursor(self):
        self.write('claude','a.jsonl',[{'type':'user','sessionId':'a','message':{'content':'find this title'}}])
        data=bridge.handle({'v':1,'op':'catalog','query':'find this'})
        self.assertEqual(data['total'],1)
        with self.assertRaises(bridge.BridgeError):bridge.handle({'v':1,'op':'history','record_id':data['records'][0]['id'],'before':-1})

if __name__=='__main__':unittest.main()
