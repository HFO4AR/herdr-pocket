'use strict';
// Offline demo fixtures: never connect to a host or send input.
const demoAgents=[{pane_id:'demo:1',identity:'demo-codex',agent:'codex',agent_status:'idle',terminal_title:'把移动端做成真正的聊天工具',cwd:'/home/demo/projects/pocket',agent_session:{value:'demo-root'}},{pane_id:'demo:2',identity:'demo-claude',agent:'claude',agent_status:'working',terminal_title:'检查接口与回归测试',cwd:'/home/demo/projects/pocket',agent_session:{value:'demo-claude'}},{pane_id:'demo:3',identity:'demo-review',agent:'codex',agent_status:'blocked',terminal_title:'清理构建缓存',cwd:'/home/demo/projects/site',agent_session:{value:'demo-review'}}];
const demoRecords=[{id:'demo-root',thread:'demo-root',provider:'codex',parent:null,title:'把移动端做成真正的聊天工具',cwd:'/home/demo/projects/pocket',modified:Date.now()/1000-300},{id:'demo-child',thread:'demo-child',provider:'codex',parent:'demo-root',title:'布局检查 · 子 Agent',cwd:'/home/demo/projects/pocket',modified:Date.now()/1000-240},{id:'demo-claude',thread:'demo-claude',provider:'claude',parent:null,title:'检查接口与回归测试',cwd:'/home/demo/projects/pocket',modified:Date.now()/1000-90000},{id:'demo-review',thread:'demo-review',provider:'codex',parent:null,title:'清理构建缓存',cwd:'/home/demo/projects/site',modified:Date.now()/1000-60}];
function demoMessage(id,kind,text,title='',call_id=''){return{id:id+':0',kind,text,title,call_id,timestamp:new Date(Date.now()-600000+id*20000).toISOString()};}
async function demoRequest(op,r){
 await new Promise(resolve=>setTimeout(resolve,160));
 if(op==='sessions')return{sessions:[{name:'demo',running:true}]};
 if(op==='agents'||op==='status')return{agents:demoAgents};
 if(op==='panes')return{panes:[{pane_id:'w1:p3',terminal_id:'demo-term',identity:'demo-pane',workspace_label:'演示项目',tab_id:'w1:t1',cwd:'~/projects/pocket',terminal_title:'开发终端'}]};
 if(op==='paneRead')return{text:'$ pwd\n~/projects/pocket\n$ npm test\nPASS: 离线普通分屏演示\n$ '};
 if(op==='account')return{ssh_user:'demo',hostname:'workstation'};
 if(op==='catalog'){let rows=demoRecords;if(r.thread)rows=rows.filter(x=>x.thread===r.thread);if(r.query)rows=rows.filter(x=>JSON.stringify(x).includes(r.query));return{records:rows,total:rows.length,next:null};}
 if(op==='history'){const rec=demoRecords.find(x=>x.id===r.record_id);let messages;
  if(rec.id==='demo-child')messages=[demoMessage(1,'user','请检查小屏和横屏的输入栏。'),demoMessage(2,'assistant','子 Agent：布局检查完成。\n\n输入栏保持可见，长命令可展开阅读。')];
  else if(rec.id==='demo-claude')messages=[demoMessage(1,'assistant','正在检查接口与回归测试。\n\n这是 Claude 的独立会话。'),demoMessage(2,'tool','{"file_path":"bridge/pocket_bridge.py"}','Read','c1'),demoMessage(3,'result','#!/usr/bin/env python3\n"""Herdr Pocket protocol v1."""','执行结果','c1'),demoMessage(4,'tool','python3 -m unittest discover -s tests','Bash','c2')];
  else if(rec.id==='demo-review')messages=[demoMessage(1,'user','把 dist 和缓存目录清掉。'),demoMessage(2,'tool','rm -rf dist .cache','exec_command','c9')];
  else messages=[demoMessage(10,'user','历史记录、子 Agent 和执行的命令都要能看到。'),demoMessage(11,'assistant','我把它们整理到同一个对话里：\n\n- **对话**保留完整上下文\n- **命令**展示具体执行内容\n- 子 Agent 可以独立切换\n\n| 视图 | 内容 |\n|---|---|\n| 对话 | 消息与折叠的操作 |\n| 命令 | 全部命令和输出 |'),demoMessage(12,'tool','python3 -m unittest discover -s tests -v','exec_command','demo-call'),demoMessage(13,'result','Ran 24 tests in 0.08s\nOK\nProcess exited with code 0','执行结果','demo-call'),demoMessage(14,'tool','{"cmd":"rg -n \\"history_ref\\" app"}','exec_command','demo-call-2'),demoMessage(15,'result','app.js:53: const ref=a.history_ref;','执行结果','demo-call-2'),demoMessage(16,'assistant','测试都通过了。展开上面的操作可以看到每条命令和输出，或者点右上角切换到「布局检查」子 Agent。\n\n```bash\nnpm test\n```')];
  if(r.before!==undefined)messages=[demoMessage(1,'user','先把连接设备和密码保存做好。'),demoMessage(2,'assistant','更早的消息：连接资料和密码会用本机密钥加密保存。')];
  return{record:rec,messages,children:demoRecords.filter(x=>x.parent===rec.thread),before:r.before!==undefined?0:10,has_more:r.before===undefined&&rec.id==='demo-root'};}
 if(op==='read')return{text:r.target==='demo:3'?'  Would you like to run the following command?\n\n  $ rm -rf dist .cache\n\n› 1. Yes, proceed\n  2. No, and tell Codex what to do differently\n\n  Press enter to confirm or esc to cancel':'$ python3 -m unittest discover -s tests -v\nRan 24 tests\nOK\n\n离线演示，不是真实终端。'};
 if(op==='prompt'||op==='key')return{sent:false};
 throw Error('演示不支持此操作');}
