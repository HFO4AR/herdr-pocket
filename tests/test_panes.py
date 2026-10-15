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
