'use strict';
// Conversation timeline: the chat is grouped into turns so the answer stands out.
//   user prompt → collapsed 「工作过程」 (progress notes, tool calls, notices) → the turn's final reply.
// Codex marks replies with phase "final_answer"; for Claude the last assistant text with no tool
// call after it is the reply. A turn that is still running has no reply yet: its latest progress
// note is shown live instead. Pages may start mid-turn; turns are rebuilt from S.messages on
// every render, so loading earlier pages merges naturally.
const TOOL_KINDS=[[/^(bash|shell|exec_command|exec|local_shell|run|write_stdin|BashOutput)$/i,'运行','terminal'],[/^(read|view|cat|notebookread)$/i,'读取','file'],[/^(edit|multiedit|write|apply_patch|notebookedit|str_replace)/i,'编辑','pen'],[/^(grep|glob|search|find|ls|rg)$/i,'搜索','search'],[/^(webfetch|websearch|web_search|fetch)$/i,'网络','globe'],[/^(sleep|wait|wait_for)$/i,'等待','pause'],[/^(task|agent|spawn_agent|send_message|followup_task|wait_agent|close_agent|resume_agent|send_input)$/i,'子 Agent','branch']];
function toolKind(name=''){for(const [re,label,i] of TOOL_KINDS)if(re.test(name))return {label,icon:i};return {label:name||'工具',icon:'tool'};}
// Codex "code mode" wraps calls in JS: text(await tools.exec_command({cmd:"…"})).
function codeModeSummary(t){const calls=[...t.matchAll(/tools\.(\w+)\(\{/g)].map(m=>m[1]);if(!calls.length)return '';
 const cmds=[...t.matchAll(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(m=>{try{return JSON.parse('"'+m[1]+'"');}catch(_){return m[1];}});
 const s=cmds.length?cmds[0].split('\n').find(x=>x.trim())||cmds[0]:calls.every(c=>c==='write_stdin')?'查看运行中命令的输出':calls[0];
 return s.trim()+(calls.length>1?'  ·  共 '+calls.length+' 步':'');}
function toolSummary(m){let t=m.text||'';const code=/^\s*(text\()?await tools\./.test(t)?codeModeSummary(t):'';if(code)return code;try{const v=JSON.parse(t);if(v&&typeof v==='object')t=v.command||v.cmd||v.file_path||v.path||v.pattern||v.query||v.url||v.description||v.message||v.prompt||Object.values(v).find(x=>typeof x==='string')||t;}catch(_){}
 if(Array.isArray(t))t=t.join(' ');t=String(t).replace(/^\s*(bash\s+-lc\s+|\/bin\/\w+\s+-c\s+)/,'').trim();return t.split('\n').find(x=>x.trim())||t;}
// Show the command itself when a tool input is a JSON envelope around it.
function toolInput(m){try{const v=JSON.parse(m.text);if(v&&typeof v==='object'&&!Array.isArray(v)){const c=v.command??v.cmd;if(typeof c==='string')return c;if(Array.isArray(c))return c.join(' ');}}catch(_){}return m.text;}
function resultFailed(r){return !!r&&(r.title==='执行失败'||/(^|\n)(Exit code|Process exited with code):?\s*[1-9]/.test(r.text)||/^Error:/.test(r.text));}
// Flat items, used by the 「命令」 view (commandsOnly) and kept for other callers.
function buildItems(messages,commandsOnly){
 const results=new Map();messages.forEach(m=>{if(m.kind==='result'&&m.call_id)results.set(m.call_id,m);});
 const toolIds=new Set(messages.filter(m=>m.kind==='tool').map(m=>m.call_id));const items=[];let group=null;
 for(const m of messages){
  if(m.kind==='tool'||m.kind==='result'){if(m.kind==='result'&&toolIds.has(m.call_id))continue;const entry={tool:m.kind==='tool'?m:null,result:m.kind==='tool'?results.get(m.call_id):m,id:m.id,timestamp:m.timestamp};
   if(commandsOnly){items.push({type:'tool',entry});continue;}
   if(!group){group={type:'group',entries:[],id:m.id};items.push(group);}group.entries.push(entry);continue;}
  if(commandsOnly)continue;group=null;items.push({type:'message',m});}
 return items;}

// ─── Classification ─────────────────────────────────────────────────────────
const tlTag=(text,tag)=>{const m=String(text).match(new RegExp('<'+tag+'>([\\s\\S]*?)</'+tag+'>'));return m?m[1].trim():'';};
const tlStrip=text=>String(text).replace(/<\/?[a-zA-Z][\w-]*(\s[^>]*)?>/g,' ').replace(/[ \t]+/g,' ').trim();
const tlFirstLine=text=>{const line=String(text).split('\n').map(x=>x.replace(/^[\s#>*\-+`|]+|[*`]+$/g,'').trim()).find(Boolean)||'';return line.length>140?line.slice(0,140)+'…':line;};
// Messages that arrive as "user" but were written by the harness, not typed by the person.
function userNotice(text){
 const t=String(text||'').trim();
 if(t.startsWith('<task-notification>')){const st=tlTag(t,'status');return {label:'后台任务',text:tlTag(t,'summary')||tlFirstLine(tlStrip(t)),tone:/fail|error|kill/i.test(st)?'bad':'',icon:'branch'};}
 if(/^<subagent_notification>/.test(t)){const body=tlTag(t,'subagent_notification');let s=body;try{const v=JSON.parse(body);s=v.summary||v.message||v.status||v.agent_path||body;if(typeof s!=='string')s=JSON.stringify(s);}catch(_){}return {label:'子 Agent 通知',text:tlFirstLine(tlStrip(s)),icon:'branch'};}
 if(t.startsWith('This session is being continued'))return {label:'上下文已压缩',text:'从之前对话的摘要继续',icon:'history'};
 if(t.startsWith('<send_user_message_question_reply>')){let s='';try{const v=JSON.parse(tlTag(t,'send_user_message_question_reply'));s=(Array.isArray(v)?v:[v]).map(x=>x.answer??x.response??'').filter(Boolean).join(' · ');}catch(_){}return {label:'你的回答',text:s||tlFirstLine(tlStrip(t)),tone:'answer',icon:'check'};}
 if(/^\[Request interrupted by user/.test(t))return {label:'已中断',text:/tool use/.test(t)?'你中断了正在执行的操作':'你中断了这一轮',tone:'bad',icon:'stop'};
 if(/^<command-(name|message)>/.test(t)){const c=tlTag(t,'command-name')||'/'+tlTag(t,'command-message');return {label:'命令',text:(c+' '+tlTag(t,'command-args')).trim(),icon:'terminal'};}
 if(/^<(local-command-|bash-)/.test(t))return {label:'本地命令',text:tlFirstLine(tlStrip(t))||'（无输出）',icon:'terminal'};
 if(/^<([a-z][\w-]*)>[\s\S]*<\/\1>\s*$/.test(t)&&!/^<image\b/.test(t))return {label:'系统消息',text:tlFirstLine(tlStrip(t)),icon:'tool'};
 return null;}
// Image attachments arrive as tags around a local path; show a placeholder instead.
function promptText(text){return String(text).replace(/<image\b[^>]*>(\s*<\/image>)?/g,'[图片] ').replace(/<\/image>/g,'').trim();}

// ─── Turns ──────────────────────────────────────────────────────────────────
function buildTurns(messages,live){
 const results=new Map();messages.forEach(m=>{if(m.kind==='result'&&m.call_id)results.set(m.call_id,m);});
 const toolIds=new Set(messages.filter(m=>m.kind==='tool').map(m=>m.call_id));const turns=[];let t=null;
 const start=(first,prompt,notice)=>{t={id:first.id,prompt,notice,entries:[]};turns.push(t);};
 // A harness notice starts its own turn only if the previous turn already finished with a reply.
 const settled=()=>{const last=[...t.entries].reverse().find(e=>e.type!=='notice'&&e.type!=='agent');return last?.type==='text'&&last.m.phase!=='commentary';};
 for(const m of messages){
  if(m.kind==='result'&&toolIds.has(m.call_id))continue;
  if(m.kind==='user'){const n=userNotice(m.text);if(!n){start(m,m,null);continue;}
   if(!t||settled()){start(m,null,{m,n});continue;}t.entries.push({type:'notice',m,n,id:m.id});continue;}
  if(!t){start(m,null,null);t.partial=true;}
  if(m.kind==='tool'||m.kind==='result')t.entries.push({type:'tool',id:m.id,entry:{tool:m.kind==='tool'?m:null,result:m.kind==='tool'?results.get(m.call_id):m,id:m.id,timestamp:m.timestamp}});
  else if(m.kind==='agent')t.entries.push({type:'agent',m,id:m.id});
  else t.entries.push({type:'text',m,id:m.id});}
 turns.forEach((turn,i)=>{
  const texts=turn.entries.filter(e=>e.type==='text');const phased=texts.some(e=>e.m.phase);
  turn.last=i===turns.length-1;turn.live=!!live&&turn.last;let final=null;
  if(phased)final=texts.filter(e=>e.m.phase==='final_answer').at(-1)||null;
  else if(!turn.live){const k=turn.entries.findLastIndex(e=>e.type==='text');if(k>=0&&!turn.entries.slice(k+1).some(e=>e.type==='tool'))final=turn.entries[k];}
  turn.final=final;turn.work=turn.entries.filter(e=>e!==final);
  const tools=turn.work.filter(e=>e.type==='tool');
  turn.stats={notes:turn.work.filter(e=>e.type==='text').length,ops:tools.length,agents:turn.work.filter(e=>e.type==='agent').length,
   failed:tools.filter(e=>resultFailed(e.entry.result)).length,running:tools.some(e=>e.entry.tool&&!e.entry.result)};
  const stamps=[turn.prompt||turn.notice?.m,...turn.entries.map(e=>e.m||e.entry)].map(x=>toDate(x?.timestamp)).filter(Boolean);
  turn.start=stamps[0]||null;turn.end=stamps.at(-1)||null;
  turn.interrupted=turn.entries.some(e=>e.type==='notice'&&e.n.label==='已中断');});
 return turns;}
function tlDuration(a,b){if(!a||!b)return '';const s=Math.max(0,Math.round((b-a)/1000));if(s<60)return s+' 秒';const m=Math.round(s/60);if(m<60)return m+' 分钟';return Math.floor(m/60)+' 小时'+(m%60?' '+m%60+' 分':'');}
function workSummary(turn){const s=turn.stats,parts=[];if(s.notes)parts.push(s.notes+' 条进展');if(s.ops)parts.push(s.ops+' 个操作');if(!s.notes&&!s.ops&&s.agents)parts.push(s.agents+' 条子 Agent 消息');
 const d=tlDuration(turn.start,turn.live?new Date():turn.end);if(d&&turn.prompt)parts.push(d);return parts.join(' · ');}
// One-line preview of the newest progress for the collapsed block.
function workPreview(turn){const last=turn.work.filter(e=>e.type!=='notice').at(-1);if(!last)return '';
 if(last.type==='tool'){const t=last.entry.tool,r=last.entry.result;return toolKind(t?.title||r?.title).label+' '+(t?toolSummary(t):(r?.title||''));}
 if(last.type==='agent')return agentName(last.m.title)+'：'+tlFirstLine(last.m.text);return tlFirstLine(last.m.text);}
function agentName(path){return String(path||'子 Agent').split('/').filter(Boolean).pop()||'子 Agent';}

// Link a spawn call or an agent message to the child transcript it refers to:
// Claude spawn results carry the child's agentId; Codex messages carry its agent path.
function childFor(texts){
 const kids=S.children||[];if(!kids.length)return null;const hay=texts.filter(Boolean).map(String);
 for(const c of kids){const role=c.role&&!/^(subagent|general-purpose)$/i.test(c.role)?c.role:'';
  for(const t of hay){if(c.thread&&String(c.thread).length>=8&&t.includes(c.thread))return c;
   if(role&&(t==='/root/'+role||t.endsWith('/'+role)||t===role))return c;}}
 for(const c of kids){if(c.title&&hay.some(t=>{try{return JSON.parse(t).description===c.title;}catch(_){return false;}}))return c;}
 return null;}
// Sub-agents spawned in a turn stay reachable without opening the work block.
function turnChildren(turn){const seen=new Map();for(const e of turn.work){let c=null;
 if(e.type==='tool'&&toolKind(e.entry.tool?.title||e.entry.result?.title).label==='子 Agent')c=childFor([e.entry.tool?.text,e.entry.result?.text]);
 else if(e.type==='agent')c=childFor([e.m.title]);else if(e.type==='notice')c=childFor([e.m.text]);if(c&&!seen.has(c.id))seen.set(c.id,c);}return [...seen.values()];}
function childStrip(kids){const box=el('div','sub-strip');box.append(el('span','sub-strip-label',kids.length+' 个子 Agent'));
 for(const c of kids){const b=btn('','sub-chip',()=>openRecord(c,true),'branch');b.append(el('span','truncate',c.title||c.role||String(c.thread).slice(0,8)),icon('chevron'));b.setAttribute('aria-label','查看子 Agent '+(c.title||c.role||''));box.append(b);}
 return box;}
function childLink(c){const b=btn('查看','sub-open',e=>{e.preventDefault();e.stopPropagation();openRecord(c,true);},'chevron');b.setAttribute('aria-label','查看子 Agent '+(c.title||c.role||''));return b;}

// ─── Rows ───────────────────────────────────────────────────────────────────
function toolRow(entry,open){
 const t=entry.tool,r=entry.result;const kind=toolKind(t?.title||r?.title);const failed=resultFailed(r);
 const d=el('details','tool-row'+(failed?' failed':''));d.dataset.key='row:'+entry.id;d.dataset.id=entry.id;d.open=!!open;const s=el('summary');
 s.append(el('span','tool-icon'),el('span','tool-verb',kind.label),el('span','tool-text',t?toolSummary(t):(r?.title||'输出')),el('span','tool-state '+(failed?'bad':r?'good':'wait'),failed?'失败':r?'':'…'));s.firstChild.append(icon(kind.icon));
 const child=kind.label==='子 Agent'?childFor([t?.text,r?.text]):null;if(child)s.append(childLink(child));d.append(s);
 // Bodies are built on first open: a long turn can hold hundreds of large outputs.
 const fill=()=>{if(d.childElementCount>1)return;const body=el('div','tool-body');
  if(t){const cap=el('div','tool-caption');cap.append(el('span','',t.title||'调用内容'),btn('复制','code-copy',()=>copyText(toolInput(t)),'copy'));body.append(cap,el('pre','',toolInput(t)));if(t.truncated)body.append(el('small','','内容超过 16 KB，已截断。'));}
  if(r){const cap=el('div','tool-caption');cap.append(el('span','',r.title||'执行结果'),btn('复制','code-copy',()=>copyText(r.text),'copy'));body.append(cap,el('pre','output',r.text));if(r.truncated)body.append(el('small','','结果过长，已截断。'));}
  else body.append(el('p','fine','还没有输出。'));d.append(body);};
 if(d.open)fill();d.addEventListener('toggle',()=>{if(d.open)fill();});return d;}
function toolGroup(g,open,openRows){
 const d=el('details','tool-group');d.dataset.key='group:'+g.id;d.dataset.id=g.id;d.open=open.has('group:'+g.id);const s=el('summary');
 const failed=g.entries.filter(e=>resultFailed(e.result)).length;const running=g.entries.some(e=>e.tool&&!e.result);
 const last=g.entries.at(-1);const lk=toolKind(last.tool?.title||last.result?.title);
 const ic=el('span','tool-icon');ic.append(icon(lk.icon));s.append(ic);
 const txt=el('span','tool-text');txt.append(el('strong','',g.entries.length===1?lk.label:g.entries.length+' 个操作'),document.createTextNode(' '+(last.tool?toolSummary(last.tool):'')));s.append(txt);
 if(failed)s.append(el('span','tool-state bad',failed+' 失败'));else if(running&&tlWorking())s.append(el('span','spinner mini'));
 s.append(el('span','chev'));s.lastChild.append(icon('down'));d.append(s);
 const list=el('div','tool-list');g.entries.forEach(e=>list.append(toolRow(e,open.has('row:'+e.id)||openRows?.has?.(e.id))));d.append(list);return d;}
function tlWorking(){const st=S.chat?.agent?.agent_status;return !S.chat?.stale&&(st==='working'||st==='blocked');}
function messageRow(m,label){
 const row=el('article','message '+m.kind);const meta=el('div','message-label');meta.append(el('span','',label),el('span','',clock(m.timestamp)));
 const bubble=el('div','bubble');bubble.append(m.kind==='user'?userText(m.text):markdown(m.text));
 bubble.oncontextmenu=e=>{e.preventDefault();messageMenu(m);};
 row.append(meta,bubble);if(m.truncated)row.append(el('small','fine','消息过长，已截断。'));return row;}
function userText(text){const box=el('div','md');text.split('\n').forEach((line,i)=>{if(i)box.append(el('br'));box.append(document.createTextNode(line));});return box;}
const expandedPrompts=new Set();
// Long prompts (pasted logs, task specs) are clamped; the person can expand them.
function promptRow(m){
 const text=promptText(m.text);const row=messageRow({...m,text},'你');row.classList.add('prompt');const bubble=row.querySelector('.bubble');
 bubble.oncontextmenu=e=>{e.preventDefault();messageMenu(m);};
 const lines=text.split('\n').length;if(text.length>420||lines>8){const label='展开全文 · '+(lines>8?lines+' 行':text.length+' 字');
  const sync=()=>{const o=expandedPrompts.has(m.id);bubble.classList.toggle('clamped',!o);more.textContent=o?'收起':label;more.setAttribute('aria-expanded',String(o));};
  const more=btn('','prompt-more',()=>{if(expandedPrompts.has(m.id))expandedPrompts.delete(m.id);else expandedPrompts.add(m.id);sync();});row.append(more);sync();}
 return row;}
function noticeRow(m,n,open){
 const d=el('details','notice-row'+(n.tone?' '+n.tone:''));d.dataset.key='notice:'+m.id;d.open=open.has('notice:'+m.id);const s=el('summary');
 const ic=el('span','notice-icon');ic.append(icon(n.icon||'tool'));s.append(ic,el('span','notice-label',n.label),el('span','notice-text',n.text),el('span','notice-time',clock(m.timestamp)));
 const child=childFor([m.text]);if(child)s.append(childLink(child));d.append(s);
 const fill=()=>{if(d.childElementCount<2)d.append(el('pre','notice-body',m.text));};if(d.open)fill();d.addEventListener('toggle',()=>{if(d.open)fill();});return d;}
function agentMessageRow(m,open){
 const d=el('details','notice-row agent'+(m.phase==='final_answer'?' done':''));d.dataset.key='agent:'+m.id;d.open=open.has('agent:'+m.id);const s=el('summary');
 const ic=el('span','notice-icon');ic.append(icon('branch'));s.append(ic,el('span','notice-label',agentName(m.title)+(m.phase==='final_answer'?' 完成':'')),el('span','notice-text',tlFirstLine(m.text)),el('span','notice-time',clock(m.timestamp)));
 const child=childFor([m.title]);if(child)s.append(childLink(child));d.append(s);
 const fill=()=>{if(d.childElementCount<2){const b=el('div','notice-md');b.append(markdown(m.text));d.append(b);}};if(d.open)fill();d.addEventListener('toggle',()=>{if(d.open)fill();});return d;}
function noteRow(m){const n=el('div','work-note');n.append(markdown(m.text));const t=el('span','work-time',clock(m.timestamp));n.prepend(t);n.oncontextmenu=e=>{e.preventDefault();messageMenu(m);};return n;}
// The collapsed 「工作过程」 block of a turn.
function workBlock(turn,open){
 const s=turn.stats;const d=el('details','work'+(turn.live?' live':'')+(s.failed?' has-failed':''));d.dataset.key='work:'+turn.id;d.open=open.has('work:'+turn.id);
 const sum=el('summary');const lead=el('span','work-lead');
 if(turn.live&&tlWorking())lead.append(el('span','spinner mini'));else lead.append(icon(s.failed?'alert':turn.interrupted?'stop':turn.final?'check':'tool'));
 const head=el('span','work-head');const title=el('span','work-title');title.append(el('strong','',turn.live&&tlWorking()?(S.chat.agent.agent_status==='blocked'?'等你确认':'正在工作'):turn.interrupted?'已中断':'工作过程'),el('span','work-stats',workSummary(turn)));
 if(s.failed)title.append(el('span','work-bad',s.failed+' 个失败'));
 head.append(title);const preview=workPreview(turn);if(preview)head.append(el('span','work-preview',preview));
 const chev=el('span','chev');chev.append(icon('down'));sum.append(lead,head,chev);d.append(sum);
 const fill=()=>{if(d.childElementCount>1)return;const list=el('div','work-list');let run=[];
  const flush=()=>{if(!run.length)return;if(run.length<=3)run.forEach(e=>list.append(toolRow(e,open.has('row:'+e.id))));else list.append(toolGroup({id:run[0].id,entries:run},open));run=[];};
  for(const e of turn.work){if(e.type==='tool'){run.push(e.entry);continue;}flush();
   if(e.type==='text')list.append(noteRow(e.m));else if(e.type==='agent')list.append(agentMessageRow(e.m,open));else list.append(noticeRow(e.m,e.n,open));}
  flush();d.append(list);};
 if(d.open)fill();d.addEventListener('toggle',()=>{if(d.open)fill();});return d;}
function replyRow(m,who,turn){
 const row=el('article','message assistant reply');const meta=el('div','message-label');meta.append(el('span','who',who),el('span','',clock(m.timestamp)));
 const bubble=el('div','bubble');bubble.append(markdown(m.text));bubble.oncontextmenu=e=>{e.preventDefault();messageMenu(m);};
 row.append(meta,bubble);if(m.truncated)row.append(el('small','fine','消息过长，已截断。'));return row;}
// While a turn runs there is no reply yet; show its newest progress note in place.
function progressRow(m,who){const row=el('article','message assistant progress');const meta=el('div','message-label');meta.append(el('span','',who+' · 最新进展'),el('span','',clock(m.timestamp)));const b=el('div','bubble');b.append(markdown(m.text));row.append(meta,b);return row;}
function turnView(turn,who,open){
 const sec=el('section','turn'+(turn.live?' live':''));sec.dataset.id=turn.id;
 if(turn.partial)sec.append(el('div','turn-cont','接上文 · 这一轮的开头在更早的记录里'));
 if(turn.prompt)sec.append(promptRow(turn.prompt));else if(turn.notice)sec.append(noticeRow(turn.notice.m,turn.notice.n,open));
 if(turn.work.length)sec.append(workBlock(turn,open));
 const kids=turnChildren(turn);if(kids.length)sec.append(childStrip(kids));
 if(turn.final)sec.append(replyRow(turn.final.m,who,turn));
 else if(turn.live||turn.last){const last=turn.work.filter(e=>e.type==='text').at(-1);if(last)sec.append(progressRow(last.m,who));}
 return sec;}
function messageMenu(m){const box=sheet('消息');menuItem(box,'复制全文',()=>copyText(m.text),'copy');if(S.chat?.agent&&m.kind==='user')menuItem(box,'放入输入框',()=>{S.drafts.set(draftKey(),m.text);renderComposer();},'edit');}

// ─── Render ─────────────────────────────────────────────────────────────────
function renderTimeline(){
 const body=document.getElementById('chat-scroll');if(!body)return;
 const open=new Set([...body.querySelectorAll('details[data-key][open]')].map(x=>x.dataset.key));
 body.replaceChildren();const list=el('div','timeline');body.append(list);
 followMarker(list);
 if(S.chatMode==='terminal'){const pre=el('pre','agent-terminal',S.terminalText||(S.chat.agent?'正在读取终端…':'这条历史没有在线终端。'));pre.id='terminal-output';list.append(pre);if(S.chat.agent)list.append(btn('刷新终端','secondary',()=>fetchTerminal()));return;}
 if(!S.chat.record){const box=el('div','unlinked');box.append(el('h2','','还没关联到对话记录'),el('p','muted',S.chat.historyIssue||'正在定位这个窗格对应的历史记录…'));
  if(S.chat.historyIssue)box.append(btn('选择历史记录','primary',pickHistory));list.append(box);
  const candidates=S.chat.agent?.history_ref?.candidates||[];if(candidates.length){list.append(el('div','section-label','候选历史 · 点击后确认'));const g=el('div','card list-card');candidates.forEach(rec=>{const b=btn('','card-button',()=>chooseHistory(rec,S.chat.agent));const t=el('div','grow');t.append(el('div','card-title',rec.title),el('div','card-meta',relative(rec.modified)+' · '+String(rec.thread).slice(0,8)));b.append(t,icon('chevron'));g.append(b);});list.append(g);}
  if(S.chat.agent&&S.terminalText){list.append(el('div','section-label','终端最新画面'));list.append(el('pre','agent-terminal compact',tail(S.terminalText,14)));}
  return;}
 const more=btn(S.more?'加载更早消息':'已到记录起点','link-btn',()=>fetchHistory(true));more.disabled=!S.more;list.append(more);
 if(S.chat.historyError){const n=el('div','note error');n.append(el('span','grow',S.chat.historyError),btn('重试','secondary small',()=>{S.paused=false;fetchHistory(false,true);}));list.append(n);}
 if(S.historyNote)list.append(el('p','note',S.historyNote));
 const commandsOnly=S.chatMode==='commands';const who=providerName(S.chat.provider);let day='';let count=0;
 const dayMark=ts=>{const d=dayLabel(ts);if(d&&d!==day){day=d;list.append(el('div','date-separator',d));}};
 if(commandsOnly){const items=buildItems(S.messages,true);count=items.length;for(const it of items){dayMark(it.entry.timestamp);list.append(toolRow(it.entry,true));}}
 else{// A just-sent prompt means the newest transcript turn is already finished.
  const live=tlWorking()&&!S.outbox.some(o=>o.key===draftKey()&&o.state!=='failed');const turns=buildTurns(S.messages,live);count=turns.length;for(const turn of turns){dayMark(turn.start);list.append(turnView(turn,who,open));}}
 for(const o of S.outbox.filter(o=>o.key===draftKey())){const row=el('article','message user pending'+(o.state==='failed'?' failed':''));const meta=el('div','message-label');meta.append(el('span','',o.state==='failed'?'发送未确认':o.state==='sending'?'发送中…':'已送达 Agent'));const b=el('div','bubble');b.append(userText(o.text));row.append(meta,b);list.append(row);}
 if(!count&&!S.chat.historyError)list.append(el('div','empty small',S.chat.historyLoading?'正在读取对话记录…':commandsOnly?'这段记录里还没有执行过命令。':S.more?'这一页没有可显示的消息，继续加载更早记录。':'这条记录暂无可显示的消息。'));}
function tail(text,n){return text.replace(/\s+$/,'').split('\n').slice(-n).join('\n');}
