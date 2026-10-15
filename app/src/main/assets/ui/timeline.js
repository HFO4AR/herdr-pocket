'use strict';
// Conversation timeline: turns, tool folding and message rendering for the chat view.
// Tool calls between two text messages collapse into one group, results attach by call id.
const TOOL_KINDS=[[/^(bash|shell|exec_command|exec|local_shell|run|write_stdin|BashOutput)$/i,'运行','terminal'],[/^(read|view|cat|notebookread)$/i,'读取','file'],[/^(edit|multiedit|write|apply_patch|notebookedit|str_replace)/i,'编辑','pen'],[/^(grep|glob|search|find|ls|rg)$/i,'搜索','search'],[/^(webfetch|websearch|web_search|fetch)$/i,'网络','globe'],[/^(task|agent|spawn_agent|send_message|followup_task)$/i,'子 Agent','branch']];
function toolKind(name=''){for(const [re,label,i] of TOOL_KINDS)if(re.test(name))return {label,icon:i};return {label:name||'工具',icon:'tool'};}
function toolSummary(m){let t=m.text||'';try{const v=JSON.parse(t);if(v&&typeof v==='object')t=v.command||v.cmd||v.file_path||v.path||v.pattern||v.query||v.url||v.description||v.prompt||Object.values(v).find(x=>typeof x==='string')||t;}catch(_){}
 if(Array.isArray(t))t=t.join(' ');t=String(t).replace(/^\s*(bash\s+-lc\s+|\/bin\/\w+\s+-c\s+)/,'').trim();return t.split('\n').find(x=>x.trim())||t;}
// Show the command itself when a tool input is a JSON envelope around it.
function toolInput(m){try{const v=JSON.parse(m.text);if(v&&typeof v==='object'&&!Array.isArray(v)){const c=v.command??v.cmd;if(typeof c==='string')return c;if(Array.isArray(c))return c.join(' ');}}catch(_){}return m.text;}
function resultFailed(r){return r&&(r.title==='执行失败'||/(^|\n)(Exit code|Process exited with code):?\s*[1-9]/.test(r.text)||/^Error:/.test(r.text));}
function buildItems(messages,commandsOnly){
 const results=new Map();messages.forEach(m=>{if(m.kind==='result'&&m.call_id)results.set(m.call_id,m);});
 const toolIds=new Set(messages.filter(m=>m.kind==='tool').map(m=>m.call_id));const items=[];let group=null;
 for(const m of messages){
  if(m.kind==='tool'||m.kind==='result'){if(m.kind==='result'&&toolIds.has(m.call_id))continue;const entry={tool:m.kind==='tool'?m:null,result:m.kind==='tool'?results.get(m.call_id):m,id:m.id,timestamp:m.timestamp};
   if(commandsOnly){items.push({type:'tool',entry});continue;}
   if(!group){group={type:'group',entries:[],id:m.id};items.push(group);}group.entries.push(entry);continue;}
  if(commandsOnly)continue;group=null;items.push({type:'message',m});}
 return items;}
function toolRow(entry,open){
 const t=entry.tool,r=entry.result;const kind=toolKind(t?.title||r?.title);const failed=resultFailed(r);
 const d=el('details','tool-row'+(failed?' failed':''));d.dataset.id=entry.id;d.open=!!open;const s=el('summary');
 s.append(el('span','tool-icon'),el('span','tool-verb',kind.label),el('span','tool-text',t?toolSummary(t):(r?.title||'输出')),el('span','tool-state '+(failed?'bad':r?'good':'wait'),failed?'失败':r?'':'…'));s.firstChild.append(icon(kind.icon));d.append(s);
 const body=el('div','tool-body');
 if(t){const cap=el('div','tool-caption');cap.append(el('span','',t.title||'调用内容'),btn('复制','code-copy',()=>copyText(toolInput(t)),'copy'));body.append(cap,el('pre','',toolInput(t)));if(t.truncated)body.append(el('small','','内容超过 16 KB，已截断。'));}
 if(r){const cap=el('div','tool-caption');cap.append(el('span','',r.title||'执行结果'),btn('复制','code-copy',()=>copyText(r.text),'copy'));body.append(cap,el('pre','output',r.text));if(r.truncated)body.append(el('small','','结果过长，已截断。'));}
 else body.append(el('p','fine','还没有输出。'));
 d.append(body);return d;}
function toolGroup(g,open,openRows){
 const d=el('details','tool-group');d.dataset.id=g.id;d.open=open.has(g.id);const s=el('summary');
 const failed=g.entries.filter(e=>resultFailed(e.result)).length;const running=g.entries.some(e=>e.tool&&!e.result);
 const last=g.entries.at(-1);const lk=toolKind(last.tool?.title||last.result?.title);
 const ic=el('span','tool-icon');ic.append(icon(lk.icon));s.append(ic);
 const txt=el('span','tool-text');txt.append(el('strong','',g.entries.length===1?lk.label:'执行了 '+g.entries.length+' 个操作'),document.createTextNode(' '+(last.tool?toolSummary(last.tool):'')));s.append(txt);
 if(failed)s.append(el('span','tool-state bad',failed+' 失败'));else if(running&&S.chat?.agent?.agent_status==='working')s.append(el('span','spinner mini'));
 s.append(el('span','chev'));s.lastChild.append(icon('down'));d.append(s);
 const list=el('div','tool-list');g.entries.forEach(e=>list.append(toolRow(e,openRows.has(e.id))));d.append(list);return d;}
function messageRow(m,label){
 const row=el('article','message '+m.kind);const meta=el('div','message-label');meta.append(el('span','',label),el('span','',clock(m.timestamp)));
 const bubble=el('div','bubble');bubble.append(m.kind==='user'?userText(m.text):markdown(m.text));
 bubble.oncontextmenu=e=>{e.preventDefault();messageMenu(m);};
 row.append(meta,bubble);if(m.truncated)row.append(el('small','fine','消息过长，已截断。'));return row;}
function userText(text){const box=el('div','md');text.split('\n').forEach((line,i)=>{if(i)box.append(el('br'));box.append(document.createTextNode(line));});return box;}
function messageMenu(m){const box=sheet('消息');menuItem(box,'复制全文',()=>copyText(m.text),'copy');if(S.chat?.agent&&m.kind==='user')menuItem(box,'放入输入框',()=>{S.drafts.set(draftKey(),m.text);renderComposer();},'edit');}
function renderTimeline(){
 const body=document.getElementById('chat-scroll');if(!body)return;
 const open=new Set([...body.querySelectorAll('details.tool-group[open]')].map(x=>x.dataset.id));const openRows=new Set([...body.querySelectorAll('details.tool-row[open]')].map(x=>x.dataset.id));
 body.replaceChildren();const list=el('div','timeline');body.append(list);
 if(S.chatMode==='terminal'){const pre=el('pre','agent-terminal',S.terminalText||(S.chat.agent?'正在读取终端…':'这条历史没有在线终端。'));pre.id='terminal-output';list.append(pre);if(S.chat.agent)list.append(btn('刷新终端','secondary',()=>fetchTerminal()));return;}
 if(!S.chat.record){const box=el('div','unlinked');box.append(el('h2','','还没关联到对话记录'),el('p','muted',S.chat.historyIssue||'正在定位这个窗格对应的历史记录…'));
  if(S.chat.historyIssue)box.append(btn('选择历史记录','primary',pickHistory));list.append(box);
  const candidates=S.chat.agent?.history_ref?.candidates||[];if(candidates.length){list.append(el('div','section-label','候选历史 · 点击后确认'));const g=el('div','card list-card');candidates.forEach(rec=>{const b=btn('','card-button',()=>chooseHistory(rec,S.chat.agent));const t=el('div','grow');t.append(el('div','card-title',rec.title),el('div','card-meta',relative(rec.modified)+' · '+String(rec.thread).slice(0,8)));b.append(t,icon('chevron'));g.append(b);});list.append(g);}
  if(S.chat.agent&&S.terminalText){list.append(el('div','section-label','终端最新画面'));list.append(el('pre','agent-terminal compact',tail(S.terminalText,14)));}
  return;}
 const more=btn(S.more?'加载更早消息':'已到记录起点','link-btn',()=>fetchHistory(true));more.disabled=!S.more;list.append(more);
 if(S.chat.historyError){const n=el('div','note error');n.append(el('span','grow',S.chat.historyError),btn('重试','secondary small',()=>{S.paused=false;fetchHistory(false,true);}));list.append(n);}
 if(S.historyNote)list.append(el('p','note',S.historyNote));
 const commandsOnly=S.chatMode==='commands';const items=buildItems(S.messages,commandsOnly);const who=providerName(S.chat.provider);let day='';
 for(const it of items){const ts=it.m?.timestamp||it.entry?.timestamp||it.entries?.[0]?.timestamp;const d=dayLabel(ts);if(d&&d!==day){day=d;list.append(el('div','date-separator',d));}
  if(it.type==='message')list.append(messageRow(it.m,it.m.kind==='user'?'你':who));
  else if(it.type==='group')list.append(toolGroup(it,open,openRows));
  else list.append(toolRow(it.entry,true));}
 for(const o of S.outbox.filter(o=>o.key===draftKey())){const row=el('article','message user pending'+(o.state==='failed'?' failed':''));const meta=el('div','message-label');meta.append(el('span','',o.state==='failed'?'发送未确认':o.state==='sending'?'发送中…':'已送达 Agent'));const b=el('div','bubble');b.append(userText(o.text));row.append(meta,b);list.append(row);}
 if(!items.length&&!S.chat.historyError)list.append(el('div','empty small',S.chat.historyLoading?'正在读取对话记录…':commandsOnly?'这段记录里还没有执行过命令。':S.more?'这一页没有可显示的消息，继续加载更早记录。':'这条记录暂无可显示的消息。'));}
function tail(text,n){return text.replace(/\s+$/,'').split('\n').slice(-n).join('\n');}
