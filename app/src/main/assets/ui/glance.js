'use strict';
// One-line previews on the 会话 list: what each agent is doing now, what it is asking,
// or how its last reply began. The bridge `glance` op reads only the tail of each local
// transcript and answers "same" for files that did not change. Remote (ch) panes have
// no local transcript: they show only a waiting Codex question, which the remote sub-agent read
// (kids.js) reports. Agents in tmux panes (tmux.js) are local: their rows get the same line.
// Text nodes only.
const GL={map:new Map(),dev:'',busy:false,unsupported:false,at:0,restored:''};
const GLANCE_VERBS={run:'运行',edit:'修改',read:'查看',search:'搜索',web:'查资料',agent:'子 Agent',plan:'更新计划',wait:'等输出',ask:'提问',tool:'调用'};

function glanceDevice(){const d=cacheDevice()||(S.demo?'demo':'');if(d!==GL.dev){GL.dev=d;GL.map.clear();GL.at=0;GL.restored='';}return d;}
function glanceOf(a){glanceDevice();return GL.map.get(agentKey(a))||null;}
function glanceAt(a){const g=glanceOf(a);const d=toDate(g?.at)||(g?.modified?toDate(g.modified):null);return d?+d:0;}
// What to ask the bridge for: local matched transcripts only (record id + native thread).
// Every item also asks for the agent's sub-agents (kids.js; ch panes are asked separately there).
function glanceItem(a){
 if(S.demo)return kidsGlance(a,{key:agentKey(a)});
 const ref=a.history_ref,rec=ref?.record;if(!ref||ref.status!=='matched'||ref.remote||rec?.remote)return null;
 const record_id=ref.record_id||rec?.id,thread=ref.thread||rec?.thread;if(!record_id||!thread||!['claude','codex'].includes(a.agent))return null;
 const g=GL.map.get(agentKey(a));const item={key:agentKey(a),provider:a.agent,thread,record_id,cwd:rec?.cwd||a.foreground_cwd||a.cwd||''};
 if(g?.stamp)item.stamp=g.stamp;return kidsGlance(a,item);}
// all=false (status poll): only agents that are busy, changed state or have nothing yet.
async function glanceRefresh(all=false){
 const dev=glanceDevice();if(!S.demo&&dev&&S.device&&S.session)setTimeout(kidsRemoteRefresh,0);const list=liveAgents();if(GL.busy||GL.unsupported||!dev||!(S.device||S.demo)||!list.length)return;
 const items=list.filter(a=>{if(all)return true;const g=GL.map.get(agentKey(a));return !g||g.status!==(a.agent_status||'')||['working','blocked'].includes(a.agent_status)||kidsWanted(a);}).map(glanceItem).filter(Boolean).slice(0,40);
 if(!items.length)return;GL.busy=true;GL.at=Date.now();const session=S.session,status=new Map(list.map(a=>[agentKey(a),a.agent_status||'']));
 try{const r=await remote('glance',{items});if(session!==S.session||dev!==GL.dev)return;let changed=false;
  for(const [k,v] of Object.entries(r?.previews||{})){
   if(!v||typeof v!=='object')continue;kidsTake(k,v.kids);bgTake(k,v.bg);if(v.kids_only)continue;const old=GL.map.get(k);
   if(v.same){if(old)old.status=status.get(k)||'';continue;}
   // Nothing to show (yet): remember that too, so an idle agent is not asked every poll.
   if(v.missing){if(old&&!old.missing)changed=true;GL.map.set(k,{missing:true,status:status.get(k)||''});continue;}
   GL.map.set(k,{...v,status:status.get(k)||''});changed=true;}
  if(changed){glanceSave();if(!glanceRegroup())glancePaint();syncWatch();}}
 catch(e){if(/Unknown operation|不支持的操作/.test(e?.message||''))GL.unsupported=true;}
 finally{GL.busy=false;}}
// The list opened: show what we had, then refresh if it is not fresh.
function glanceKick(){glanceRestore();if(Date.now()-GL.at>4000)setTimeout(()=>glanceRefresh(!GL.map.size),0);}
function glanceSave(){if(S.demo)return;const keep=new Set(liveAgents().map(agentKey));cachePut('glance',{session:S.session,items:[...GL.map].filter(([k,g])=>keep.has(k)&&!g.missing).slice(0,60),at:Date.now()});}
async function glanceRestore(){
 const dev=glanceDevice();if(!dev||S.demo||GL.restored===dev)return;GL.restored=dev;
 const v=await cacheGet('glance',dev);if(!v?.items||dev!==GL.dev)return;let added=false;
 for(const [k,g] of v.items)if(!GL.map.has(k)&&g&&typeof g==='object'){GL.map.set(k,g);added=true;}
 if(added&&!glanceRegroup())glancePaint();}

// An idle Codex that asked with request_user_input_async (bridge: preview.ask) waits for you like a
// blocked agent does, unless that question was put aside with 「暂不回答」 (answer.js).
function glanceAsks(a){if(!['idle','done'].includes(a?.agent_status))return null;const ask=glanceOf(a)?.ask;return ask&&!qaAside('async:'+ask.call_id)?ask:null;}
// For the background watcher (syncWatch): Codex questions the app already knows, by the watcher's
// pane/identity key, and whether each was put aside. Known ones never notify; shown ones count as
// waiting. The open chat knows its question from history even before the list's glance does.
function glanceWatchAsks(){const out={},key=a=>a.pane_id+'/'+a.identity;
 liveAgents().forEach(a=>{const g=glanceAsksRaw(a);if(g)out[key(a)]={call_id:g.call_id,aside:qaAside('async:'+g.call_id)};});
 const c=S.chat?.agent;const q=c&&!S.chat.stale?qaAsyncPending():null;
 if(q?.p.call_id)out[key(c)]={call_id:q.p.call_id,aside:q.aside};
 return out;}
function glanceAsksRaw(a){if(!['idle','done'].includes(a?.agent_status))return null;const ask=glanceOf(a)?.ask;return ask?.call_id?ask:null;}
// ch panes: the remote sub-agent read also says whether a Codex question waits (kids.js).
function glanceTakeAsk(key,v,status){
 if(!v||!v.ask_stamp||v.ask_same)return false;const old=GL.map.get(key);const ask=v.ask&&typeof v.ask==='object'?v.ask:null;
 if(old&&(old.ask?.call_id||'')===(ask?.call_id||'')){old.ask_stamp=v.ask_stamp;return false;}
 GL.map.set(key,{...(old&&!old.missing?old:{}),ask,ask_stamp:v.ask_stamp,status});return true;}
// Who asks decides the list's groups: when that changes, the list is drawn again, not just patched.
function glanceAskSig(){return S.agents.filter(glanceAsks).map(agentKey).join('|');}
function glanceRegroup(){const sig=glanceAskSig();if(sig===GL.askSig)return false;GL.askSig=sig;
 if(S.tab==='live'&&!S.chat&&!(typeof T!=='undefined'&&T.view)&&!overlay.childElementCount){render();return true;}return false;}
// The bridge already sends one clean line; stay defensive about older or odd input.
function glanceLine(t){return (String(t||'').split('\n').map(x=>x.replace(/^\s*(#{1,6}\s+|>\s*)/,'').trim()).find(Boolean)||'').slice(0,200);}
// Each piece is its own span so the line can ellipsize without spilling out of the row:
// the lead ("运行 ", "问：") never shrinks, the rest truncates.
function gtext(box,text,cls){box.append(el('span','gt'+(cls?' '+cls:''),text));return box;}
// "运行 npm test" / "修改 cache.js" — verb plus a short target.
function glanceAction(act,box,lead=''){
 if(act.kind!=='tool')return gtext(box,lead+glanceLine(act.text));
 const verb=GLANCE_VERBS[act.verb]||'调用',target=glanceLine(act.text);
 if(!target)return gtext(box,lead+verb);
 gtext(box,lead+verb,'gt-lead gt-sp');return gtext(box,target,act.verb==='run'?'glance-code':'');}
// The preview for one agent, or null. Tone: ask (needs you), work (busy), done (finished).
function glancePreview(a){
 const g=glanceOf(a);if(!g)return null;const st=a.agent_status,act=g.activity,reply=g.reply;const n=el('span','glance');
 if(st==='blocked'){
  // The open tool call is what the prompt on the computer is about; else its latest note.
  n.classList.add('g-ask');const open=act?.kind==='tool'&&act.open;
  if(open&&act.verb==='ask'){gtext(n,'问：','gt-lead');return gtext(n,glanceLine(act.text)||'有个问题要你选');}
  if(open)return glanceAction(act,n,'想');
  if(act?.kind==='note')return gtext(n,glanceLine(act.text));
  return null;}
 if(st==='working'){
  if(!act)return null;n.classList.add('g-work');return glanceAction(act,n);}
 if(g.ask&&['idle','done'].includes(st)){n.classList.add(glanceAsks(a)?'g-ask':'g-done');gtext(n,'问：','gt-lead');
  return gtext(n,(glanceLine(g.ask.text)||'有个问题等你回答')+(g.ask.count>1?' 等 '+g.ask.count+' 个':''));}
 if(reply?.text&&(reply.current||!act)){n.classList.add('g-done');return gtext(n,glanceLine(reply.text));}
 if(act?.kind==='note'){n.classList.add('g-done');return gtext(n,glanceLine(act.text));}
 const t=g.turn||{};const bits=[];if(t.files)bits.push('改了 '+t.files+' 个文件');if(t.tools)bits.push('执行 '+t.tools+' 步');if(t.failed)bits.push(t.failed+' 步失败');
 if(!bits.length)return null;n.classList.add('g-done','g-sum');return gtext(n,bits.join(' · '));}
// Repaint previews and times in place: the list keeps its scroll and any open swipe.
function glancePaint(){
 if(S.chat||S.tab!=='live')return;
 const all=liveAgents();document.querySelectorAll('[data-glance]').forEach(line=>{const a=all.find(x=>agentKey(x)===line.dataset.glance);if(!a)return;
  const row=line.closest('.agent-row'),old=line.querySelector('.glance'),next=glancePreview(a);
  if(old)old.remove();if(next)line.append(next);if(row)row.classList.toggle('has-glance',!!next);
  const time=row?.querySelector('.row-time');if(time)time.textContent=rowTimeText(a);});}
function glanceForget(){GL.map.clear();GL.at=0;GL.restored='';}
