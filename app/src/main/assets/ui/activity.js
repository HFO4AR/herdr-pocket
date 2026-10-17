'use strict';
// The live activity line at the end of the conversation (design: native Claude Code / Codex, where a
// spinner, a verb, the elapsed time and the token count say the agent is alive). One kept node
// (#act), so its animation never restarts on a repaint. It answers, honestly:
//   · 已发出，等它开始…   the prompt went out, Herdr has not reported the agent working yet;
//   · 正在思考 / 正在执行 <tool> / 正在输出   Herdr says working (the open tool call comes from the
//     transcript; thinking / output from the agent's own status line on its screen, bridge `read`
//     → `activity` {verb, seconds, tokens, dir, thinking, line});
//   · 收尾中，正在读取回复…   Herdr says it stopped, the reply is not in the transcript yet;
//   · 子 Agent 在跑 · N   the agent rests while its sub-agents work (kids.js), each with its step;
//   · 状态有一会儿没更新了   no status for a while: the animation stops and it says so.
// It goes away on idle / done / blocked (the question card or 「做完了」 take over). A running
// sub-agent's own record shows the same line (read-only), polled faster while it runs.
// Text nodes only. Loaded right after foot.js; functions here call app.js helpers at run time.
const ACT={node:null,kind:'',screen:null,readAt:0,tokens:-1,grow:0,said:'',io:null,seen:false,wantRead:0};
const ACT_STALE=12000,ACT_SENT_SLOW=20000;
const ACT_KID_VERB={run:'运行',edit:'修改',read:'查看',search:'搜索',web:'查资料',agent:'派子 Agent',plan:'更新计划',wait:'等输出',ask:'在问',tool:'调用'};

// ─── Inputs ─────────────────────────────────────────────────────────────────
// A screen read (app.js fetchTerminal) came back: keep the agent's own status line.
function actScreen(r){
 const a=r&&r.activity&&typeof r.activity==='object'&&typeof r.activity.verb==='string'?r.activity:null;
 ACT.readAt=Date.now();ACT.readErr='';
 if(a){const n=actTokens(a.tokens);ACT.grow=n>=0&&ACT.tokens>=0&&n>ACT.tokens?Date.now():ACT.grow;ACT.tokens=n;}
 // The agent's own clock as a start time; kept steady unless it moves by more than a read's jitter.
 const base=a&&Number.isFinite(a.seconds)?Date.now()-a.seconds*1000:0,was=ACT.base;if(!base||!ACT.base||Math.abs(base-ACT.base)>2500)ACT.base=base;
 ACT.screen=a?{...a,at:Date.now()}:null;actTick();if(ACT.base!==was&&S.chat)updateChatMeta();}
function actTokens(t){const m=String(t||'').match(/^([\d.,]+)\s*([kKmM]?)$/);if(!m)return -1;const v=parseFloat(m[1].replace(/,/g,''));return isNaN(v)?-1:v*(/k/i.test(m[2])?1e3:/m/i.test(m[2])?1e6:1);}
function actForget(){ACT.screen=null;ACT.tokens=-1;ACT.grow=0;ACT.readAt=0;ACT.base=0;ACT.readErr='';}
// The agent's words, while the read is fresh: "Ionizing… · ↓ 1.2k tokens".
function actWords(){const s=ACT.screen;if(!s||Date.now()-s.at>8000)return '';
 const bits=[s.verb.replace(/[.…]+$/,'')+'…'];if(s.tokens)bits.push((s.dir||'')+' '+s.tokens+' tokens');if(s.thinking)bits.push('thinking');return bits.join(' · ').replace(/\s+/g,' ').trim();}

// The newest open tool call of the current turn (no result yet), from the transcript.
function actOpenTool(){
 const ms=S.messages;if(!ms?.length)return null;let user=-1;for(let i=ms.length-1;i>=0;i--)if(ms[i].kind==='user'&&!userNotice(ms[i].text)){user=i;break;}
 const done=new Set();for(let i=ms.length-1;i>user;i--){const m=ms[i];if(m.kind==='result'&&m.call_id)done.add(m.call_id);
  if(m.kind==='tool'){if(m.call_id&&done.has(m.call_id))return null;if(qaIsTool(m))return null;return m;}
  if(m.kind==='assistant')return null;}
 return null;}
function actToolText(m){const i=toolInfo(m,null);return {verb:i.label,target:i.file||i.text||'',icon:i.icon};}

// ─── State ──────────────────────────────────────────────────────────────────
// What the line says now, or null. {kind, label, at (elapsed base), tool, words, note, calm}
function actInfo(){
 const c=S.chat;if(!c||S.chatMode==='terminal')return null;
 if(!c.agent)return c.record?.parent&&c.kidRunning?actKidInfo():null;
 if(c.stale||c.exited||(!S.device&&!S.demo))return null;
 const a=c.agent,st=a.agent_status,rec=S.since.get(agentKey(a)),now=Date.now(),sent=c.sentAt||0;
 const fresh=S.demo||a.tmux||now-Math.max(S.liveAt||0,ACT.readAt||0,ACT.resumeAt||0,c.sentAt||0)<ACT_STALE;
 const kids=kidsRunning(a);
 if(st==='blocked')return null;
 if(st==='working'){
  // Optimistic "working" right after a send (app.js sendMessage) until Herdr or the screen says so.
  const confirmed=rec&&(rec.status==='working'||rec.status==='kids')&&(rec.at||0)>=sent-1000||ACT.screen&&now-ACT.screen.at<8000;
  if(!confirmed&&sent&&now-sent<60000)return actSent(sent,fresh);
  if(!fresh)return actStale();
  const s=ACT.screen&&now-ACT.screen.at<8000?ACT.screen:null;
  // Elapsed: the agent's own count when its screen shows one, else since Herdr said working / the send.
  const at=s&&ACT.base?ACT.base:statusSince(a)||sent||0;
  const open=c.noTranscript?null:actOpenTool();
  if(open){const t=actToolText(open);return {kind:'tool',label:'正在执行',tool:t,at,words:actWords(),kids};}
  if(s?.thinking)return {kind:'think',label:'正在思考',at,words:actWords(),kids};
  if(s&&ACT.grow&&now-ACT.grow<6000)return {kind:'write',label:'正在输出',at,words:actWords(),kids};
  return {kind:'think',label:s?'正在思考':'正在工作',at,words:actWords(),kids};}
 if(st==='idle'||st==='done'){
  if(kids)return {kind:'kids',label:'子 Agent 在跑 · '+kids,at:0,kids};
  // It worked and stopped after the send: the reply is on its way. Otherwise it has not started.
  // "Not started yet" only for a send from this phone; anything else waiting for its reply is the tail.
  // Any state change seen since the send means it got going (it may have stopped again already).
  const worked=!!rec&&rec.at!=null&&(rec.at||0)>=sent-1000;
  if(c.record){if(!awaitingReply())return null;return !worked&&sent&&now-sent<60000?actSent(sent,fresh):{kind:'tail',label:'收尾中，正在读取回复…',at:0,calm:true};}
  // No transcript to wait for (other agent kinds, unlinked panes): only the start is worth saying.
  return sent&&!worked&&now-sent<ACT_SENT_SLOW*3?actSent(sent,fresh):null;}
 // Herdr said something this app does not know: never guess.
 if(sent&&now-sent<60000)return {kind:'unknown',label:'状态未知',note:'Herdr 报的状态是「'+String(st||'空').slice(0,20)+'」，看一眼终端最准',at:0,calm:true};
 return null;}
function actSent(sent,fresh){
 const slow=sent&&Date.now()-sent>ACT_SENT_SLOW;
 return {kind:'sent',label:'已发出，等它开始…',at:sent,calm:!fresh,note:!fresh?'状态有一会儿没更新了，网络可能慢':slow?'还没看到它动起来，可以看一眼终端':'',term:slow};}
function actStale(){const last=Math.max(S.liveAt||0,ACT.readAt||0);
 return {kind:'stale',label:'状态有一会儿没更新了',note:last?'上次更新是 '+sinceText('upd',Date.now()-last).replace(/更新$/,'')+'，可能网络慢或断了':'还没读到状态',at:0,calm:true};}
// A running sub-agent's own record (read-only): its step from the transcript.
function actKidInfo(){
 const ms=S.messages,open=actOpenTool();let at=Date.parse(S.chat.record?.started||'')||0;
 if(!at)for(let i=ms.length-1;i>=0;i--)if(ms[i].kind==='user'){at=toDate(ms[i].timestamp)?.getTime()||0;break;}
 if(open)return {kind:'tool',label:'子 Agent 正在执行',tool:actToolText(open),at,note:'只读 · 跟着它的记录实时刷新',kid:true};
 return {kind:'think',label:'子 Agent 正在工作',at,note:'只读 · 跟着它的记录实时刷新',kid:true};}

// ─── The node ───────────────────────────────────────────────────────────────
function actNode(){
 let n=ACT.node;if(n)return n;
 n=el('section','act');n.id='act';n.setAttribute('aria-label','Agent 状态');
 const main=el('div','act-main');const mark=el('span','act-mark');mark.setAttribute('aria-hidden','true');mark.append(el('span','act-glyph'));
 const text=el('div','act-text');const line=el('div','act-line');line.append(el('strong','act-label'),el('span','act-time'));
 const live=el('span','sr-only act-live');live.setAttribute('role','status');live.setAttribute('aria-live','polite');
 text.append(line,el('div','act-tool'),el('div','act-words'),el('div','act-note'));main.append(mark,text);
 n.append(main,el('div','act-kids'),live);ACT.node=n;
 if(typeof IntersectionObserver!=='undefined'){ACT.io=new IntersectionObserver(es=>{const v=es.some(e=>e.isIntersecting);if(v!==ACT.seen){ACT.seen=v;actSeen();}},{threshold:.6});ACT.io.observe(n);}
 return n;}
// The rail's 「执行中」 drops its own timer while this line is in view (no second clock on screen).
function actSeen(){const f=document.getElementById('composer');if(f)f.classList.toggle('act-seen',ACT.seen&&!!ACT.node?.isConnected);}
function actFill(info){
 const n=actNode();n.className='act k-'+info.kind+(info.calm?' calm':'')+(info.kid?' kid':'')+(n.classList.contains('act-enter')?' act-enter':'');n.dataset.kind=info.kind;
 const set=(sel,text)=>{const x=n.querySelector(sel);if(x.textContent!==text)x.textContent=text;x.classList.toggle('hidden',!text);return x;};
 set('.act-label',info.label);
 const t=n.querySelector('.act-time');t.textContent=info.at?dur(Date.now()-info.at):'';t.classList.toggle('hidden',!info.at);
 const tool=n.querySelector('.act-tool');const tsig=info.tool?info.tool.verb+'\u0000'+info.tool.target:'';
 if(tool.dataset.sig!==tsig){tool.dataset.sig=tsig;tool.replaceChildren();if(info.tool){tool.append(icon(info.tool.icon||'tool'),el('span','act-verb',info.tool.verb));if(info.tool.target)tool.append(el('code','act-target',info.tool.target));}}
 tool.classList.toggle('hidden',!info.tool);
 set('.act-words',info.words?providerName(S.chat.provider)+'：'+info.words:'');
 const note=set('.act-note',info.note||'');
 if(info.term&&!note.querySelector('button')){note.append(' ',btn('看终端','link-btn act-term',()=>{S.chatMode='terminal';S.stick=true;S.epoch++;renderChat();fetchTerminal();}));}
 actKidsFill(n.querySelector('.act-kids'),info);
 // Screen readers hear the state when it changes, never the ticking clock.
 const say=info.label+(info.tool?'：'+info.tool.verb+' '+info.tool.target:'');if(ACT.said!==say){ACT.said=say;n.querySelector('.act-live').textContent=say;}}
// Running sub-agents under the line: what each does right now; finished ones fade out.
function actKids(){const c=S.chat;if(!c?.agent||c.stale)return [];return kidsChatItems().filter(x=>x.running||x.state==='starting');}
function actKidsFill(box,info){
 const items=info.kid?[]:actKids(),shown=items.slice(0,3);
 const sig=shown.map(x=>(x.id||x.title)+'|'+actKidState(x).text+'|'+(x.activity?.text||'')).join('\n')+'|'+items.length;
 box.classList.toggle('hidden',!items.length);
 if(box.dataset.sig===sig){box.querySelectorAll('[data-at]').forEach(s=>{s.textContent=dur(Date.now()-Number(s.dataset.at));});return;}
 box.dataset.sig=sig;box.replaceChildren();if(!items.length)return;
 const head=el('div','act-kids-head');head.append(el('span','',items.length+' 个子 Agent 在跑'));box.append(head);
 for(const x of shown)box.append(actKidRow(x));
 if(items.length>shown.length){const more=btn('还有 '+(items.length-shown.length)+' 个 · 全部看','link-btn act-kids-more',agentSwitcher);box.append(more);}}
// What one sub-agent is doing: its open tool call, the note it just wrote, or just that it runs.
function actKidState(x){
 const a=x.activity;if(x.state==='starting')return {cls:'start',text:'正在启动'};
 if(a?.kind==='tool'&&a.open){const v=ACT_KID_VERB[a.verb]||'调用';return {cls:a.verb==='ask'?'ask':'tool',text:v,target:glanceLine(a.text)};}
 if(a?.kind==='note'||a?.kind==='agent')return {cls:'write',text:'在输出',tail:glanceLine(a.text)};
 if(a?.kind==='tool')return {cls:'think',text:'在思考',tail:a.text?(ACT_KID_VERB[a.verb]||'调用')+'完 '+glanceLine(a.text):''};
 return {cls:'think',text:'运行中'};}
function actKidRow(x){
 const st=actKidState(x),can=!!x.id;
 const b=btn('','act-kid s-'+st.cls,()=>{if(can)openRecord(x,true);});if(!can)b.disabled=true;
 b.append(el('span','kid-dot on'));
 const body=el('span','act-kid-body');const top=el('span','act-kid-top');top.append(el('span','act-kid-title',kidsTitle(x)));
 top.append(el('span','act-kid-state',st.text));
 const started=Date.parse(x.started||'')||0;if(started){const t=el('span','act-kid-time',dur(Date.now()-started));t.dataset.at=started;top.append(t);}
 // Second line: the command / file it works on (as code), or the last thing it wrote.
 body.append(top);if(st.target)body.append(el('code','act-kid-tail mono',st.target));else if(st.tail)body.append(el('span','act-kid-tail',st.tail));b.append(body);if(can)b.append(icon('chevron'));
 b.setAttribute('aria-label',kidsTitle(x)+'，'+st.text+(st.target?' '+st.target:'')+(can?'，打开只读记录':''));return b;}

// ─── Wiring ─────────────────────────────────────────────────────────────────
// timeline.js tlBuild: the line goes after the sent messages, before the queue.
function actRow(list){const info=actInfo();ACT.kind=info?.kind||'';if(!info){actSeen();return;}const was=!!ACT.node?.isConnected;actFill(info);list.append(actNode());
 // Rises in once when it appears; repaints and moves never replay it.
 if(!was)requestAnimationFrame(()=>{if(ACT.node?.isConnected)tlEnter(ACT.node,'act-enter');});requestAnimationFrame(actSeen);}
// Every second: the clock, and a repaint when the line should appear or go away.
function actTick(){
 if(!S.chat){if(ACT.node?.isConnected)ACT.node.remove();return;}
 const info=actInfo(),has=!!ACT.node?.isConnected;
 if(!!info!==has||(info&&!has)){if(document.getElementById('chat-scroll'))paintTimeline();}
 else if(info)actFill(info);
 ACT.kind=info?.kind||'';
 // Waiting for it to start: look at its screen too (the spinner shows before Herdr's state flips).
 if(info?.kind==='sent'&&S.chat?.agent&&!S.demo&&Date.now()-ACT.wantRead>2400){ACT.wantRead=Date.now();fetchTerminal(true);}
 // The rail's working line says the same thing in a few words.
 const l=document.getElementById('activity-line');if(l){const t=actRailText(info);if(l.textContent!==t)l.textContent=t;}}
function actRailText(info){
 if(!info)return ACT.readErr||'正在读取终端…';
 if(ACT.readErr&&!info.tool)return ACT.readErr;
 if(info.tool)return info.tool.verb+' '+info.tool.target;
 return info.kind==='sent'?'等它开始':info.kind==='stale'?'状态没更新':actWords()||info.label.replace(/^正在/,'')+'中';}
// Header and rail use the same clock as the line.
function actSince(a){const info=ACT.node?.isConnected?actInfo():null;return info?.at||statusSince(a)||S.chat?.sentAt||0;}
function actHeadText(){const i=actInfo();return i?.kind==='sent'?'已发出 · 等它开始':i?.kind==='unknown'?'状态未知':'';}
// Back from the background: polls restart now, so an old timestamp is not "no news" yet.
setInterval(()=>{const now=Date.now();if(!S.active){ACT.lastTick=0;return;}if(now-(ACT.lastTick||0)>3000)ACT.resumeAt=now;ACT.lastTick=now;if(S.chat)actTick();},1000);

// A running sub-agent's record is read every beat (its live tail), like a working agent.
{const baseDue=historyDue;historyDue=function(busy,n){return baseDue(busy||!!(S.chat&&!S.chat.agent&&S.chat.kidRunning),n);};}
