'use strict';
// Sub-agents ("kids"). Herdr only knows the parent pane: a Claude that launched background
// agents, or a Codex waiting on spawned ones, reads "idle" while its sub-agents still work. The
// bridge reports each live agent's sub-agents with a running flag (glance op on the list poll,
// history op while a chat is open; ch panes through the remote helper). Here that becomes:
//  · an effective state "kids" — 子 Agent 运行中 · N — grouped with 执行中, never 已完成/空闲;
//  · a chip under the row (子 Agent 3 · 1 运行中) that expands the sub-agents in place;
//  · the chat's 切换 Agent sheet listing them running-first, updating while it is open.
// Read-only: opening a sub-agent shows its transcript; nothing is ever sent to it.
// Text nodes only. Loaded before app.js; functions here call app.js helpers at run time.
const K={map:new Map(),rec:new Map(),open:new Set(),ask:new Map(),ttl:300000,pending:false,changed:new Set()};

function kidsKey(a){return a?agentKey(a):'';}
// A report older than the TTL (nothing polled it: offline, backgrounded) no longer counts as running.
function kidsOf(a){const r=a?K.map.get(kidsKey(a)):null;return r&&Date.now()-r.seen<K.ttl?r:null;}
function kidsRunning(a){const r=kidsOf(a);return r&&r.running>0?r.running:0;}
// Herdr's state, except an idle/done parent whose sub-agents still run is "kids".
function agentState(a){const s=a?.agent_status||'';return (s==='idle'||s==='done')&&kidsRunning(a)?'kids':s;}
function kidsLabel(a){return '子 Agent 运行中 · '+kidsRunning(a);}

// What the glance op should ask about this agent. Local agents ride on the preview item; a ch pane
// (transcript on the other computer, ~1 s a read) is asked at most every 10 s while something runs
// there and every 30 s otherwise.
function kidsGlance(a,item){
 if(!item)return item;item.kids=true;const r=K.map.get(kidsKey(a));if(r?.stamp)item.kids_stamp=r.stamp;return item;}
function kidsRemoteItem(a){
 const ref=a.history_ref,rec=ref?.record;if(S.demo||!ref||ref.status!=='matched')return null;
 const remote=rec?.remote||ref.remote,record_id=rec?.id||ref.record_id,thread=rec?.thread||ref.thread;
 if(!remote||!record_id||!thread||!['claude','codex'].includes(a.agent))return null;
 const k=kidsKey(a),busy=kidsRunning(a)||['working','blocked'].includes(a.agent_status),last=K.ask.get(k)||0;
 if(Date.now()-last<(busy?10000:30000))return null;K.ask.set(k,Date.now());
 const item=kidsGlance(a,{key:k,provider:a.agent,thread,record_id,remote});
 // A stopped Codex: also whether its async question waits (a stat there while nothing changed).
 if(a.agent==='codex'&&['idle','done'].includes(a.agent_status)){item.ask=true;const g=GL.map.get(k);if(g?.ask_stamp)item.ask_stamp=g.ask_stamp;}
 return item;}
// ch panes in their own request (a remote read takes ~1 s), so local previews never wait on it.
let kidsRemoteBusy=false;
async function kidsRemoteRefresh(){
 // An older bridge without `glance` is asked once (glance.js) and then left alone.
 if(kidsRemoteBusy||GL.unsupported||S.demo||!S.device||!S.session)return;const items=S.agents.map(kidsRemoteItem).filter(Boolean).slice(0,40);if(!items.length)return;
 kidsRemoteBusy=true;const session=S.session;
 try{const r=await remote('glance',{items});if(session!==S.session)return;let asked=false;const status=new Map(S.agents.map(a=>[agentKey(a),a.agent_status||'']));
  for(const [k,v] of Object.entries(r?.previews||{}))if(v&&typeof v==='object'){kidsTake(k,v.kids);if(glanceTakeAsk(k,v,status.get(k)||''))asked=true;}
  if(asked){glanceSave();if(!glanceRegroup())glancePaint();syncWatch();}}
 catch(e){if(/Unknown operation|不支持的操作|unsupported/i.test(e?.message||''))GL.unsupported=true;/* otherwise the next poll asks again */}
 finally{kidsRemoteBusy=false;}}
// The list poll asks again for agents whose sub-agents run even when the parent itself is idle.
function kidsWanted(a){return kidsRunning(a)>0;}
// What the background watcher (WatchService) asks before it says 做完了: the same glance item,
// without the preview stamp. Only for agents whose record is known.
function kidsWatchItem(a){
 const ref=a.history_ref,rec=ref?.record;if(!ref||ref.status!=='matched'||!['claude','codex'].includes(a.agent))return null;
 const record_id=rec?.id||ref.record_id,thread=rec?.thread||ref.thread,remote=rec?.remote||ref.remote;if(!record_id||!thread)return null;
 return remote?{provider:a.agent,thread,record_id,remote,kids:true}:{provider:a.agent,thread,record_id,cwd:rec?.cwd||a.foreground_cwd||a.cwd||'',kids:true};}

// A report arrived (glance or history). Returns nothing; repaints once per batch.
function kidsTake(key,report){
 if(!report||typeof report!=='object')return;const old=K.map.get(key);
 if(report.same){if(old)old.seen=Date.now();return;}
 if(!Array.isArray(report.items))return;
 const next={total:report.total|0,running:report.running|0,items:report.items.filter(x=>x&&typeof x==='object'),stamp:report.stamp||'',seen:Date.now()};
 K.map.set(key,next);
 if(!old||old.running!==next.running||old.total!==next.total||kidsSig(old)!==kidsSig(next))K.changed.add(key);
 if(!K.pending){K.pending=true;queueMicrotask(kidsApply);}}
function kidsSig(r){return r.items.map(x=>(x.id||x.title)+(x.running?'+':'-')).join(',');}
function kidsApply(){
 K.pending=false;if(!K.changed.size)return;const keys=new Set(K.changed);K.changed.clear();
 const touched=S.agents.filter(a=>keys.has(kidsKey(a)));
 // The effective state may have changed: same bookkeeping (and toasts) as a Herdr status change.
 const before=new Map(touched.map(a=>[kidsKey(a),S.since.get(kidsKey(a))?.status]));
 if(touched.length){noteStatus(touched);syncWatch();}
 const moved=touched.some(a=>before.get(kidsKey(a))!==agentState(a));
 if(S.chat){updateChatMeta();kidsPaintSheet();}
 else if(S.tab==='live'&&moved&&!overlay.childElementCount&&!(typeof T!=='undefined'&&T.view)){
  const m=document.querySelector('.main'),top=m?m.scrollTop:0;render();const n=document.querySelector('.main');if(n){n.classList.remove('pane-enter');n.scrollTop=top;}return;}
 if(typeof LAYOUT!=='undefined'&&LAYOUT.wide&&moved&&LAYOUT.refreshList)LAYOUT.refreshList(true);
 kidsPaintStrips();}
// History pages carry the open record's sub-agents (and, for a sub-agent, whether it runs).
function kidsFromHistory(record,r){
 if(!record||!r)return;const c=S.chat;if(!c||c.record?.id!==record.id&&c.record!==record)return;
 if(typeof r.kid?.running==='boolean')c.kidRunning=r.kid.running;
 if(r.kids){K.rec.set(record.id,{...r.kids,seen:Date.now()});if(c.agent&&!c.stale)kidsTake(kidsKey(c.agent),r.kids);}
 updateChatMeta();kidsPaintSheet();}
function kidsChat(){const c=S.chat;if(!c)return null;return (c.agent&&!c.stale?kidsOf(c.agent):null)||K.rec.get(c.record?.id)||null;}

// ─── Rows on the 会话 list ──────────────────────────────────────────────────
function kidsCount(r){const n=r.running;return '子 Agent '+r.total+(n?' · '+n+' 运行中':'');}
function kidsWhen(x){const t=Number(x.modified)||0;return x.state==='starting'?'正在启动':x.running?'运行中':t?relative(t)||'':'';}
// The strip under a row: a chip, and when opened the sub-agents themselves. Outside the row
// button (no nested buttons); the row keeps its swipe and long press.
function kidsStrip(a){
 const r=kidsOf(a);if(!r||!r.total)return null;const k=kidsKey(a);
 const box=el('div','kids-strip');box.dataset.kids=k;kidsFillStrip(box,a,r);return box;}
function kidsFillStrip(box,a,r){
 const k=kidsKey(a),open=K.open.has(k);box.replaceChildren();box.classList.toggle('open',open);box.classList.toggle('busy',r.running>0);
 const chip=btn('','kids-chip',()=>{if(K.open.has(k))K.open.delete(k);else K.open.add(k);kidsFillStrip(box,a,kidsOf(a)||r);},'branch');
 if(r.running)chip.append(el('span','kids-pulse'));chip.append(el('span','kids-chip-text',kidsCount(r)),icon('down'));
 chip.setAttribute('aria-expanded',String(open));chip.setAttribute('aria-label',kidsCount(r)+(open?'，收起':'，展开'));box.append(chip);
 if(!open)return;
 const list=el('div','kids-list');
 const items=kidsSorted(r.items);items.forEach(x=>list.append(kidsRow(x,false)));
 if(r.total>items.length)list.append(el('p','kids-more','还有 '+(r.total-items.length)+' 个更早的，在对话里点右上角查看'));
 box.append(list);}
function kidsSorted(items){return [...items].sort((x,y)=>(y.running?1:0)-(x.running?1:0)||(Number(y.modified)||0)-(Number(x.modified)||0));}
function kidsTitle(x){return String(x.title||x.role||'子 Agent');}
function kidsRow(x,inSheet){
 const can=!!x.id;const b=btn('',(inSheet?'menu-item ':'')+'kid-row'+(x.running?' running':''),()=>{if(!can)return;if(inSheet)closeSheet();openRecord(x,true);});
 if(!can)b.disabled=true;
 b.append(el('span','kid-dot'+(x.running?' on':'')));
 const t=el('span','grow kid-text');t.append(el('span','kid-title',kidsTitle(x)));
 // Claude's default type says nothing; a Codex task name or a custom agent type does.
 const role=x.role&&x.role!==kidsTitle(x)&&!['subagent','general-purpose'].includes(x.role)?x.role:'';
 t.append(el('small','kid-sub',[role,kidsWhen(x)].filter(Boolean).join(' · ')));b.append(t);
 if(can)b.append(icon('chevron'));
 b.setAttribute('aria-label',kidsTitle(x)+'，'+(x.running?'运行中':'已结束')+(can?'，打开只读记录':''));
 return b;}
// Repaint strips in place (counts, running dots) without rebuilding the list.
function kidsPaintStrips(){
 if(S.tab!=='live')return;
 document.querySelectorAll('.kids-strip[data-kids]').forEach(box=>{const a=S.agents.find(x=>kidsKey(x)===box.dataset.kids);const r=a&&kidsOf(a);
  if(!r||!r.total){box.remove();return;}kidsFillStrip(box,a,r);});
 // A row that just got sub-agents gets its strip.
 document.querySelectorAll('[data-glance]').forEach(line=>{const k=line.dataset.glance;const wrap=line.closest('.swipe')||line.closest('.agent-row');
  if(!wrap||wrap.nextElementSibling?.dataset?.kids===k)return;const a=S.agents.find(x=>kidsKey(x)===k);const s=a&&kidsStrip(a);if(s)wrap.after(s);});}

// ─── The chat: 切换 Agent sheet and header ───────────────────────────────────
// This conversation's sub-agents: the bridge's report (running flags) merged with the history
// page's child list (all of them, oldest included). Running first, then newest.
function kidsChatItems(){
 const rep=kidsChat(),seen=new Set(),out=[];
 for(const x of rep?.items||[]){out.push(x);if(x.id)seen.add(x.id);}
 for(const r of S.children||[])if(!seen.has(r.id))out.push({...r,running:false});
 return kidsSorted(out);}
function kidsSection(box){const wrap=el('div','kids-sheet');wrap.id='kids-sheet';box.append(wrap);kidsFillSheet(wrap);}
function kidsFillSheet(wrap){
 const items=kidsChatItems(),rep=kidsChat(),total=Math.max(items.length,rep?.total||0),running=items.filter(x=>x.running).length;
 const head=el('div','section-label kids-sheet-head');head.append(el('span','','这段对话的子 Agent'+(total?' · '+total:'')));
 if(running){const b=el('span','badge work',running+' 个运行中');head.append(b);}
 wrap.replaceChildren(head);
 if(!items.length){wrap.append(el('p','fine','这段对话里还没有子 Agent。'));return;}
 const list=el('div','kids-sheet-list');wrap.append(list);
 // Long runs show the running ones plus the newest few; the rest are one tap away.
 const shortList=items.length>6?items.filter((x,i)=>x.running||i<5):items;
 list.replaceChildren(...shortList.map(x=>kidsRow(x,true)));
 if(shortList.length<items.length){const all=btn('显示全部 '+items.length+' 个','link-btn',()=>{all.remove();wrap.dataset.all='1';list.replaceChildren(...items.map(x=>kidsRow(x,true)));});wrap.append(all);}
 if(wrap.dataset.all)list.replaceChildren(...items.map(x=>kidsRow(x,true)));}
function kidsPaintSheet(){const w=document.getElementById('kids-sheet');if(w)kidsFillSheet(w);}
// The header's 切换 Agent button: how many sub-agents, amber while any runs.
function kidsPaintHead(){
 const b=document.getElementById('child-count');if(!b||!S.chat)return;const rep=kidsChat(),items=kidsChatItems();
 const total=Math.max(items.length,rep?.total||0),running=items.filter(x=>x.running).length;
 b.textContent=String(running||total);b.classList.toggle('hidden',!total);b.classList.toggle('kids-on',running>0);
 const sw=b.closest('button');if(sw){const label='切换 Agent';sw.title=running?label+' · '+running+' 个子 Agent 运行中':label;}
 const c=S.chat;if(!c.agent&&c.record?.parent){const d=document.getElementById('chat-dot');if(d)d.className='status-dot '+(c.kidRunning?'work':'muted');}}
function kidsForget(){K.map.clear();K.rec.clear();K.ask.clear();}
