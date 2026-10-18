import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from test_bridge import bridge

class PaneTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.pane={'pane_id':'w2:p7','terminal_id':'shell-7','tab_id':'w2:t1'}
        self.calls=[]
        self.mock=patch.object(bridge,'call',side_effect=self.call);self.mock.start();self.addCleanup(self.mock.stop)
    def call(self,args):
        self.calls.append(args)
        if args==['session','list','--json']:return {'sessions':[{'name':'default','running':True}]}
        if args[-2:]==['workspace','list']:return {'workspaces':[{'workspace_id':'w2','label':'work'}]}
        if 'list' in args and 'pane' in args:return {'panes':[self.pane,dict(self.pane,pane_id='w2:p8',agent='codex')]}
        if 'get' in args:return {'pane':self.pane}
        return {'text':'shell output'}
    def req(self,op='paneRun'):
        return dict(v=1,op=op,session='default',target='w2:p7',identity=bridge.identity(self.pane),text='printf hello',id='12345678-1234-1234-1234-123456789012')
    def test_all_workspace_shells_only(self):
        panes=bridge.handle({'v':1,'op':'panes','session':'default'})['panes']
        self.assertEqual([p['pane_id'] for p in panes],['w2:p7'])
        self.assertIn(['--session','default','pane','list','--workspace','w2'],self.calls)
    def test_run_and_retry_once(self):
        req=self.req();state=Path(self.tmp.name)
        first=bridge.handle(req,state);self.assertEqual(first,bridge.handle(req,state))
        self.assertEqual(sum('run' in args for args in self.calls),1)
    def test_replaced_terminal_or_new_agent_blocks_input(self):
        req=self.req();self.pane['terminal_id']='other'
        with self.assertRaisesRegex(bridge.BridgeError,'changed'):bridge.handle(req,Path(self.tmp.name))
        self.pane['terminal_id']='shell-7';self.pane['agent']='codex'
        with self.assertRaisesRegex(bridge.BridgeError,'Agent'):bridge.handle(req,Path(self.tmp.name))
        self.assertFalse(any('run' in args for args in self.calls))
    def test_text_without_enter_and_allowed_keys(self):
        r=self.req('paneText');bridge.handle(r,Path(self.tmp.name));self.assertIn(['--session','default','pane','send-text','w2:p7','printf hello'],self.calls)
        r=self.req('paneKey');r['key']='tab';r['id']='22345678-1234-1234-1234-123456789012';bridge.handle(r,Path(self.tmp.name))
        self.assertIn(['--session','default','pane','send-keys','w2:p7','tab'],self.calls)
    def test_invalid_target_and_keys_rejected(self):
        r=self.req();r['target']='--current'
        with self.assertRaises(bridge.BridgeError):bridge.handle(r)
        r=self.req('paneKey');r['key']='ctrl+unknown'
        with self.assertRaises(bridge.BridgeError):bridge.handle(r,Path(self.tmp.name))

    def test_command_text_cannot_be_mistaken_for_cli_group(self):
        from types import SimpleNamespace
        self.mock.stop()
        response=SimpleNamespace(returncode=0,stdout='{"result":{"sent":true}}',stderr='')
        with patch.object(bridge.subprocess,'run',return_value=response):
            self.assertEqual(bridge.call(['--session','default','pane','run','w2:p7','agent']),{'sent':True})
            self.assertEqual(bridge.call(['--session','default','pane','run','w2:p7','pane']),{'sent':True})


class ListPaneTests(unittest.TestCase):
    """The 会话 list's ordinary panes (`agents` / `status` with `panes: true`): tab labels and what
    runs in front, process names only. Herdr is a recorded fake; nothing is sent to a pane."""
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.calls=[];self.fail=set()
        self.panes={'w2':[{'pane_id':'w2:p1','terminal_id':'t1','tab_id':'w2:t1','cwd':'/home/u/a'},
                          {'pane_id':'w2:p2','terminal_id':'t2','tab_id':'w2:t2','cwd':'/home/u/a'},
                          {'pane_id':'w2:p3','terminal_id':'t3','tab_id':'w2:t1','agent':'codex'}],
                    'w5':[{'pane_id':'w5:p1','terminal_id':'t4','tab_id':'w5:t1'},{'pane_id':'w5:p2','terminal_id':'t5','tab_id':'w5:t1'},
                          {'pane_id':'w5:p3','terminal_id':'t6','tab_id':'w5:t1'},{'pane_id':'w5:p4','terminal_id':'t7','tab_id':'w5:t1'}]}
        relay=['python3','-c','relay',json.dumps(['ssh','-tt','box','exec ch --state ~/.local/share/ch __native-attach 12345678-1234-1234-1234-123456789012'])]
        self.fg={'w2:p1':[['/usr/bin/zsh']],'w2:p2':[['npm','run','dev','--token=SECRET'],['node','server.js']],
                 'w5:p1':[['tmux','attach','-t','main']],'w5:p2':[['herdr']],'w5:p3':[relay],'w5:p4':[['ssh','box']]}
        p=patch.object(bridge,'call',side_effect=self.call);p.start();self.addCleanup(p.stop)
    def call(self,args):
        self.calls.append(args);cmd=args[2:]
        if args==['session','list','--json']:return {'sessions':[{'name':'default','running':True}]}
        if cmd==['workspace','list']:return {'workspaces':[{'workspace_id':'w2','label':'work'},{'workspace_id':'w5','label':'ops'}]}
        if cmd==['tab','list']:
            if 'tabs' in self.fail:raise bridge.BridgeError('tab list broke')
            return {'tabs':[{'tab_id':'w2:t1','label':'2'},{'tab_id':'w2:t2','label':'服务'},{'tab_id':'w5:t1','label':'1'}]}
        if cmd[:2]==['pane','list']:
            if 'panes' in self.fail:raise bridge.BridgeError('pane list broke')
            return {'panes':self.panes[cmd[-1]]}
        if cmd[:2]==['pane','process-info']:
            pid=cmd[-1]
            if pid in self.fail:raise bridge.BridgeError('gone')
            return {'process_info':{'pane_id':pid,'foreground_processes':[{'argv':a,'name':Path(a[0]).name,'pid':i+10} for i,a in enumerate(self.fg[pid])]}}
        if cmd[:2]==['agent','list']:return {'agents':[{'pane_id':'w2:p3','terminal_id':'t3','agent':'codex','agent_status':'working'}]}
        raise AssertionError('unexpected herdr call '+repr(args))
    def status(self,**kw):
        return bridge.handle(dict(v=1,op='status',session='default',**kw),Path(self.tmp.name))
    def test_status_with_panes_names_tab_and_kind(self):
        r=self.status(panes=True)
        self.assertEqual([a['pane_id'] for a in r['agents']],['w2:p3'])
        got={p['pane_id']:(p.get('kind'),p.get('foreground'),p.get('tab_label'),p['workspace_label']) for p in r['panes']}
        self.assertEqual(got,{'w2:p1':('shell','zsh','2','work'),'w2:p2':('run','npm','服务','work'),'w5:p1':('tmux','tmux','1','ops'),
                              'w5:p2':('herdr','herdr','1','ops'),'w5:p3':('ch','python3','1','ops'),'w5:p4':('ssh','ssh','1','ops')})
        self.assertTrue(all(p['identity']==bridge.identity(p) for p in r['panes']))
        # Arguments never leave the computer: only process names.
        self.assertNotIn('SECRET',json.dumps(r));self.assertNotIn('argv',json.dumps(r['panes']))
        self.assertFalse(any(c[2:3]==['pane'] and c[3] in ('run','send-text','send-keys','close') for c in self.calls if len(c)>3))
    def test_without_flag_no_pane_reads(self):
        r=self.status()
        self.assertNotIn('panes',r)
        self.assertFalse(any('process-info' in c or c[2:]==['tab','list'] for c in self.calls))
    def test_failures_keep_agents(self):
        self.fail={'tabs','w2:p2'}
        r=self.status(panes=True);p={x['pane_id']:x for x in r['panes']}
        self.assertNotIn('tab_label',p['w2:p1']);self.assertNotIn('kind',p['w2:p2']);self.assertEqual(p['w2:p1']['kind'],'shell')
        self.fail={'panes'}
        r=self.status(panes=True)
        self.assertNotIn('panes',r);self.assertEqual([a['pane_id'] for a in r['agents']],['w2:p3'])
    def test_terminals_tab_listing_unchanged(self):
        r=bridge.handle({'v':1,'op':'panes','session':'default'})
        self.assertEqual(len(r['panes']),6);self.assertFalse(any('kind' in p or 'tab_label' in p for p in r['panes']))
        self.assertFalse(any('process-info' in c for c in self.calls))
    def test_pane_kind_edges(self):
        self.assertIsNone(bridge.pane_kind(None));self.assertIsNone(bridge.pane_kind({'foreground_processes':[]}))
        self.assertEqual(bridge.pane_kind({'foreground_processes':[{'argv':['-zsh']}]}),{'kind':'shell','foreground':'zsh'})
        self.assertEqual(bridge.pane_kind({'foreground_processes':[{'argv':[],'name':'cargo'}]}),{'kind':'run','foreground':'cargo'})
        self.assertEqual(bridge.pane_kind({'foreground_processes':[{'argv':['python3','/home/u/.local/bin/ch','--host','b','resume','x']}]})['kind'],'ch')
