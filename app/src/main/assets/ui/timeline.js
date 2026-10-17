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
const tlJsStr=s=>{try{return JSON.parse('"'+s+'"');}catch(_){return s;}};
function codeModeCalls(t){return [...String(t).matchAll(/tools\.(\w+)\(\{/g)].map(m=>m[1]);}
function codeModeCmds(t){return [...String(t).matchAll(/\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(m=>tlJsStr(m[1]));}
function codeModeSummary(t){const calls=codeModeCalls(t);if(!calls.length)return '';
 const cmds=codeModeCmds(t);
 const s=cmds.length?cmds[0].split('\n').find(x=>x.trim())||cmds[0]:calls.every(c=>c==='write_stdin')?'查看运行中命令的输出':calls[0];
 return s.trim()+(calls.length>1?'  ·  共 '+calls.length+' 步':'');}
const tlIsCode=t=>/^\s*(text\()?await tools\./.test(String(t||''));
function toolSummary(m){let t=m.text||'';const code=tlIsCode(t)?codeModeSummary(t):'';if(code)return code;try{const v=JSON.parse(t);if(v&&typeof v==='object')t=v.command||v.cmd||v.file_path||v.path||v.pattern||v.query||v.url||v.description||v.message||v.prompt||Object.values(v).find(x=>typeof x==='string')||t;}catch(_){}
 if(Array.isArray(t))t=t.join(' ');t=String(t).replace(/^\s*(bash\s+-lc\s+|\/bin\/\w+\s+-c\s+)/,'').trim();return tlCmdLine(t);}
// The line of a shell script that says what it does: skip cd, variable setup, echo banners and comments.
const TL_SETUP=/^\s*(cd\s+\S+|export\s+\S+|[A-Za-z_]\w*=\S*|set\s+-\w+|source\s+\S+|\.\s+\S+|echo\s+["']?[=#\-─━ ]*.*|#.*|)\s*;?\s*$/;
function tlCmdLine(t){
 const lines=String(t).split('\n').map(x=>x.trim()).filter(Boolean);const pick=lines.find(x=>!TL_SETUP.test(x))||lines[0]||String(t);
 let c=pick,prev;do{prev=c;c=c.replace(/^cd\s+\S+\s*(&&|;)\s*/,'').replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+(?=\S)/,'');}while(c!==prev);return c||pick;}
// Show the command itself when a tool input is a JSON envelope around it (or a code-mode script).
function toolInput(m){if(tlIsCode(m.text)){const c=codeModeCmds(m.text);if(c.length)return c.map(x=>'$ '+x).join('\n\n');}
 try{const v=JSON.parse(m.text);if(v&&typeof v==='object'&&!Array.isArray(v)){const c=v.command??v.cmd;if(typeof c==='string')return c;if(Array.isArray(c))return c.join(' ');}}catch(_){}return m.text;}
function resultFailed(r){return !!r&&(r.title==='执行失败'||/(^|\n)(Exit code|Process exited with code):?\s*[1-9]/.test(r.text)||/^Error:/.test(r.text)||!!resultInfo(r)?.tests?.fail);}

// ─── What a tool call did, for one-line summaries ───────────────────────────
// Parsed once per message (messages are immutable once read).
const TL_TOOL=new WeakMap(),TL_RESULT=new WeakMap();
function tlArgs(m){try{const v=JSON.parse(m.text);return v&&typeof v==='object'&&!Array.isArray(v)?v:null;}catch(_){return null;}}
function tlCwd(){return S.chat?.record?.cwd||S.chat?.agent?.cwd||'';}
// "app/src/x.js" relative to the project when possible; split into name + folder for display.
function tlRel(p){p=String(p||'').replace(/^file:\/\//,'');const c=tlCwd();return c&&p.startsWith(c+'/')?p.slice(c.length+1):p;}
function tlSplitPath(p){const r=tlRel(p),i=r.lastIndexOf('/');if(i<0)return [r,''];const dir=r.slice(0,i);const parts=dir.split('/');return [r.slice(i+1),parts.length>3?'…/'+parts.slice(-2).join('/'):dir];}
const tlLines=s=>{s=String(s??'').replace(/\n$/,'');return s?s.split('\n').length:0;};
// Old → new as a small diff: unchanged lines at both ends become (at most two) context lines.
function tlDiff(oldS,newS){
 const a=oldS?String(oldS).split('\n'):[],b=newS?String(newS).split('\n'):[];let p=0;while(p<a.length&&p<b.length&&a[p]===b[p])p++;
 let s=0;while(s<a.length-p&&s<b.length-p&&a[a.length-1-s]===b[b.length-1-s])s++;
 const out=[];a.slice(Math.max(0,p-2),p).forEach(l=>out.push(['ctx',l]));a.slice(p,a.length-s).forEach(l=>out.push(['del',l]));b.slice(p,b.length-s).forEach(l=>out.push(['add',l]));a.slice(a.length-s,a.length-s+2).forEach(l=>out.push(['ctx',l]));
 return {lines:out,add:b.length-p-s,del:a.length-p-s};}
// apply_patch text ("*** Update File: x" sections, or unified diff) → per-file line lists.
function tlPatch(text){
 const files=[];let f=null;
 for(const l of String(text).split('\n')){
  const h=l.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/)||l.match(/^\+\+\+ (?:b\/)?(.+)$/);
  if(h){const path=(h[2]||h[1]).trim();if(path!=='/dev/null'){f={file:path,lines:[],add:0,del:0,op:h[2]?h[1]:''};files.push(f);}continue;}
  if(/^(\*\*\*|--- |diff --git|index )/.test(l)||!f)continue;
  if(l.startsWith('@@')){f.lines.push(['hunk',l]);continue;}
  if(l[0]==='+'){f.add++;f.lines.push(['add',l.slice(1)]);}else if(l[0]==='-'){f.del++;f.lines.push(['del',l.slice(1)]);}else f.lines.push(['ctx',l.replace(/^ /,'')]);}
 return files;}
function toolInfo(t,r){
 if(t&&TL_TOOL.has(t))return TL_TOOL.get(t);
 const name=t?.title||r?.title||'';const kind=toolKind(name);const info={label:kind.label,icon:kind.icon,text:'',file:'',dir:'',diffs:[],add:0,del:0};
 if(!t){info.text=r?.title||'输出';return info;}
 const a=tlArgs(t),code=tlIsCode(t.text);
 const setFile=p=>{if(!p)return;const [n,d]=tlSplitPath(p);info.file=n;info.dir=d;info.path=String(p);};
 if(/^(edit|str_replace|str_replace_based_edit_tool)$/i.test(name)&&a){setFile(a.file_path||a.path);info.diffs.push({file:a.file_path||a.path,...tlDiff(a.old_string??a.old_str,a.new_string??a.new_str)});}
 else if(/^multiedit$/i.test(name)&&a){setFile(a.file_path);(a.edits||[]).forEach(e=>info.diffs.push({file:a.file_path,...tlDiff(e.old_string,e.new_string)}));}
 else if(/^write$/i.test(name)&&a){setFile(a.file_path||a.path);info.label='写入';const lines=String(a.content??'').split('\n');info.diffs.push({file:a.file_path||a.path,lines:lines.slice(0,400).map(l=>['add',l]),add:tlLines(a.content),del:0,whole:true});}
 else if(/^notebookedit$/i.test(name)&&a){setFile(a.notebook_path);}
 else if(/apply_patch/i.test(name)||/^\*\*\* Begin Patch/m.test(t.text)&&!code){const src=a?.input||a?.patch||t.text;tlPatch(src).forEach(f=>info.diffs.push(f));if(info.diffs[0])setFile(info.diffs[0].file);info.label='编辑';info.icon='pen';}
 else if(code&&codeModeCalls(t.text).includes('apply_patch')){const m=t.text.match(/\b(?:input|patch)\s*:\s*"((?:[^"\\]|\\.)*)"/);if(m){tlPatch(tlJsStr(m[1])).forEach(f=>info.diffs.push(f));if(info.diffs[0])setFile(info.diffs[0].file);info.label='编辑';info.icon='pen';}}
 else if(kind.label==='读取'&&a){setFile(a.file_path||a.path);if(a.offset)info.range='第 '+a.offset+(a.limit?'–'+(Number(a.offset)+Number(a.limit)-1):'')+' 行';}
 info.diffs.forEach(d=>{info.add+=d.add;info.del+=d.del;});
 if(info.diffs.length>1&&new Set(info.diffs.map(d=>d.file)).size>1)info.text=info.diffs.length+' 个文件';
 if(!info.file&&!info.text)info.text=toolSummary(t);
 TL_TOOL.set(t,info);return info;}
// Outcome of a command: exit code and, for test runners, how many passed / failed.
function resultInfo(r){
 if(!r)return null;if(TL_RESULT.has(r))return TL_RESULT.get(r);
 const all=String(r.text||''),t=all.length>8000?all.slice(0,2000)+'\n'+all.slice(-6000):all;
 const ex=t.match(/(?:^|\n)(?:Exit code|Process exited with code):?\s*(-?\d+)/);let pass=0,fail=0,found=false,m;
 if((m=t.match(/(?:^|\n)Ran (\d+) tests? in/))){found=true;const f=t.match(/FAILED \(([^)]*)\)/);if(f)for(const x of f[1].matchAll(/(failures|errors)=(\d+)/g))fail+=+x[2];pass=Math.max(0,+m[1]-fail);}
 else if(/\b\d+ passed\b/.test(t)){found=true;for(const x of t.matchAll(/\b(\d+) passed\b/g))pass=Math.max(pass,+x[1]);for(const x of t.matchAll(/\b(\d+) (?:failed|errors?)\b/g))fail=Math.max(fail,+x[1]);}
 else if((m=t.match(/(?:^|\n)# pass (\d+)/))){found=true;pass=+m[1];const f=t.match(/(?:^|\n)# fail (\d+)/);fail=f?+f[1]:0;}
 else{const ps=(t.match(/(?:^|\n)PASS[: ]/g)||[]).length,fs=(t.match(/(?:^|\n)FAIL[: ]/g)||[]).length;if(ps+fs>=2){found=true;pass=ps;fail=fs;}}
 const info={exit:ex?+ex[1]:null,tests:found?{pass,fail}:null,lines:tlLines(all)};TL_RESULT.set(r,info);return info;}
// Small chips after a summary: "+12 −3", "24 通过", "2 失败".
function tlStat(add,del){const n=el('span','tl-stat');if(add)n.append(el('span','plus','+'+add));if(del)n.append(el('span','minus','−'+del));return n;}
function tlTests(t){return el('span','tl-test '+(t.fail?'bad':'good'),t.fail?t.fail+' 失败'+(t.pass?' · '+t.pass+' 通过':''):t.pass+' 通过');}
function tlDiffView(d){if(!d.lines.length)return el('p','fine tl-diff-none','这次调用没有带改动内容，可以复制原始调用看看。');const pre=el('pre','tl-diff');const lines=d.lines.slice(0,400);
 lines.forEach(x=>pre.append(el('span','d-'+x[0],(x[0]==='add'?'+ ':x[0]==='del'?'− ':x[0]==='hunk'?'':'  ')+x[1])));
 if(d.lines.length>400)pre.append(el('span','d-hunk','… 还有 '+(d.lines.length-400)+' 行'));return pre;}
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
// Claude slash commands as the bridge passes them on: the command row and what it printed.
function tlCommand(text){const t=String(text||'').trim();
 if(/^<command-(name|message)>/.test(t)&&t.includes('<command-name>'))return {type:'cmd',name:tlTag(t,'command-name'),args:tlTag(t,'command-args')};
 const m=t.match(/^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/);if(m)return {type:'out',text:m[2].trim(),err:m[1]==='stderr'};
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
  if(m.kind==='user'){const cm=tlCommand(m.text);
   if(cm?.type==='cmd'){start(m,null,null);t.command={m,name:cm.name,args:cm.args,out:[],done:false};continue;}
   if(cm?.type==='out'&&t?.command&&!t.entries.length){if(cm.text)t.command.out.push(cm);t.command.done=true;continue;}
   if(cm?.type==='out'&&!cm.text)continue;
   if(/^<local-command-caveat>/.test(String(m.text).trim()))continue;
   const n=userNotice(m.text);if(!n){start(m,m,null);continue;}
   if(!t||settled()){start(m,null,{m,n});continue;}t.entries.push({type:'notice',m,n,id:m.id});continue;}
  if(!t){start(m,null,null);t.partial=true;}
  if(qaIsTool(m)){t.entries.push({type:'notice',m,n:qaNotice(m),id:m.id,question:true});continue;}
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
  const stamps=[turn.prompt||turn.notice?.m||turn.command?.m,...turn.entries.map(e=>e.m||e.entry)].map(x=>toDate(x?.timestamp)).filter(Boolean);
  turn.start=stamps[0]||null;turn.end=stamps.at(-1)||null;
  turn.interrupted=turn.entries.some(e=>e.type==='notice'&&e.n.label==='已中断');});
 return turns;}
function tlDuration(a,b){if(!a||!b)return '';const s=Math.max(0,Math.round((b-a)/1000));if(s<60)return s+' 秒';const m=Math.round(s/60);if(m<60)return m+' 分钟';return Math.floor(m/60)+' 小时'+(m%60?' '+m%60+' 分':'');}
function workSummary(turn){const s=turn.stats,parts=[];if(s.notes)parts.push(s.notes+' 条进展');if(s.ops)parts.push(s.ops+' 个操作');if(!s.notes&&!s.ops&&s.agents)parts.push(s.agents+' 条子 Agent 消息');
 const d=tlDuration(turn.start,turn.live?new Date():turn.end);if(d&&turn.prompt)parts.push(d);return parts.join(' · ');}
// One-line preview of the newest progress for the collapsed block.
function workPreview(turn){const last=turn.work.filter(e=>e.type!=='notice').at(-1);if(!last)return '';
 if(last.type==='tool'){const t=last.entry.tool,r=last.entry.result,i=toolInfo(t,r);return i.label+' '+(i.file?i.file:i.text);}
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
function toolSummaryNode(info,t,r){
 const s=el('span','tool-text');
 if(info.file){s.classList.add('has-file');s.append(el('span','tool-file',info.file));if(info.dir)s.append(el('span','tool-dir',info.dir));if(info.range)s.append(el('span','tool-dir',info.range));}
 else s.append(document.createTextNode(info.text||(r?.title||'输出')));return s;}
function toolRow(entry,open){
 const t=entry.tool,r=entry.result;const info=toolInfo(t,r),res=resultInfo(r);const failed=resultFailed(r);
 const d=el('details','tool-row'+(failed?' failed':''));d.dataset.key='row:'+entry.id;d.dataset.id=entry.id;d.open=!!open;const s=el('summary');
 s.append(el('span','tool-icon'),el('span','tool-verb',info.label),toolSummaryNode(info,t,r));s.firstChild.append(icon(info.icon));
 if(info.add||info.del)s.append(tlStat(info.add,info.del));
 if(res?.tests)s.append(tlTests(res.tests));else s.append(el('span','tool-state '+(failed?'bad':r?'good':'wait'),failed?(res?.exit?'退出码 '+res.exit:'失败'):r?'':'…'));
 const child=info.label==='子 Agent'?childFor([t?.text,r?.text]):null;if(child)s.append(childLink(child));d.append(s);
 // Bodies are built on first open: a long turn can hold hundreds of large outputs.
 const fill=()=>{if(d.childElementCount>1)return;const body=el('div','tool-body');
  if(t&&info.diffs.length){info.diffs.forEach(df=>{const cap=el('div','tool-caption');const [n,dir]=tlSplitPath(df.file);const name=el('span','tool-cap-file',n);if(dir)name.title=df.file;cap.append(name);const right=el('span','tool-cap-side');right.append(tlStat(df.add,df.del));cap.append(right);body.append(cap,tlDiffView(df));});
   const row=el('div','tool-raw');row.append(btn('复制原始调用','code-copy',()=>copyText(t.text),'copy'));body.append(row);}
  else if(t){const cap=el('div','tool-caption');const a=tlArgs(t);cap.append(el('span','',a?.description&&typeof a.description==='string'?a.description:info.label==='运行'?'命令':t.title||'调用内容'),btn('复制','code-copy',()=>copyText(toolInput(t)),'copy'));body.append(cap,el('pre','',toolInput(t)));if(t.truncated)body.append(el('small','','内容超过 16 KB，已截断。'));}
  if(r){const cap=el('div','tool-caption');cap.append(el('span','',(r.title||'执行结果')+(res.lines>12?' · '+res.lines+' 行':'')),btn('复制','code-copy',()=>copyText(r.text),'copy'));const out=el('pre','output',r.text);body.append(cap,out);if(r.truncated)body.append(el('small','','结果过长，已截断。'));
   // The end of a long output (exit code, test summary) is what matters: start there.
   requestAnimationFrame(()=>{out.scrollTop=out.scrollHeight;});}
  else body.append(el('p','fine','还没有输出。'));d.append(body);};
 if(d.open)fill();d.addEventListener('toggle',()=>{if(d.open)fill();});return d;}
// Totals over tool entries: files changed (+/−) and test results.
function tlTally(entries){
 const files=new Map();let add=0,del=0,last=null;
 for(const e of entries){const info=toolInfo(e.tool,e.result);info.diffs.forEach(d=>{files.set(d.file,1);});add+=info.add;del+=info.del;
  const res=resultInfo(e.result);if(res?.tests)last=res.tests;}
 // Tests are usually re-run until green: the latest run is the one that counts.
 return {files:files.size,add,del,tests:last};}
function tlTallyNodes(box,tally){
 if(tally.files){const n=el('span','tl-files','改 '+tally.files+' 个文件');box.append(n,tlStat(tally.add,tally.del));}
 if(tally.tests)box.append(tlTests(tally.tests));return box;}
function toolGroup(g,open,openRows){
 const d=el('details','tool-group');d.dataset.key='group:'+g.id;d.dataset.id=g.id;d.open=open.has('group:'+g.id);const s=el('summary');
 const failed=g.entries.filter(e=>resultFailed(e.result)).length;const running=g.entries.some(e=>e.tool&&!e.result);
 const kinds=new Map();g.entries.forEach(e=>{const l=toolInfo(e.tool,e.result).label;kinds.set(l,(kinds.get(l)||0)+1);});
 const top=[...kinds.entries()].sort((a,b)=>b[1]-a[1]);const lk=toolInfo(g.entries.at(-1).tool,g.entries.at(-1).result);
 const ic=el('span','tool-icon');ic.append(icon(top.length===1?lk.icon:'tool'));s.append(ic);
 const txt=el('span','tool-text');txt.append(el('strong','',g.entries.length+' 个操作'),document.createTextNode(' '+(top.length===1?lk.label+' '+(lk.file||lk.text):top.map(([l,n])=>l+' '+n).join(' · '))));s.append(txt);
 const tally=tlTally(g.entries);if(tally.add||tally.del)s.append(tlStat(tally.add,tally.del));if(tally.tests)s.append(tlTests(tally.tests));
 if(failed&&!tally.tests?.fail)s.append(el('span','tool-state bad',failed+' 失败'));else if(running&&tlWorking())s.append(el('span','spinner mini'));
 s.append(el('span','chev'));s.lastChild.append(icon('down'));d.append(s);
 const list=el('div','tool-list');g.entries.forEach(e=>list.append(toolRow(e,open.has('row:'+e.id)||openRows?.has?.(e.id))));d.append(list);return d;}
function tlWorking(){const st=S.chat?.agent?.agent_status;return !S.chat?.stale&&(st==='working'||st==='blocked');}
function messageRow(m,label){
 const row=el('article','message '+m.kind);row.dataset.mid=m.id;const meta=el('div','message-label');meta.append(el('span','',label),el('span','',clock(m.timestamp)));
 const bubble=el('div','bubble');bubble.append(m.kind==='user'?userText(m.text):markdown(m.text));
 bubble.oncontextmenu=e=>{e.preventDefault();messageMenu(m);};
 row.append(meta,bubble);if(m.truncated)row.append(el('small','fine','消息过长，已截断。'));return row;}
function userText(text){const box=el('div','md');text.split('\n').forEach((line,i)=>{if(i)box.append(el('br'));box.append(document.createTextNode(line));});return box;}
const expandedPrompts=new Set();
// Long prompts (pasted logs, task specs) are clamped; the person can expand them.
function promptRow(m){
 const {text,specs,files}=imgSplit({...m,text:promptText(m.text)});const row=messageRow({...m,text},'你');row.classList.add('prompt');const bubble=row.querySelector('.bubble');
 // Pictures sit under the words (outside the bubble, so clamping a long prompt never hides them).
 if(files.length){const list=fileList(files);list.oncontextmenu=e=>{e.preventDefault();messageMenu(m);};bubble.after(list);if(!text&&!specs.length)bubble.remove();}
 if(specs.length){const strip=imgStrip(specs);strip.oncontextmenu=bubble.oncontextmenu;bubble.after(strip);if(!text)bubble.remove();}
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
 const s=turn.stats;const d=el('details','work'+(turn.live?' live':'')+(s.failed?' has-failed':''));d.dataset.key='work:'+turn.id;
 // A turn that started on an earlier page changes its id once that page loads: its steps keep it open.
 const anchor=turn.work.at(-1)?.id||'';d.dataset.anchor=anchor;d.open=open.has('work:'+turn.id)||turn.work.some(e=>open.has('anchor:'+e.id));
 const sum=el('summary');const lead=el('span','work-lead');
 if(turn.live&&tlWorking())lead.append(el('span','spinner mini'));else lead.append(icon(s.failed?'alert':turn.interrupted?'stop':turn.final?'check':'tool'));
 const head=el('span','work-head');const title=el('span','work-title');title.append(el('strong','',turn.live&&tlWorking()?(S.chat.agent.agent_status==='blocked'?'等你确认':'正在工作'):turn.interrupted?'已中断':'工作过程'),el('span','work-stats',workSummary(turn)));
 if(s.failed)title.append(el('span','work-bad',s.failed+' 个失败'));
 head.append(title);const tally=tlTally(turn.work.filter(e=>e.type==='tool').map(e=>e.entry));
 const facts=!turn.live&&(tally.files||tally.tests)?tlTallyNodes(el('span','work-facts'),tally):null;
 const preview=facts?'':workPreview(turn);if(facts)head.append(facts);else if(preview)head.append(el('span','work-preview',preview));
 const chev=el('span','chev');chev.append(icon('down'));sum.append(lead,head,chev);d.append(sum);
 const fill=()=>{if(d.childElementCount>1)return;const list=el('div','work-list');let run=[];
  const flush=()=>{if(!run.length)return;if(run.length<=3)run.forEach(e=>list.append(toolRow(e,open.has('row:'+e.id))));else list.append(toolGroup({id:run[0].id,entries:run},open));run=[];};
  for(const e of turn.work){if(e.type==='tool'){run.push(e.entry);continue;}flush();
   if(e.type==='text')list.append(noteRow(e.m));else if(e.type==='agent')list.append(agentMessageRow(e.m,open));else list.append(noticeRow(e.m,e.n,open));}
  flush();d.append(list);};
 if(d.open)fill();d.addEventListener('toggle',()=>{if(d.open)fill();});return d;}
function replyRow(m,who,turn){
 const row=el('article','message assistant reply');row.dataset.mid=m.id;const meta=el('div','message-label');meta.append(el('span','who',who),el('span','',clock(m.timestamp)));
 // The answer is what people copy and reply to: one tap, no long press needed.
 const acts=el('span','msg-acts');const cp=btn('复制','msg-act',()=>copyText(mdClean(m.text)),'copy');cp.setAttribute('aria-label','复制回答');acts.append(cp);
 if(tlCanSend()){const q=btn('引用','msg-act',()=>quoteInto(m),'reply');q.setAttribute('aria-label','引用回答');acts.append(q);}meta.append(acts);
 const bubble=el('div','bubble');bubble.append(markdown(m.text));bubble.oncontextmenu=e=>{e.preventDefault();messageMenu(m);};
 row.append(meta,bubble);if(m.truncated)row.append(el('small','fine','消息过长，已截断。'));return row;}
// While a turn runs there is no reply yet; show its newest progress note in place.
function progressRow(m,who){const row=el('article','message assistant progress');row.dataset.mid=m.id;const meta=el('div','message-label');meta.append(el('span','',who+' · 最新进展'),el('span','',clock(m.timestamp)));const b=el('div','bubble');b.append(markdown(m.text));row.append(meta,b);return row;}
function turnView(turn,who,open){
 const sec=el('section','turn'+(turn.live?' live':''));sec.dataset.id=turn.id;
 if(turn.partial)sec.append(el('div','turn-cont','接上文 · 这一轮的开头在更早的记录里'));
 if(turn.command)sec.append(slashCommandRow(turn));else if(turn.prompt)sec.append(promptRow(turn.prompt));else if(turn.notice)sec.append(noticeRow(turn.notice.m,turn.notice.n,open));
 // Only harness notices (no notes, no tools): show them as their own rows, not an empty 「工作过程」.
 const real=turn.work.filter(e=>e.type!=='notice'||e.question);
 if(real.length)sec.append(workBlock(turn,open));else turn.work.forEach(e=>{if(turn.command&&e.n?.label==='命令')return;sec.append(noticeRow(e.m,e.n,open));});
 const kids=turnChildren(turn);if(kids.length)sec.append(childStrip(kids));
 qaTurnRows(sec,turn);
 if(turn.final)sec.append(replyRow(turn.final.m,who,turn));
 else if(turn.live||turn.last){const last=turn.work.filter(e=>e.type==='text').at(-1);if(last)sec.append(progressRow(last.m,who));}
 return sec;}
// ─── Message actions: copy, quote into the composer, select text ──────────
function tlCanSend(){const c=S.chat;return !!(c?.agent&&!c.stale&&!c.exited&&(S.device||S.demo));}
// "> " lines from the start of a message: enough to show what is being answered.
function quoteText(text){
 const lines=[];let fence=false;
 for(const raw of mdClean(text).split('\n')){if(/^ {0,3}(```|~~~)/.test(raw)){fence=!fence;if(fence)lines.push('[代码]');continue;}if(fence)continue;
  const l=raw.replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/,'').replace(/[*`]/g,'').replace(/\s+/g,' ').trim();
  if(l&&!/^\|?\s*:?-{3,}/.test(l)&&lines.at(-1)!==l)lines.push(l);}
 const out=[];let n=0;for(const l of lines){if(out.length>=4||n>240){out.push('…');break;}const s=l.length>120?l.slice(0,118)+'…':l;out.push(s);n+=s.length;}
 return out.map(l=>'> '+l).join('\n');}
function quoteInto(m){
 if(!tlCanSend()){toast('这里只读，不能回复');return;}
 const key=draftKey(),cur=S.drafts.get(key)||'';S.drafts.set(key,(cur.trim()?cur.replace(/\s*$/,'\n\n'):'')+quoteText(m.text)+'\n\n');renderComposer();
 const input=document.querySelector('#composer textarea');if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length);input.closest('.composer')?.grow?.();}}
function codeBlocks(text){const out=[];const re=/^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*\n([\s\S]*?)\n {0,3}\1[ \t]*$/gm;let m;while((m=re.exec(String(text||''))))out.push({lang:m[2],code:m[3]});return out;}
function selectSheet(m){const box=sheet('选择文字');box.classList.add('select-sheet');box.append(el('p','fine','长按拖动选择需要的部分。'));const t=el('div','select-text',m.kind==='user'?promptText(m.text):mdClean(m.text));box.append(t);}
function messageMenu(m){
 const box=sheet(m.kind==='user'?'你的消息':'消息');
 const text=m.kind==='user'?promptText(m.text):mdClean(m.text);
 menuItem(box,'复制全文',()=>copyText(text),'copy');
 codeBlocks(m.text).slice(0,4).forEach((c,i,all)=>menuItem(box,all.length>1?'复制代码 '+(i+1):'复制代码',()=>copyText(c.code),'terminal',(c.lang?c.lang+' · ':'')+tlLines(c.code)+' 行'));
 if(tlCanSend())menuItem(box,'引用回复',()=>quoteInto(m),'reply','在输入框里引用这段');
 if(tlCanSend()&&m.kind==='user')menuItem(box,'放入输入框',()=>{S.drafts.set(draftKey(),text);renderComposer();},'edit','改一改再发');
 menuItem(box,'选择文字',()=>selectSheet(m),'pen');}
// Tapping a file path: where it is, copy, and what this conversation changed in it.
function fileSheet(ref){
 const path=String(ref).replace(/:\d+(?:[-:,]\d+)*$/,''),rel=tlRel(path),name=rel.split('/').pop()||rel;
 const hits=[];const tail=rel.replace(/^(\.\/|~\/)/,'');
 for(const m of S.messages){if(m.kind!=='tool')continue;const info=toolInfo(m,null);for(const d of info.diffs){const f=String(d.file||'');if(f===path||f.endsWith('/'+tail)||tlRel(f)===tail)hits.push({m,d});}}
 const box=sheet(name);box.classList.add('file-sheet');box.append(el('p','file-sheet-path',hits[0]?.d.file||path));if(typeof fileViewButton==='function')box.append(fileViewButton(ref));
 const row=el('div','sheet-actions');row.append(btn('复制路径','secondary',()=>{closeSheet();copyText(ref);},'copy'),btn('复制文件名','secondary',()=>{closeSheet();copyText(name);},'file'));box.append(row);
 if(!hits.length){box.append(el('p','fine',S.more?'已加载的记录里没改过这个文件。':'这段对话里没改过这个文件。'));return;}
 const add=hits.reduce((a,h)=>a+h.d.add,0),del=hits.reduce((a,h)=>a+h.d.del,0);
 const head=el('div','section-label');head.append(document.createTextNode('这段对话里的改动 · '+hits.length+' 处 '),tlStat(add,del));box.append(head);
 hits.slice(-12).reverse().forEach(h=>{const cap=el('div','tool-caption');cap.append(el('span','',clock(h.m.timestamp)),tlStat(h.d.add,h.d.del));box.append(cap,tlDiffView(h.d));});
 if(hits.length>12)box.append(el('p','fine','只显示最近 12 处。'));}

// ─── Render ─────────────────────────────────────────────────────────────────
// Finished turns never change, so their DOM is kept between renders (polls, queue and slash
// updates repaint often): only new or still-changing turns are rebuilt. Open/closed state and
// scroll position inside kept turns survive for free.
const TL_KEEP={chat:null,mode:'',nodes:new Map()};
// Motion. Rows enter once: a bubble being sent rises from the composer; a message that arrives in a
// poll fades in. Kept, re-inserted or repainted rows never replay it (the class is dropped when it
// ends), pages loaded from the top and the first paint of a chat are quiet, and the transcript copy of
// a just-sent message takes over its bubble without moving (only the label crossfades).
const TL_SEEN=new Set(),TL_HANDOFF=new Set();
function tlCalm(){return document.documentElement.classList.contains('reduce-motion')||matchMedia('(prefers-reduced-motion: reduce)').matches;}
function tlEnter(node,cls){
 if(!node||tlCalm())return;node.classList.remove(cls);void node.offsetWidth;node.classList.add(cls);
 const done=e=>{if(e&&e.target!==node)return;node.classList.remove(cls);node.removeEventListener('animationend',done);};
 node.addEventListener('animationend',done);setTimeout(done,700);}
function turnSig(turn){
 if(turn.last||turn.live||turn.command||turn.entries.some(e=>e.question))return '';
 const last=turn.entries.at(-1),lm=last?.m||last?.entry?.result||last?.entry?.tool;
 return [turn.prompt?.id||turn.notice?.m.id||'',turn.entries.length,last?.id||'',lm?.text?.length||0,turn.entries.filter(e=>e.type==='tool'&&e.entry.result).length,turn.final?.id||'',turn.partial?1:0,S.children.length,tlCanSend()?1:0].join('|');}
function keptTurn(turn,who,open,next){
 const sig=turnSig(turn),old=TL_KEEP.nodes.get(turn.id);
 const node=sig&&old&&old.sig===sig?old.node:turnView(turn,who,open);if(sig)next.set(turn.id,{sig,node});return node;}
// opts.quiet: an earlier page (or the first paint) is being added; nothing animates.
function renderTimeline(opts={}){
 const body=document.getElementById('chat-scroll');if(!body)return;
 if(TL_KEEP.chat!==S.chat||TL_KEEP.mode!==S.chatMode){TL_KEEP.chat=S.chat;TL_KEEP.mode=S.chatMode;TL_KEEP.nodes=new Map();TL_SEEN.clear();TL_HANDOFF.clear();TL_SEND.clear();}
 const open=new Set([...body.querySelectorAll('details[data-key][open]')].map(x=>x.dataset.key));
 body.querySelectorAll('details.work[open][data-anchor]').forEach(x=>open.add('anchor:'+x.dataset.anchor));
 // Rows are collected first, then patched into the live list: kept nodes that stay in place are
 // never detached (no layout thrash on every poll).
 const nodes=[],sink={append:(...ns)=>ns.forEach(n=>nodes.push(typeof n==='string'?document.createTextNode(n):n))};
 const used=new Set();TL_KEEP.used=used;
 tlBuild(sink,open);
 let list=body.firstElementChild;if(!list||!list.classList.contains('timeline')||body.childElementCount>1){body.replaceChildren();list=el('div','timeline');body.append(list);}
 const want=new Set(nodes);[...list.childNodes].forEach(n=>{if(!want.has(n))n.remove();});
 nodes.forEach((n,i)=>{const at=list.childNodes[i];if(at!==n)list.insertBefore(n,at||null);});
 if(S.chatMode!=='terminal'){for(const k of [...TL_SEND.keys()])if(!used.has(k))TL_SEND.delete(k);tlArrivals(list,opts.quiet);}}
// New transcript rows: the hand-off of a sent bubble only crossfades its label; others fade in once.
function tlArrivals(list,quiet){
 const first=!TL_SEEN.size;
 for(const r of list.querySelectorAll('.message[data-mid]')){const id=r.dataset.mid;if(TL_SEEN.has(id))continue;TL_SEEN.add(id);
  if(TL_HANDOFF.has(id)){TL_HANDOFF.delete(id);tlEnter(r.querySelector('.message-label'),'swap');}
  else if(!quiet&&!first)tlEnter(r,'fresh');}}

// ─── Earlier pages ──────────────────────────────────────────────────────────
// One node at the top of the list, kept across repaints (a tap is never lost to a redraw): the
// 「加载更早消息」 button, a spinner while a page loads, an inline error with 重试, or a quiet
// 「已到记录起点」. Its height never changes between states, so nothing below it shifts.
function tlOlderState(){return typeof HQ!=='undefined'&&HQ.epoch===S.epoch&&HQ.state?HQ.state:S.more?'more':'start';}
function olderControl(){let box=TL_KEEP.older;if(!box){box=el('div','older');TL_KEEP.older=box;}olderSync(box);return box;}
function olderSync(box=TL_KEEP.older){
 if(!box)return;const st=tlOlderState(),sig=st+'|'+(st==='error'?HQ.error:'');if(box.dataset.sig===sig)return;box.dataset.sig=sig;box.className='older is-'+st;
 if(st==='more'){let b=TL_KEEP.more;if(!b){b=btn('加载更早消息','link-btn older-btn',()=>fetchHistory(true));TL_KEEP.more=b;}b.disabled=false;box.replaceChildren(b);}
 else if(st==='loading'){const s=el('div','older-status');s.setAttribute('role','status');s.append(el('span','spinner mini'),el('span','','正在加载更早消息…'));box.replaceChildren(s);}
 else if(st==='error'){const t=el('span','older-error','没加载出来'+(HQ.error?'：'+HQ.error:''));t.setAttribute('role','alert');box.replaceChildren(t,btn('重试','older-retry',()=>fetchHistory(true),'refresh'));}
 else box.replaceChildren(el('span','older-start','已到记录起点'));}

// ─── Messages being sent: the outbox and the queue ──────────────────────────
// One node per message, keyed by its row id and kept until it leaves: a queued message that goes out
// keeps its bubble (queue row → sent row), so state changes only crossfade the label and recolour.
const TL_SEND=new Map(),TL_SEND_KEY=new WeakMap();let tlSendSeq=0;
function tlSendKey(o){if(o.row)return o.row;let k=TL_SEND_KEY.get(o);if(!k){k='r'+(++tlSendSeq);TL_SEND_KEY.set(o,k);}return k;}
// spec: {cls, label, spin, text, images, files, at, reason, acts:{sig, build()}}
function tlSendRow(key,spec){
 let row=TL_SEND.get(key);TL_KEEP.used?.add(key);
 if(!row){
  row=el('article');row.dataset.send=key;const meta=el('div','message-label');meta.append(el('span','send-spin'),el('span','send-state'));row.append(meta);
  if(spec.text.trim()){const b=el('div','bubble');b.append(userText(spec.text));row.append(b);
   const lines=spec.text.split('\n').length;if(spec.text.length>420||lines>8){b.classList.add('clamped');const more=btn('展开全文 · '+(lines>8?lines+' 行':spec.text.length+' 字'),'prompt-more',()=>{const o=b.classList.toggle('clamped');more.textContent=o?'展开全文':'收起';});row.append(more);}}
  if(spec.images?.length)row.append(imgStrip(spec.images));if(spec.files?.length)row.append(fileList(spec.files));
  TL_SEND.set(key,row);row.className='message user '+spec.cls;
  // Only a message written just now rises in; reopening a chat shows waiting ones in place.
  if(Date.now()-(spec.at||0)<1500)tlEnter(row,'send-in');}
 const keep=['send-in'].filter(c=>row.classList.contains(c));row.className='message user '+spec.cls+(keep.length?' '+keep.join(' '):'');
 const spin=row.querySelector('.send-spin');spin.className='send-spin'+(spec.spin?' spinner mini':'');
 const st=row.querySelector('.send-state');if(st.textContent!==spec.label){const had=!!st.textContent;st.textContent=spec.label;if(had)tlEnter(st,'swap');}
 let reason=row.querySelector('.queue-reason');
 if(spec.reason){if(!reason){reason=el('p','queue-reason');const acts=row.querySelector('.queue-actions');if(acts)acts.before(reason);else row.append(reason);}if(reason.textContent!==spec.reason)reason.textContent=spec.reason;}else reason?.remove();
 let acts=row.querySelector('.queue-actions');const sig=spec.acts?.sig||'';
 if((acts?.dataset.sig||'')!==sig){acts?.remove();if(spec.acts){acts=spec.acts.build();acts.dataset.sig=sig;row.append(acts);}}
 return row;}
function outboxRows(list,dayMark){
 for(const o of S.outbox.filter(o=>o.key===draftKey())){
  const failed=o.state==='failed'||o.state==='rejected';
  const row=tlSendRow(tlSendKey(o),{cls:'pending '+(failed?'failed '+o.state:o.state),label:o.state==='rejected'?'没发出去':o.state==='failed'?'发送未确认':o.state==='sending'?o.stage||'发送中…':'已送达 Agent',
   spin:o.state==='sending',text:o.text,images:o.images,files:o.files,at:o.at});
  // Its own turn, laid out like the transcript turn that will replace it.
  let wrap=row.parentElement;if(!wrap||!wrap.classList.contains('send-turn')){wrap=el('section','turn send-turn');wrap.append(row);}
  dayMark(new Date(o.at).toISOString());list.append(wrap);}}
// FLIP: rows that moved because a neighbour left (the queue head went out) glide to their new place.
function tlFlipStart(n){const m=new Map(),top=n.getBoundingClientRect().top-n.scrollTop;for(const [k,r] of TL_SEND)if(r.isConnected)m.set(k,r.getBoundingClientRect().top-top);return m;}
function tlFlipEnd(n,m){
 if(!m.size||tlCalm()||!Element.prototype.animate)return;const top=n.getBoundingClientRect().top-n.scrollTop;
 for(const [k,y] of m){const r=TL_SEND.get(k);if(!r?.isConnected||r.classList.contains('send-in'))continue;const dy=y-(r.getBoundingClientRect().top-top);
  if(Math.abs(dy)>1&&Math.abs(dy)<400)r.animate([{transform:'translateY('+dy+'px)'},{transform:'none'}],{duration:220,easing:'cubic-bezier(.16,1,.3,1)'});}}
function tlBuild(list,open){
 followMarker(list);
 if(S.chatMode==='terminal'){if(S.chat.noTranscript)list.append(noTranscriptNote(false));list.append(termAgentView(S.terminalText||(S.chat.agent?'正在读取终端…':'这条历史没有在线终端。'),S.chat.agent?btn('刷新终端','link-btn',()=>fetchTerminal(),'refresh'):null,S.terminalText&&S.terminalAnsi));if(S.chat.noTranscript){slashRest(list);queueTimeline(list);}return;}
 // An agent whose conversation cannot be read: the screen is the conversation; sends and the queue still show.
 if(S.chat.noTranscript){list.append(noTranscriptNote(true));
  if(S.chat.agent&&S.terminalText){list.append(el('div','section-label','终端最新画面'));list.append(el('pre','agent-terminal compact',tail(S.terminalText,14)));}
  S.outbox=S.outbox.filter(o=>o.key!==draftKey()||o.state!=='sent'||Date.now()-o.at<180000);outboxRows(list,()=>{});slashRest(list);queueTimeline(list);return;}
 if(!S.chat.record){const box=el('div','unlinked');box.append(el('h2','','还没关联到对话记录'),el('p','muted',S.chat.historyIssue||'正在定位这个窗格对应的历史记录…'));
  if(S.chat.historyIssue)box.append(btn('选择历史记录','primary',pickHistory));list.append(box);
  const candidates=S.chat.agent?.history_ref?.candidates||[];if(candidates.length){list.append(el('div','section-label','候选历史 · 点击后确认'));const g=el('div','card list-card');candidates.forEach(rec=>{const b=btn('','card-button',()=>chooseHistory(rec,S.chat.agent));const t=el('div','grow');t.append(el('div','card-title',rec.title),el('div','card-meta',relative(rec.modified)+' · '+String(rec.thread).slice(0,8)));b.append(t,icon('chevron'));g.append(b);});list.append(g);}
  if(S.chat.agent&&S.terminalText){list.append(el('div','section-label','终端最新画面'));const pre=el('pre','agent-terminal compact');screenPaint(pre,S.terminalText,S.terminalAnsi,14);list.append(pre);}
  slashRest(list);queueTimeline(list);return;}
 // Until the first fresh read arrives (cache shown, or still loading) paging is unknown: no button.
 const c=S.chat,settling=!!(c.cached||c.waiting||c.historyLoading);
 // The same node across repaints, so a tap is never lost to a redraw.
 if(!settling&&(S.more||S.messages.length))list.append(olderControl());
 cacheChatNote(list);
 if(S.chat.historyError){const n=el('div','note error');n.append(el('span','grow',S.chat.historyError),btn('重试','secondary small',()=>{S.paused=false;fetchHistory(false,true);}));list.append(n);}
 if(S.historyNote)list.append(el('p','note',S.historyNote));
 const commandsOnly=S.chatMode==='commands';const who=providerName(S.chat.provider);let day='';let count=0;
 const dayMark=ts=>{const d=dayLabel(ts);if(d&&d!==day){day=d;list.append(el('div','date-separator',d));}};
 if(commandsOnly){const items=buildItems(S.messages,true);count=items.length;for(const it of items){dayMark(it.entry.timestamp);list.append(toolRow(it.entry,true));}}
 else{// A just-sent prompt means the newest transcript turn is already finished.
  const live=tlWorking()&&!S.outbox.some(o=>o.key===draftKey()&&o.state!=='failed');const turns=buildTurns(S.messages,live);count=turns.length;slashMatch(turns);const next=new Map();for(const turn of turns){slashBefore(list,turn.start);dayMark(turn.start);list.append(keptTurn(turn,who,open,next));}TL_KEEP.nodes=next;}
 if(!commandsOnly){count+=slashCards().length;slashRest(list);}
 outboxRows(list,dayMark);
  queueTimeline(list);
 if(!count&&!S.chat.historyError){
  if(S.chat.historyLoading||S.more)list.append(el('div','empty small',S.chat.historyLoading?'正在读取对话记录…':'这一页没有可显示的消息，继续加载更早记录。'));
  // A real empty state, not a stray line over a blank page.
  else if(commandsOnly)empty(list,'还没有执行过命令','Agent 跑过的命令和输出会列在这里。',undefined,'terminal');
  else empty(list,'还没有可显示的消息','隐藏推理和系统消息不在这里显示；有新的消息会自动出现。');}}
// What the app can and cannot do for an agent kind without a transcript reader (app.js noTranscript).
function noTranscriptNote(withLink){
 const box=el('div','note no-transcript');box.setAttribute('role','note');
 const t=el('div','grow');t.append(el('strong','','这个 Agent 的对话记录还读不了，先看终端画面'),el('span','fine',providerName(S.chat.provider)+' 的回复显示在终端里。发消息、排队、按键和关闭都照常能用。'));box.append(t);
 if(withLink)box.append(btn('看终端','secondary small',()=>{S.chatMode='terminal';S.stick=true;S.epoch++;renderChat();fetchTerminal();},'terminal'));
 return box;}
function tail(text,n){return text.replace(/\s+$/,'').split('\n').slice(-n).join('\n');}
