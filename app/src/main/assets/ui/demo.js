'use strict';
// Offline demo fixtures: never connect to a host or send input.
const demoAgents=[{pane_id:'demo:1',identity:'demo-codex',agent:'codex',agent_status:'idle',terminal_title:'把移动端做成真正的聊天工具',cwd:'/home/demo/projects/pocket',agent_session:{value:'demo-root'}},{pane_id:'demo:2',identity:'demo-claude',agent:'claude',agent_status:'working',terminal_title:'检查接口与回归测试',cwd:'/home/demo/projects/pocket',agent_session:{value:'demo-claude'}},{pane_id:'demo:3',identity:'demo-review',agent:'codex',agent_status:'blocked',terminal_title:'清理构建缓存',cwd:'/home/demo/projects/site',agent_session:{value:'demo-review'}}];
const demoRecords=[{id:'demo-root',thread:'demo-root',provider:'codex',parent:null,title:'把移动端做成真正的聊天工具',cwd:'/home/demo/projects/pocket',modified:Date.now()/1000-300},{id:'demo-child',thread:'demo-child',provider:'codex',parent:'demo-root',title:'布局检查 · 子 Agent',cwd:'/home/demo/projects/pocket',modified:Date.now()/1000-240},{id:'demo-claude',thread:'demo-claude',provider:'claude',parent:null,title:'检查接口与回归测试',cwd:'/home/demo/projects/pocket',modified:Date.now()/1000-90000},{id:'demo-review',thread:'demo-review',provider:'codex',parent:null,title:'清理构建缓存',cwd:'/home/demo/projects/site',modified:Date.now()/1000-60}];
function demoMessage(id,kind,text,title='',call_id='',phase=''){const m={id:id+':0',kind,text,title,call_id,timestamp:new Date(Date.now()-1500000+id*30000).toISOString()};if(phase)m.phase=phase;return m;}
const demoNote=(id,text)=>demoMessage(id,'assistant',text,'','','commentary');
const demoReply=(id,text)=>demoMessage(id,'assistant',text,'','','final_answer');
// Realistic turns: progress notes and commands fold into 「工作过程」, the reply stays prominent.
function demoHistory(id,older){
 if(older)return [demoMessage(1,'user','先把连接设备和密码保存做好。'),demoNote(2,'我先看看现在设备资料存在哪里。'),demoMessage(3,'tool','rg -n "password" app/src/main','exec_command','old-1'),demoMessage(4,'result','SecureProfiles.kt:41: // password stays in memory only\nProcess exited with code 0','执行结果','old-1'),demoReply(5,'改好了：连接资料和密码会用本机密钥加密保存，卸载应用后一起清除。')];
 if(id==='demo-child')return [demoMessage(1,'user','请检查小屏和横屏的输入栏。'),demoNote(2,'我按 320、390 和横屏三种尺寸各截一张图。'),demoMessage(3,'tool','node scripts/shots.cjs --sizes 320x640,390x844,844x390','exec_command','k1'),demoMessage(4,'result','3 screenshots written\nProcess exited with code 0','执行结果','k1'),demoReply(5,'子 Agent：布局检查完成。\n\n输入栏保持可见，长命令可展开阅读。')];
 if(id==='demo-claude')return [demoMessage(1,'user','先跑一遍接口回归，有失败就告诉我。'),demoMessage(2,'assistant','我先跑一遍完整的接口回归。'),demoMessage(3,'tool','python3 -m unittest discover -s tests','Bash','c0'),demoMessage(4,'result','FAIL: test_history_cursor (test_history.HistoryTests)\nAssertionError: 35 != 34\nExit code 1','执行失败','c0'),demoMessage(5,'assistant','有 1 个失败：**分页游标少算了一条**。\n\n问题出在跨窗口的记录被跳过了，要我修吗？'),
  demoMessage(6,'user','修一下，顺便检查接口。'),demoMessage(7,'assistant','正在检查接口与回归测试。\n\n这是 Claude 的独立会话。'),demoMessage(8,'tool','{"file_path":"bridge/pocket_bridge.py"}','Read','c1'),demoMessage(9,'result','#!/usr/bin/env python3\n"""Herdr Pocket protocol v1."""','执行结果','c1'),demoMessage(10,'user','<task-notification>\n<task-id>demo</task-id>\n<status>completed</status>\n<summary>后台构建已完成</summary>\n</task-notification>'),demoMessage(11,'tool','python3 -m unittest discover -s tests','Bash','c2')];
 if(id==='demo-review')return [demoMessage(1,'user','把 dist 和缓存目录清掉。'),demoNote(2,'这会删除构建产物，先让你确认一下。'),demoMessage(3,'tool','rm -rf dist .cache','exec_command','c9')];
 const log=['npm test 挂了，日志如下：','','> pocket@0.5.0 test','> node scripts/test_ui.cjs','','PASS: device form','PASS: persistent SSH stages','FAIL: chat timeline','  expected 2 turns, got 1','  at renderTimeline (timeline.js:88)','  at fetchHistory (app.js:192)','','Error: 1 test failed','Exit code 1'].join('\n');
 return [demoMessage(10,'user','历史记录、子 Agent 和执行的命令都要能看到。'),
  demoNote(11,'我先看一下历史读取和子 Agent 关联现在是怎么做的。'),demoMessage(12,'tool','{"cmd":"rg -n \\"history_ref\\" app"}','exec_command','demo-call-2'),demoMessage(13,'result','app.js:53: const ref=a.history_ref;','执行结果','demo-call-2'),demoMessage(14,'tool','sed -n 1,80p bridge/pocket_bridge.py','exec_command','demo-call-3'),demoMessage(15,'result','#!/usr/bin/env python3\n"""Herdr Pocket protocol v1."""\nProcess exited with code 0','执行结果','demo-call-3'),
  demoNote(16,'历史能读到，问题在**子 Agent 没挂到父会话上**。我把关联改成按线程 ID 匹配，再派一个子 Agent 检查小屏布局。'),demoMessage(17,'tool','*** Begin Patch\n*** Update File: bridge/pocket_bridge.py\n@@\n-    parent = None\n+    parent = meta.get("parent_thread")\n*** End Patch','apply_patch','demo-call-4'),demoMessage(18,'result','Success. Updated the following files:\nM bridge/pocket_bridge.py','执行结果','demo-call-4'),
  demoMessage(19,'tool','{"task_name":"layout_check","message":"检查小屏和横屏的输入栏"}','spawn_agent','demo-call-5'),demoMessage(20,'result','{"agent_path":"/root/layout_check"}','执行结果','demo-call-5'),
  demoMessage(21,'tool','python3 -m unittest discover -s tests -v','exec_command','demo-call'),demoMessage(22,'result','Ran 24 tests in 0.08s\nOK\nProcess exited with code 0','执行结果','demo-call'),demoMessage(23,'agent','布局检查完成：输入栏在 320 宽和横屏下都可见。','/root/layout_check','','final_answer'),
  demoReply(24,'我把它们整理到同一个对话里：\n\n- **对话**按轮次展示，过程折叠，回复突出\n- **命令**展示具体执行内容\n- 子 Agent 可以独立切换\n\n| 视图 | 内容 |\n|---|---|\n| 对话 | 你的问题、折叠的工作过程、最终回复 |\n| 命令 | 全部命令和输出 |'),
  demoMessage(30,'user',log),demoNote(31,'看日志是时间线把两轮合成了一轮，我先复现。'),demoMessage(32,'tool','node scripts/test_ui.cjs','exec_command','demo-call-6'),demoMessage(33,'result','FAIL: chat timeline\nError: 1 test failed\nProcess exited with code 1','执行结果','demo-call-6'),
  demoNote(34,'复现了：用户消息没有作为轮次边界。改好后重跑。'),demoMessage(35,'tool','*** Begin Patch\n*** Update File: app/src/main/assets/ui/timeline.js\n@@\n-if(user&&turn.entries.length)\n+if(user)\n turns.push(turn=newTurn(m));\n*** End Patch','apply_patch','demo-call-7'),demoMessage(36,'result','Success.','执行结果','demo-call-7'),demoMessage(37,'tool','node scripts/test_ui.cjs','exec_command','demo-call-8'),demoMessage(38,'result','PASS: chat timeline\nProcess exited with code 0','执行结果','demo-call-8'),
  demoReply(39,'测试都通过了。点开「工作过程」可以看到每条命令和输出，或者点右上角切换到「布局检查」子 Agent。\n\n```bash\nnpm test\n```')];}
// What the bridge's parse_menu returns for the blocked demo screen below.
const demoMenu={kind:'approval',multi:false,cursor:1,question:'Would you like to run the following command?',context:['Would you like to run the following command?','','$ rm -rf dist .cache'],tabs:[],submit:null,fingerprint:'ed05eda4267b6f92559a',
 options:[{n:1,label:'Yes, proceed',description:'',checked:null,chosen:false,input:false,chat:false},{n:2,label:'No, and tell Codex what to do differently',description:'',checked:null,chosen:false,input:false,chat:false}]};
async function demoRequest(op,r){
 await new Promise(resolve=>setTimeout(resolve,160));
 if(op==='sessions')return{sessions:[{name:'demo',running:true}]};
 if(op==='agents'||op==='status')return{agents:demoAgents};
 if(op==='panes')return{panes:[{pane_id:'w1:p3',terminal_id:'demo-term',identity:'demo-pane',workspace_label:'演示项目',tab_id:'w1:t1',cwd:'~/projects/pocket',terminal_title:'开发终端'}]};
 if(op==='paneRead')return{text:'$ pwd\n~/projects/pocket\n$ npm test\nPASS: 离线普通窗格演示\n$ '};
 if(op==='account')return{ssh_user:'demo',hostname:'workstation'};
 if(op==='catalog'){let rows=demoRecords.slice().sort((a,b)=>b.modified-a.modified);if(r.thread)rows=rows.filter(x=>x.thread===r.thread);if(r.query)rows=rows.filter(x=>JSON.stringify(x).includes(r.query));return{records:rows,total:rows.length,next:null};}
 if(op==='history'){const rec=demoRecords.find(x=>x.id===r.record_id);let messages;
  messages=demoHistory(rec.id,r.before!==undefined);
  return{record:rec,messages,children:demoRecords.filter(x=>x.parent===rec.thread),before:r.before!==undefined?0:10,has_more:r.before===undefined&&rec.id==='demo-root'};}
 if(op==='read'){const E='\x1b[',ask=r.target==='demo:3';
  // `ansi` only when asked, like the bridge: the same screen with Codex-style colors.
  const ansi=!r.ansi?undefined:ask?'  '+E+'1mWould you like to run the following command?'+E+'0m\n\n  '+E+'38;2;137;180;250m$ '+E+'38;2;205;214;244mrm -rf dist .cache'+E+'0m\n\n'+E+'1;38;2;137;180;250m› 1. Yes, proceed'+E+'0m\n  2. No, and tell Codex what to do differently\n\n  '+E+'2mPress '+E+'0;1menter'+E+'0;2m to confirm or '+E+'0;1mesc'+E+'0;2m to cancel'+E+'0m'
   :E+'1;38;5;2m•'+E+'0m '+E+'1mRan'+E+'0m '+E+'38;2;137;180;250mpython3'+E+'38;2;205;214;244m -m unittest discover -s tests'+E+'38;2;148;226;213m -v'+E+'0m\n'+E+'2m  └ '+E+'0mRan 24 tests\n    '+E+'38;2;166;227;161mOK'+E+'0m\n\n'+E+'2m离线演示，不是真实终端。'+E+'0m';
  return{menu:ask?demoMenu:undefined,ansi,text:ask?'  Would you like to run the following command?\n\n  $ rm -rf dist .cache\n\n› 1. Yes, proceed\n  2. No, and tell Codex what to do differently\n\n  Press enter to confirm or esc to cancel':'$ python3 -m unittest discover -s tests -v\nRan 24 tests\nOK\n\n离线演示，不是真实终端。'};}
 if(op==='prompt'||op==='key'||op==='answer')return{sent:false};
 if(op==='glance'){const at=new Date(Date.now()-4*60000).toISOString(),p={
  'demo-codex':{reply:{text:'移动端聊天改好了：历史、子 Agent 和命令都能看到，测试全过。',current:true,at},turn:{tools:12,files:5,failed:0},at},
  'demo-claude':{activity:{kind:'tool',verb:'run',text:'python3 -m unittest discover -s tests',open:true,at},at},
  'demo-review':{activity:{kind:'tool',verb:'run',text:'rm -rf dist .cache',open:true,at},at}};
  // Sub-agents (kids.js): the Codex session's layout check, finished.
  // Background work (bg.js): Claude's test run and CI monitor still going, two finished.
  p['demo-claude'].bg=bgDemoReport();
  p['demo-codex'].kids={total:1,running:0,items:demoRecords.filter(x=>x.parent==='demo-root').map(x=>({...x,running:false,state:'done'})),stamp:'demo'};
  const previews={};for(const it of r.items||[]){const id=String(it.key).split('/').pop();if(p[id])previews[it.key]=p[id];}return{previews};}
 throw Error('演示不支持此操作');}
