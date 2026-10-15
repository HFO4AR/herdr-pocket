'use strict';
// Following a pane. The conversation inside a Herdr pane can change under an open chat:
// Claude /clear or /resume, Codex /new or /resume, or the agent exits and the pane is a
// plain shell again (maybe running a new agent later). While a live chat is open this
// re-resolves just that pane (bridge `agents` with a `target`) and follows what is really
// running there, with a visible marker. It only reads; it never sends anything.
// Safety: while a change is being confirmed, and right after a switch, sending is held,
// so a message never goes to a conversation the person has not seen on screen.
const FOLLOW={timer:0,busy:false,last:0,supported:true};
const FOLLOW_SETTLE=2500;

function followRemote(c){return !!(c.agent?.history_ref?.remote||c.record?.remote);}
// Local resolution is cheap (one process walk); a remote ch route costs an SSH round trip.
function followInterval(c){return c.exited?12000:followRemote(c)?20000:10000;}
// refreshStatus hands over this pane's newest status row (undefined once it left the agent list).
function followHint(cur){
 const c=S.chat;if(!c?.agent||!FOLLOW.supported)return;
 // After an exit only a newly started agent is news; the slow poll covers the rest.
 if(c.exited){if(cur&&cur.identity!==c.newAgent?.identity)followNow(0);return;}
 if(!cur||cur.identity!==c.agent.identity){
  // Stop sending at once; followRun decides whether this is a new conversation or an exit.
  if(!c.stale&&!c.exited){c.stale=true;c.following=true;renderComposer();updateChatMeta();}
  followNow(300);return;}
 // A new name usually means a new conversation (cleaned: spinner glyphs change constantly while working).
 if(titleOf(cur)!==titleOf(c.agent))followNow(1500);}
function followNow(delay=0){clearTimeout(FOLLOW.timer);FOLLOW.timer=setTimeout(()=>{if(FOLLOW.busy||Date.now()-FOLLOW.last<3000)followNow(3000);else followRun();},delay);}
async function followRun(){
 const c=S.chat;if(!c?.agent||FOLLOW.busy||!FOLLOW.supported||S.demo||!S.device||!S.session||c.exited?.gone)return;
 FOLLOW.busy=true;FOLLOW.last=Date.now();
 try{const r=await remote('agents',{session:S.session,target:c.agent.pane_id,identity:c.agent.identity});
  if(S.chat!==c)return;
  // An older bridge ignores `target` and resolves every pane: far too heavy to poll.
  if(!r||!r.follow){FOLLOW.supported=false;if(c.following){c.following=false;renderChat();}return;}
  followApply(c,r);}
 catch(_){/* transient: the next tick retries; sending stays held while confirming */}
 finally{FOLLOW.busy=false;}}

function followApply(c,r){
 const a=r.agents?.[0]||null;
 if(r.state==='starting'){followNow(3000);return;}
 if(!a){followExited(c,r);return;}
 followListRow(a);
 // Same agent process, other conversation: the same terminal and provider, nothing exited in between.
 // Once it has exited, anything new in the pane is offered, never switched to silently.
 const sameRun=!c.exited&&(a.identity===c.agent.identity||(a.agent===c.agent.agent&&a.terminal_id===c.agent.terminal_id));
 if(!sameRun){
  if(!c.exited){c.exited={at:Date.now(),replaced:true,pane:null};c.stale=true;c.following=false;}
  if(c.newAgent?.identity!==a.identity){c.newAgent=a;renderChat();}
  return;}
 const ref=a.history_ref||{},cur=c.record;
 // Argv ("process") is the startup state and cannot see /clear; never follow it.
 const strong=ref.status==='matched'&&ref.record&&ref.source!=='process';
 let target=null;
 if(strong&&ref.record.id!==cur?.id)target={key:ref.record.id,record:ref.record,thread:ref.record.thread};
 else if(ref.status==='pending'&&ref.thread&&ref.thread!==cur?.thread&&(cur||a.identity!==c.agent.identity))target={key:'pending:'+ref.thread,record:null,thread:ref.thread};
 if(target){
  // No transcript yet (history was still being written): just fill it in.
  if(!cur&&target.record&&(!c.switched||c.switched.thread===target.thread)&&a.identity===c.agent.identity){followAdopt(c,a,target.record);return;}
  // Ask twice before switching so a flapping signal never bounces the view.
  if(c.followPending===target.key){followSwitch(c,a,target);return;}
  c.followPending=target.key;c.following=true;
  // A new identity means mutations would be refused anyway; show it as held right away.
  if(a.identity!==c.agent.identity&&!c.stale){c.stale=true;renderComposer();updateChatMeta();}
  followNow(3500);return;}
 c.followPending='';
 if(a.identity!==c.agent.identity){
  if(strong&&ref.record.id===cur?.id){followAdopt(c,a,cur);return;}
  // The pane's session changed but nothing says which conversation it is now.
  c.following=false;c.stale=true;c.unsure=a;renderComposer();updateChatMeta();return;}
 // Nothing changed after all (a status blip): release the hold, refresh names.
 const held=c.following||c.stale||c.unsure;c.following=false;c.stale=false;c.unsure=null;
 c.agent={...c.agent,title:a.title,terminal_title:a.terminal_title,terminal_title_stripped:a.terminal_title_stripped,history_ref:a.history_ref};
 if(held){renderComposer();updateChatMeta();}}

// The same conversation under a fresh identity (or a transcript that just appeared).
function followAdopt(c,a,record){
 const from=draftKey();c.agent={...a,agent_status:c.agent.agent_status};c.stale=false;c.following=false;c.unsure=null;c.followPending='';
 followMoveDraft(from);
 if(!c.record&&record){c.record=record;c.historyIssue='';S.epoch++;renderChat();fetchHistory(false,true);}else{renderChat();}
 syncWatch();}
function followSwitch(c,a,target){
 const from=draftKey();
 // Pending → switched again keeps the original "before" conversation.
 const prev=c.record?{record:c.record,title:c.record.title||c.title}:c.switched?.prev||null;
 c.agent={...a};c.record=target.record;c.manual=false;c.stale=false;c.following=false;c.unsure=null;c.followPending='';
 c.exited=null;c.newAgent=null;c.historyError=null;c.historyLoading=false;c.sentAt=0;c.doneAt=0;
 c.historyIssue=target.record?'':historyIssueText(a.history_ref);c.title=titleOf(a);
 c.switched={at:Date.now(),prev,provider:a.agent,thread:target.thread,fresh:null};
 followMoveDraft(from);
 S.messages=[];S.children=[];S.before=0;S.more=false;S.historyNote='';S.terminalText='';S.activity='';S.stick=true;S.unseen=0;
 S.epoch++;syncWatch();renderChat();if(target.record)fetchHistory(false,true);
 toast('这个窗格换了一段对话，已跟上');}
function followMoveDraft(from){const to=draftKey();if(from===to||!S.drafts.has(from))return;if(!S.drafts.get(to))S.drafts.set(to,S.drafts.get(from));S.drafts.delete(from);}
function followExited(c,r){
 const gone=r.state==='gone';
 if(!c.exited||c.exited.replaced){c.exited={at:c.exited?.at||Date.now(),gone,pane:r.pane||null};c.stale=true;c.following=false;c.followPending='';c.unsure=null;
  renderChat();return;}
 const had=!!c.newAgent;c.newAgent=null;if(r.pane)c.exited.pane=r.pane;if(gone)c.exited.gone=true;if(had||gone)renderComposer();}
// Keep the session list in step with what the pane runs now.
function followListRow(a){const i=S.agents.findIndex(x=>x.pane_id===a.pane_id);if(i>=0)S.agents[i]={...S.agents[i],...a};}
// Hold sending while a change is unconfirmed, and briefly right after a switch.
function followHoldsSend(){
 const c=S.chat;if(!c?.agent)return false;
 if(c.following){toast('窗格里的对话好像变了，正在确认，草稿先留着');return true;}
 if(c.switched&&Date.now()-c.switched.at<FOLLOW_SETTLE){toast('刚换了一段对话，看一眼再发');return true;}
 return false;}

// ─── Views ──────────────────────────────────────────────────────────────────
// "新会话 · /clear 之后" divider at the top of the followed conversation.
function followKind(c){
 const w=c.switched;if(w.fresh===null&&S.messages.length&&c.record){
  const first=toDate(S.messages[0].timestamp),before=Number(w.prev?.record?.modified||0)*1000;
  w.fresh=!S.more&&(!first||!before||first.getTime()>=before-5000);}
 const fresh=w.fresh!==false,claude=w.provider==='claude';
 return fresh?['新会话',claude?'/clear 之后':'/new 之后']:['换到另一段对话','/resume 之后'];}
function followMarker(list){
 const c=S.chat,w=c?.switched;if(!w||!c.agent||S.chatMode==='terminal')return;
 const [label,hint]=followKind(c);
 const box=el('section','follow-mark');box.setAttribute('aria-label',label);
 const line=el('div','follow-line');line.append(el('span','follow-label',label+' · '+hint),el('span','follow-time',clock(w.at/1000)));box.append(line);
 if(w.prev){const back=btn('','follow-prev',()=>openRecord(w.prev.record,true),'history');const t=el('span','grow');t.append(el('span','follow-prev-label','之前的对话'),el('span','follow-prev-title',w.prev.title||'对话'));back.append(t,icon('chevron'));back.setAttribute('aria-label','看之前的对话：'+(w.prev.title||''));box.append(back);}
 list.append(box);}
// Replaces the read-only footer while following, after an exit, or when unsure.
function followFooter(footer){
 const c=S.chat;if(!c?.agent)return false;
 const card=el('section','follow-card');card.setAttribute('role','status');
 const head=el('div','follow-head');
 if(c.exited){
  const who=providerName(c.agent.agent);
  head.append(icon(c.exited.gone?'x':'terminal'));const t=el('strong','grow',c.exited.gone?'窗格已关闭':who+' 已退出');t.append(' ',since(c.exited.at,'ago'));head.append(t);card.append(head);
  card.append(el('p','follow-text',c.newAgent?'这个窗格里又开了一个 '+providerName(c.newAgent.agent)+'。上面是之前的对话，只读。':c.exited.gone?'上面是之前的对话，只读。':'窗格现在是普通终端。上面是之前的对话，只读。'));
  const row=el('div','follow-actions');
  if(c.newAgent){const a=c.newAgent;row.append(btn('打开新的 '+providerName(a.agent),'primary small',()=>openAgent(a),'chat'));}
  if(c.exited.pane&&!c.newAgent)row.append(btn('打开这个终端','secondary small',()=>followOpenPane(c.exited.pane),'terminal'));
  if(row.childElementCount)card.append(row);}
 else if(c.following){head.append(el('span','spinner mini'));head.append(el('strong','grow','窗格里的对话变了，正在确认…'));card.append(head,el('p','follow-text','确认之前不会发送，草稿会留着。'));}
 else if(c.unsure){const a=c.unsure;head.append(icon('alert'));head.append(el('strong','grow','窗格换了会话，还没认出是哪一段'));card.append(head);const row=el('div','follow-actions');row.append(btn('重新打开','primary small',()=>openAgent(a),'refresh'));card.append(row);}
 else return false;
 footer.replaceChildren(card);return true;}
function followOpenPane(pane){if(typeof openPane!=='function')return;S.chatStack=[];openPane({...pane,workspace_label:pane.workspace_label||''});}
function followSubtitle(c){return c.exited?(c.exited.gone?'窗格已关闭 · 只读':providerName(c.agent?.agent)+' 已退出 · 只读'):c.following?'正在确认窗格里的对话…':c.unsure?'窗格换了会话 · 只读':'窗格已变化 · 只读';}

setInterval(()=>{
 const c=S.chat;if(!S.active||S.demo||!S.device||!c?.agent||!FOLLOW.supported||c.exited?.gone)return;
 if(typeof T!=='undefined'&&T.view)return;
 if(!c.followAt){c.followAt=Date.now();return;}
 if(Date.now()-Math.max(c.followAt,FOLLOW.last)>=followInterval(c)){c.followAt=Date.now();followRun();}
},2500);
