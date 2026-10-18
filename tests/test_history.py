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

    def test_codex_phase_marks_progress_and_final_reply(self):
        rows = [codex("user", "改一下"), codex("assistant", "我先看一下代码。", phase="commentary"),
                codex("assistant", "改好了。", phase="final_answer"), codex("assistant", "旧版没有 phase")]
        values = sum([bridge.normalize_record(r, "codex", i) for i, r in enumerate(rows)], [])
        self.assertEqual([v.get("phase") for v in values], [None, "commentary", "final_answer", None])
        self.assertNotIn("phase", values[0])
        cited = bridge.normalize_record(codex("assistant", "已发布。\n\n<oai-mem-citation>\n<rollout_ids>x</rollout_ids>\n</oai-mem-citation>", phase="final_answer"), "codex", 9)[0]
        self.assertEqual(cited["text"], "已发布。")

    def test_codex_agent_message_shows_only_visible_payload(self):
        def message(text):
            return {"type": "response_item", "payload": {"type": "agent_message", "author": "/root/fix", "recipient": "/root",
                    "content": [{"type": "input_text", "text": text}, {"type": "encrypted_content", "encrypted_content": "gAAAA-secret"}]}}
        final = bridge.normalize_record(message("Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/fix\nPayload:\n修复完成。"), "codex", 0)[0]
        self.assertEqual((final["kind"], final["title"], final["text"], final["phase"]), ("agent", "/root/fix", "修复完成。", "final_answer"))
        hidden = bridge.normalize_record(message("Message Type: MESSAGE\nSender: /root/fix\nPayload:\n"), "codex", 1)[0]
        self.assertEqual(hidden["text"], "（内容只对 Agent 可见）")
        self.assertNotIn("gAAAA", json.dumps(hidden))

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

    def test_remote_resolution_batches_per_account_and_does_not_guess(self):
        route={'ssh':['host'],'workspace':'~/workspaces/route','key':'fixture'}
        other=dict(route,workspace='~/workspaces/other')
        record={'id':'a'*64,'thread':'thread','provider':'claude','parent':None,'title':'fixture','cwd':'/remote/workspaces/route'}
        nearby=dict(record,id='b'*64,thread='older')
        reply={'routes':{'~/workspaces/route':{'active':{'status':'matched','thread':'thread'},'record':record,'candidates':[]},
                         '~/workspaces/other':{'active':{'status':'unavailable','reason':'no id'},'record':None,'candidates':[nearby]}}}
        bridge._remote_results.clear(); self.addCleanup(bridge._remote_results.clear)
        with patch.object(bridge,'remote_read',return_value=reply) as read:
            bridge.prefetch_remote([(route,'claude'),(other,'claude')])
            first=bridge.remote_resolution(route,{'target':'one','provider':'claude'})
            second=bridge.remote_resolution(other,{'target':'two','provider':'claude'})
        self.assertEqual(read.call_count,1)
        self.assertEqual(len(read.call_args[0][1]['items']),2)
        self.assertEqual(first['status'],'matched');self.assertTrue(first['record_id'].startswith('remote:fixture:'))
        self.assertEqual(second['status'],'remote_candidates');self.assertNotIn('record_id',second)
        self.assertEqual(second['reason'],'no id')

    def test_remote_resolve_reads_only_workspace_project_directory(self):
        thread='11111111-2222-3333-4444-555555555555'
        workspace='/remote/ws/route'
        project=re_dir='-remote-ws-route'
        self.write('claude',project+'/'+thread+'.jsonl',[{'type':'user','sessionId':thread,'cwd':workspace,'message':{'content':'live'}}])
        self.write('claude',project+'/older.jsonl',[{'type':'user','sessionId':'older','cwd':workspace,'message':{'content':'old'}}])
        self.write('claude','-elsewhere/unrelated.jsonl',[{'type':'user','sessionId':'x','cwd':'/elsewhere','message':{'content':'no'}}])
        parsed=[]; real=bridge.record_meta
        def meta(path,provider): parsed.append(path.name); return real(path,provider)
        with patch.object(bridge,'record_meta',side_effect=meta),patch.object(bridge,'remote_active_history',return_value={'status':'matched','thread':thread}):
            live=bridge.remote_resolve([{'workspace':workspace,'provider':'claude'}])[workspace]
        self.assertEqual(live['record']['thread'],thread);self.assertEqual(live['candidates'],[])
        with patch.object(bridge,'record_meta',side_effect=meta),patch.object(bridge,'remote_active_history',return_value={'status':'unavailable'}):
            idle=bridge.remote_resolve([{'workspace':workspace,'provider':'claude'}])[workspace]
        self.assertIsNone(idle['record']);self.assertEqual({x['thread'] for x in idle['candidates']},{thread,'older'})
        self.assertNotIn('unrelated.jsonl',parsed)

    def test_codex_title_beats_stale_herdr_and_startup_resume(self):
        def make(thread,title):
            return self.write('codex',thread+'.jsonl',[{'type':'session_meta','payload':{'id':thread,'cwd':'/work/proj'}},codex('user',title)])
        make('stale','old'); make('live','new'); make('other','x')
        entries=bridge.transcript_catalog()
        agent={'agent':'codex','pane_id':'test:1','terminal_title':'接入飞书 | proj','cwd':'/work/proj','agent_session':{'value':'other'}}
        probe={'ids':{'stale'},'paths':set(),'active':set(),'route':None,'cwd':'/work/proj','remote':False,'ok':True}
        index=({'stale':'查找配置','live':'接入飞书','other':'别的'},{'stale','live','other'})
        ref=bridge.resolve_agent_history(agent,[],entries,index,probe)
        self.assertEqual((ref['status'],ref['thread'],ref['source']),('matched','live','title'))
        # Duplicate names are only trusted when exactly one of them is loaded.
        index=({'stale':'接入飞书','live':'接入飞书'},{'live'})
        self.assertEqual(bridge.resolve_agent_history(agent,[],entries,index,probe)['thread'],'live')
        index=({'stale':'接入飞书','live':'接入飞书'},{'live','stale'})
        self.assertEqual(bridge.resolve_agent_history(agent,[],entries,index,probe)['status'],'ambiguous')

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
        route={'ssh':['fixture.invalid'],'workspace':'/fixture','key':'fixture'}
        captured=[]
        def run(args,**kwargs):
            captured.append((args,kwargs))
            if '-O' in args: return subprocess.CompletedProcess(args,0,b'',b'')
            if kwargs['input'].startswith(b'0\n'): return subprocess.CompletedProcess(args,0,b'{"helper_missing": true}\n',b'')
            # Compile the actual remote payload to catch source embedding errors.
            size,rest=kwargs['input'].split(b'\n',1); program=rest[:int(size)]
            compile(program,'remote-bridge','exec')
            import inspect
            self.assertTrue(program.endswith(b'\nremote_main()\n'))
            self.assertNotIn('environ',inspect.getsource(bridge.remote_main)+inspect.getsource(bridge.remote_dispatch))
            self.assertEqual(json.loads(rest[int(size):]),{'op':'catalog','workspace':'/fixture'})
            return subprocess.CompletedProcess(args,0,b'{"records":[],"home":"/fixture"}',b'')
        with patch.object(bridge.subprocess,'run',side_effect=run):
            bridge.remote_read(route,{'op':'catalog','workspace':'/fixture'})
        self.assertIn('StrictHostKeyChecking=yes',captured[0][0])
        self.assertIn(b'scoped_records(',captured[1][1]['input'])
        with patch.object(bridge.subprocess,'run',return_value=subprocess.CompletedProcess([],1,b'',b'private server error')):
            with self.assertRaisesRegex(bridge.BridgeError,'连不上远端电脑'):bridge.remote_read(route,{'op':'catalog','workspace':'/fixture'})

    def test_active_native_runtime_session_beats_startup_resume(self):
        old='11111111-2222-3333-4444-555555555555'; current='22222222-2222-3333-4444-555555555555'
        snapshots={10:{'argv':['bash'],'children':[11],'start':'1'},11:{'argv':['claude','--resume',old],'active_threads':[current],'children':[12],'start':'2'},12:{'argv':['claude','--resume',old],'children':[],'start':'3'}}
        with patch.object(bridge,'process_snapshot',side_effect=snapshots.get):
            self.assertEqual(bridge.active_threads_in_pane(10,'claude'),current)
            self.assertEqual(bridge.active_threads_in_pane(10,'claude',11,'2'),current)
            with self.assertRaisesRegex(bridge.BridgeError,'已更换'): bridge.active_threads_in_pane(10,'claude',11,'wrong-start')
            with self.assertRaisesRegex(bridge.BridgeError,'不再属于'): bridge.active_threads_in_pane(10,'claude',99,'1')
            snapshots[11]['active_threads']=[];snapshots[11]['argv']=['claude']
            self.assertIsNone(bridge.active_threads_in_pane(10,'claude'))

    def test_route_metadata_selects_locator_fields_only(self):
        import sqlite3
        route_id='11111111-2222-3333-4444-555555555555'
        state=self.home/'state'; directory=state/'sessions'/route_id;directory.mkdir(parents=True)
        dbpath=directory/'session.sqlite'
        with sqlite3.connect(dbpath) as db:
            db.execute('CREATE TABLE session(singleton INTEGER,config TEXT)')
            db.execute('INSERT INTO session VALUES(1,?)',(json.dumps({'imported_tmux':{'socket':'/tmp/fixture.sock','session':'fixture','pane':'%4','pid':123,'start':456},'bridge':{'token':'never-return-this'}}),))
        db.close()
        statements=[];connect=sqlite3.connect
        def tracked(*args,**kwargs):
            self.assertIn('mode=ro&immutable=1',args[0]);db=connect(*args,**kwargs);db.set_trace_callback(statements.append);return db
        with patch.object(bridge.sqlite3,'connect',side_effect=tracked):
            binding=bridge.route_binding_metadata(state/'workspaces'/route_id)
        self.assertEqual(binding,{'socket':'/tmp/fixture.sock','session':'fixture','pane':'%4','pid':123,'start':456})
        self.assertTrue(all('json_extract(config' in statement for statement in statements))
        self.assertNotIn('token',str(binding));self.assertNotIn('bridge',str(statements))
        (directory/'native-route.json').write_text(json.dumps({'native_route':{'socket':'/tmp/migrated.sock','session':'migrated'}}))
        self.assertEqual(bridge.route_binding_metadata(state/'workspaces'/route_id)['socket'],'/tmp/migrated.sock')

    def test_remote_active_tmux_imported_pane_identity(self):
        import subprocess
        from types import SimpleNamespace
        binding={'socket':'/tmp/fixture.sock','session':'fixture','pane':'%2','pid':22,'start':100}
        response=subprocess.CompletedProcess([],0,'%1\t11\t0\t1\t1\n%2\t21\t0\t0\t1\n','')
        with patch.object(bridge,'route_binding_metadata',return_value=binding),patch.object(bridge.Path,'lstat',return_value=SimpleNamespace(st_mode=bridge.stat_module.S_IFSOCK,st_uid=bridge.os.getuid())),patch.object(bridge.subprocess,'run',return_value=response),patch.object(bridge,'active_threads_in_pane',return_value='native') as active:
            result=bridge.remote_active_history('/fixture')
        self.assertEqual(result['thread'],'native')
        self.assertEqual(active.call_args[0][:4],(21,'claude',22,100))

    def test_remote_follow_active_is_explicit_and_preserves_manual_older_history(self):
        self.write('claude','old.jsonl',[{'type':'user','sessionId':'old','message':{'content':'old message'}}])
        self.write('claude','current.jsonl',[{'type':'user','sessionId':'current','message':{'content':'active message'}}])
        catalog=bridge.transcript_catalog();old=next(x for x in catalog if x['thread']=='old');current=next(x for x in catalog if x['thread']=='current')
        request={'record_id':old['id'],'workspace':'/fixture','provider':'claude'}
        with patch.object(bridge,'remote_active_history',return_value={'status':'matched','thread':'current'}):
            manual=bridge.remote_history_page(request,catalog)
            live=bridge.remote_history_page(dict(request,follow_active=True),catalog)
            older=bridge.remote_history_page(dict(request,follow_active=True,before=old['size']),catalog)
        self.assertEqual(manual['record']['id'],old['id']);self.assertFalse(manual['active_changed'])
        self.assertEqual(live['record']['id'],current['id']);self.assertTrue(live['active_changed'])
        self.assertEqual(older['record']['id'],old['id'])
        self.assertEqual(live['messages'][0]['text'],'active message')

    def test_process_snapshot_reads_only_current_user_task_directory_links(self):
        real_path=Path; proc=self.home/'proc';pid=101;root=proc/str(pid)
        (root/'task'/str(pid)).mkdir(parents=True);(root/'fd').mkdir()
        (root/'task'/str(pid)/'children').write_text('')
        (root/'stat').write_text('101 (claude) '+' '.join(['0']*19+['123']))
        (root/'cmdline').write_bytes(b'claude\0')
        (root/'cwd').symlink_to(self.home)
        native='11111111-2222-3333-4444-555555555555'
        (root/'fd'/'7').symlink_to('/tmp/claude-'+str(bridge.os.getuid())+'/project/'+native+'/tasks')
        (root/'fd'/'8').symlink_to('/tmp/claude-'+str(bridge.os.getuid()+1)+'/project/22222222-2222-3333-4444-555555555555/tasks')
        (root/'fd'/'9').symlink_to('/private/auth.json')
        with patch.object(bridge,'Path',side_effect=lambda value:proc if value=='/proc' else real_path(value)):
            snapshot=bridge.process_snapshot(pid)
        self.assertEqual(snapshot['active_threads'],[native])
        self.assertEqual(snapshot['start'],'123')
        self.assertEqual(snapshot['paths'],[])

    def test_targeted_remote_history_skips_unrelated_metadata(self):
        current=self.write('claude','project/current.jsonl',[{'type':'user','sessionId':'current','message':{'content':'active'}}])
        self.write('claude','project/other.jsonl',[{'type':'user','sessionId':'other','message':{'content':'unrelated'}}])
        self.write('claude','project/current/subagents/agent-child.jsonl',[{'type':'user','sessionId':'current','message':{'content':'child'}}])
        record=next(x for x in bridge.transcript_catalog() if x['thread']=='current' and not x['parent'])
        original=bridge.record_meta;read=[]
        def meta(path,provider):read.append(path.name);return original(path,provider)
        with patch.object(bridge,'record_meta',side_effect=meta):
            catalog=bridge.catalog_for_history(record['id'],'claude')
        self.assertEqual(len(catalog),2)
        self.assertNotIn('other.jsonl',read)
        page=bridge.history_page({'record_id':record['id']},catalog)
        self.assertEqual(len(page['children']),1)


    def test_forked_codex_subagent_is_a_child_not_a_copy_of_its_parent(self):
        parent='01a13593-0000-0000-0000-000000000001'; child='01a13e78-0000-0000-0000-000000000002'
        rows=[{'ordinal':0,'type':'session_meta','payload':{'id':child,'parent_thread_id':parent,'cwd':'/w','agent_path':'/root/history_fix','agent_nickname':'Peirce','subagent_history_start_ordinal':3,'source':{'subagent':{'thread_spawn':{'parent_thread_id':parent}}}}},
              {'ordinal':1,'type':'session_meta','payload':{'id':parent,'cwd':'/w'}},
              dict(codex('user','parent prompt copied into the fork'),ordinal=2),
              dict(codex('user','find why history is missing'),ordinal=3),
              dict(codex('assistant','found it'),ordinal=4)]
        self.write('codex','child.jsonl',rows)
        entry=next(x for x in bridge.transcript_catalog() if x['thread']==child)
        self.assertEqual((entry['parent'],entry['role'],entry['title']),(parent,'history_fix','find why history is missing'))
        texts=[m['text'] for m in bridge.history_page({'record_id':entry['id']},[entry])['messages']]
        self.assertEqual(texts,['find why history is missing','found it'])

    def test_claude_subagent_uses_meta_description(self):
        self.write('claude','proj/sess/subagents/agent-abc.jsonl',[{'type':'user','sessionId':'sess','message':{'content':'You are the follow agent. Long brief...'}}])
        (self.home/'claude/proj/sess/subagents/agent-abc.meta.json').write_text(json.dumps({'agentType':'general-purpose','description':'Follow pane session changes'}))
        entry=next(x for x in bridge.transcript_catalog() if x['thread']=='abc')
        self.assertEqual((entry['parent'],entry['title'],entry['role']),('sess','Follow pane session changes','general-purpose'))


if __name__=='__main__':unittest.main()
