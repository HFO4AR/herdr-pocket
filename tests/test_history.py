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

    def test_sparse_internal_tail_does_not_hide_messages(self):
        self.write('codex', 'sparse.jsonl', [codex('user', 'visible earlier'),
            {'type': 'world_state', 'payload': 'x' * 3_000_000},
            {'type': 'event_msg', 'payload': {'type': 'token_count'}}])
        entries = bridge.transcript_catalog()
        page = bridge.history_page({'record_id': entries[0]['id']}, entries)
        self.assertEqual([x['text'] for x in page['messages']], ['visible earlier'])
        self.assertFalse(page['has_more'])

    def test_window_boundary_message_is_not_lost(self):
        rows = [codex('user', 'first'), codex('assistant', 'cross-boundary' + 'x' * 200_000)]
        rows += [{'type': 'event_msg', 'payload': {'type': 'token_count', 'padding': 'y' * 100_000}} for _ in range(19)]
        self.write('codex', 'boundary.jsonl', rows)
        entries = bridge.transcript_catalog()
        page = bridge.history_page({'record_id': entries[0]['id']}, entries)
        self.assertEqual(len(page['messages']), 2)
        self.assertTrue(page['messages'][1]['text'].startswith('cross-boundary'))
        self.assertFalse(page['has_more'])

    def test_no_discovery_from_cwd_or_arbitrary_uuid(self):
        thread = '11111111-2222-3333-4444-555555555555'
        self.assertEqual(bridge.explicit_session_ids(['sh', '-c', 'codex resume ' + thread], 'codex'), set())
        self.assertEqual(bridge.explicit_session_ids(['codex', 'explain ' + thread], 'codex'), set())
        self.assertEqual(bridge.explicit_session_ids(['codex', 'resume', thread], 'codex'), {thread})
        self.assertEqual(bridge.explicit_session_ids(['claude', '--resume=' + thread], 'claude'), {thread})

    def test_history_resolution_exact_process_resume_and_path(self):
        thread = '11111111-2222-3333-4444-555555555555'
        path = self.write('codex', 'root.jsonl', [{'type':'session_meta','payload':{'id':thread}},codex('user','hello')])
        entries = bridge.transcript_catalog()
        agent = {'agent':'codex','pane_id':'test:1','agent_session':None}
        info = {'process_info': {'foreground_processes':[{'pid':123,'argv':['codex','resume',thread]}]}}
        with patch.object(bridge,'call',return_value=info), patch.object(bridge,'process_snapshot',return_value=None):
            ref = bridge.resolve_agent_history(agent, [], entries)
        self.assertEqual(ref['record_id'], entries[0]['id'])
        self.assertEqual(ref['source'],'process')
        agent['agent_session'] = {'kind':'path','value':str(path)}
        self.assertEqual(bridge.resolve_agent_history(agent, [], entries)['thread'],thread)
        agent['agent_session']['value'] = '/outside/private.jsonl'
        self.assertEqual(bridge.resolve_agent_history(agent, [], entries)['status'],'missing')

    def test_history_resolution_fd_remote_and_ambiguity(self):
        paths = [self.write('codex', str(i)+'.jsonl', [{'type':'session_meta','payload':{'id':str(i)}},codex('user','same project')]) for i in range(2)]
        entries = bridge.transcript_catalog()
        agent = {'agent':'codex','pane_id':'test:1'}
        info = {'process_info': {'foreground_processes':[{'pid':123}]}}
        snapshots = {123:{'argv':['python3','relay.py'],'children':[124],'paths':[]},124:{'argv':['ssh','host'],'children':[],'paths':[]}}
        with patch.object(bridge,'call',return_value=info), patch.object(bridge,'process_snapshot',side_effect=snapshots.get):
            self.assertEqual(bridge.resolve_agent_history(agent, [], entries)['status'],'remote')
        snapshot = {'argv':['codex'],'children':[],'paths':paths}
        with patch.object(bridge,'call',return_value=info), patch.object(bridge,'process_snapshot',return_value=snapshot):
            self.assertEqual(bridge.resolve_agent_history(agent, [], entries)['status'],'ambiguous')
            snapshot['paths'] = paths[:1]
            self.assertEqual(bridge.resolve_agent_history(agent, [], entries)['status'],'matched')
            snapshot['paths'] = [self.home/'private.jsonl']
            self.assertEqual(bridge.resolve_agent_history(agent, [], entries)['status'],'unavailable')

    def test_duplicate_rollouts_of_same_thread_can_resolve(self):
        for name in ('old.jsonl','new.jsonl'):
            self.write('codex',name,[{'type':'session_meta','payload':{'id':'same-thread'}},codex('user','hello')])
        agent={'agent':'codex','pane_id':'test:1','agent_session':{'kind':'id','value':'same-thread'}}
        entries=bridge.transcript_catalog()
        ref=bridge.resolve_agent_history(agent,[],entries)
        self.assertEqual(ref['status'],'matched')
        self.assertEqual(ref['record_id'],entries[0]['id'])

    def test_ch_ssh_route_parser_only_accepts_live_attach(self):
        sid='11111111-2222-3333-4444-555555555555'
        argv=['ssh','-tt','-p','2222','-i','/fixture/key','-o','StrictHostKeyChecking=no','user@fixture.invalid',"exec /fixture/ch.route __native-attach '"+sid+"'",'']
        route=bridge.ch_ssh_route(argv)
        self.assertIsNotNone(route)
        self.assertNotIn('StrictHostKeyChecking=no',route['ssh'])
        self.assertEqual(route['workspace'],'~/.local/share/ch/workspaces/'+sid)
        self.assertIsNone(bridge.ch_ssh_route(['sh','-c',' '.join(argv)]))
        self.assertIsNone(bridge.ch_ssh_route(['ssh','host','echo __native-attach '+sid]))
        self.assertIsNone(bridge.ch_ssh_route(['ssh','host',"exec ch --state /tmp/../private __native-attach "+sid]))

    def test_remote_catalog_uses_one_host_fetch_and_does_not_guess(self):
        route={'ssh':['host'],'workspace':'~/workspaces/route','key':'fixture'}
        record={'id':'a'*64,'thread':'thread','provider':'claude','parent':None,'title':'fixture','cwd':'/remote/workspaces/route'}
        bridge._remote_catalog_cache.clear()
        self.addCleanup(bridge._remote_catalog_cache.clear)
        with patch.object(bridge,'remote_read',return_value={'records':[record],'home':'/remote'}) as read:
            first=bridge.remote_catalog(route,{'target':'one'})
            second=bridge.remote_catalog(dict(route,workspace='~/workspaces/other'),{'target':'two'})
        self.assertEqual(read.call_count,1)
        self.assertTrue(first[0]['route_match'])
        self.assertFalse(second[0]['route_match'])
        self.assertTrue(first[0]['id'].startswith('remote:fixture:'))

    def test_remote_request_revalidates_route_and_record_namespace(self):
        route={'ssh':['host'],'workspace':'~/workspaces/route','key':'fixture'}
        context={'session':'default','target':'test:1','identity':'snapshot'}
        record={'id':'a'*64,'thread':'thread','provider':'claude'}
        result={'record':record,'children':[],'messages':[],'before':0,'has_more':False}
        request={'op':'history','record_id':'remote:fixture:'+'a'*64,'remote':context}
        with patch.object(bridge,'route_for_context',return_value=route) as revalidate,patch.object(bridge,'remote_read',return_value=result):
            page=bridge.remote_history_request(request)
            self.assertEqual(page['record']['remote'],context)
            revalidate.assert_called_once_with(context)
            with self.assertRaises(bridge.BridgeError):bridge.remote_history_request(dict(request,record_id='remote:other:'+'a'*64))

    def test_remote_reader_stdin_executes_only_allowed_read_entry(self):
        import subprocess
        record=self.write('codex','remote.jsonl',[codex('user','synthetic message')])
        route={'ssh':['fixture.invalid'],'workspace':'/fixture','key':'fixture'}
        captured=[]
        def run(args,**kwargs):
            captured.append((args,kwargs))
            # Compile the actual remote payload to catch source embedding errors.
            compile(kwargs['input'],'remote-bridge','exec')
            self.assertNotIn('environ',kwargs['input'].split('request = json.loads(')[-1])
            return subprocess.CompletedProcess(args,0,'{"records":[],"home":"/fixture"}','')
        with patch.object(bridge.subprocess,'run',side_effect=run):
            bridge.remote_read(route,{'op':'catalog','workspace':'/fixture'})
        self.assertIn('StrictHostKeyChecking=yes',captured[0][0])
        self.assertIn('transcript_catalog(write_cache=False)',captured[0][1]['input'])
        with patch.object(bridge.subprocess,'run',return_value=subprocess.CompletedProcess([],1,'','private server error')):
            with self.assertRaisesRegex(bridge.BridgeError,'远端历史读取失败'):bridge.remote_read(route,{'op':'catalog','workspace':'/fixture'})

if __name__=='__main__':unittest.main()
