'use strict';
// 继续这个对话: pick an old Claude / Codex / ch conversation up again. The phone names the
// conversation (its id, and for ch the host); the bridge checks it and chooses the command line
// itself (`create` with `resume`: a new Herdr tab in the conversation's directory, the agent started
// with `claude --resume <id>` / `codex resume <id>` / typed `ch --host <h> resume <id>`; on a
// computer without Herdr `tmuxNew` with `resume`: a new tmux session). The usual create flow
// follows: fast answer, 「正在启动」 row, its own receipt, never started twice from here.
//
// 「最近断开的」 on 会话: the conversations this phone saw running on this computer (kept per
// computer in the encrypted cache, LocalCache) that are gone now while their pane is gone too, as
// after Herdr was killed and started again. An agent that quit in a pane that is still there is
// not listed (it was ended on purpose). 「全部继续」 resumes them one after another after a
// confirmation that lists them. Nothing is resumed without a tap.
const PK={shown:'',store:null,storeFor:'',loading:null,busy:new Set(),bulk:false,checking:false,checkedAt:0,tmux:[]};
const PK_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PK_HOST=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const PK_TITLE_CH=/\bch --host ([A-Za-z0-9][A-Za-z0-9_.-]{0,62}) resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/;
const PK_SHOW=3*864e5,PK_KEEP=7*864e5,PK_MAX=40;
const PK_KINDS={claude:'Claude',codex:'Codex',ch:'Claude · ch'};

// ─── Which conversation ─────────────────────────────────────────────────────
// conv: {key, kind, id, host?, cwd, title, record?}. Only Claude / Codex root conversations and
// ch sessions qualify; ids are lowercase uuids (the bridge checks the same, strictly).
function pkConv(kind,id,extra={}){if(!PK_KINDS[kind]||typeof id!=='string'||!PK_ID.test(id))return null;if(kind==='ch'&&!PK_HOST.test(extra.host||''))return null;
 return {key:kind+':'+id,kind,id,...(kind==='ch'?{host:extra.host}:{}),cwd:typeof extra.cwd==='string'?extra.cwd:'',title:cleanTitle(extra.title||'').slice(0,80),record:extra.record||null};}
function pkSlimRecord(r){return r&&typeof r.id==='string'?{id:r.id,provider:r.provider,thread:r.thread,title:r.title,cwd:r.cwd,modified:r.modified,...(r.remote?{remote:r.remote}:{}),...(r.parent?{parent:r.parent}:{})}:null;}
// A live agent's conversation: ch (bridge `ch_resume`, else the terminal title ch sets), else the
// matched transcript, else Herdr's own session id.
function pkFromAgent(a){
 if(!a?.agent)return null;const rec=a.history_ref?.record,cwd=a.foreground_cwd||a.cwd||'';
 const ch=a.ch_resume&&typeof a.ch_resume==='object'?a.ch_resume:(()=>{const m=PK_TITLE_CH.exec(String(a.terminal_title||a.terminal_title_stripped||''));return m?{host:m[1],session:m[2]}:null;})();
 // ch titles its pane "<dir>: ch --host <h> resume <id>": name it by its project and short id instead.
 if(ch&&a.agent==='claude'){let title=titleOf(a);if(PK_TITLE_CH.test(title)||/^[^:]{1,60}:\s*ch\b/.test(title))title=(rec?.title&&!rec.parent?cleanTitle(rec.title):'')||(projectOf(a)||'ch')+' · ch '+ch.session.slice(0,8);
  return pkConv('ch',ch.session,{host:ch.host,cwd,title,record:pkSlimRecord(rec)});}
 if(!hasTranscript(a.agent))return null;const ref=a.history_ref;
 const id=ref?.status==='matched'&&!ref.remote?ref.thread:a.agent_session?.kind==='id'&&!ref?.remote?a.agent_session.value:'';
 if(rec?.parent)return null;
 return pkConv(a.agent,id,{cwd:rec?.cwd||cwd,title:titleOf(a),record:pkSlimRecord(rec)});}
// A history record: local Claude / Codex root records; a remote (ch) record only through the ch
// session this phone saw it in.
function pkFromRecord(r){
 if(!r||r.parent)return null;
 if(r.remote){const e=pkEntries().find(x=>x.kind==='ch'&&x.record?.id===r.id);return e?pkConv('ch',e.id,{host:e.host,cwd:e.cwd,title:r.title||e.title,record:pkSlimRecord(r)}):null;}
 return pkConv(r.provider,r.thread,{cwd:r.cwd,title:r.title,record:pkSlimRecord(r)});}
// Live keys right now (Herdr and tmux agents), and the agent showing this conversation.
function pkLiveMap(){const m=new Map();for(const a of liveAgents()){const c=pkFromAgent(a);if(c&&!m.has(c.key))m.set(c.key,a);const rid=a.history_ref?.record_id||a.history_ref?.record?.id;if(rid&&!m.has('r:'+rid))m.set('r:'+rid,a);}return m;}
function pkLiveFor(conv,map=pkLiveMap()){return conv?map.get(conv.key)||(conv.record?.id&&map.get('r:'+conv.record.id))||null:null;}

// ─── Where it goes ──────────────────────────────────────────────────────────
// Herdr when a session runs; without Herdr installed, tmux; otherwise nothing can take it.
function pkTarget(){if(S.demo)return 'herdr';if(!S.device)return '';if(S.session&&!noHerdr())return 'herdr';if(noHerdr()&&typeof tmuxCan==='function'&&tmuxCan())return 'tmux';return '';}
function pkNoTarget(){return !S.device?'先连接电脑':noHerdr()?'这台电脑上没有 Herdr，也没找到 tmux，没地方开':'Herdr 现在没在运行，等它起来再继续';}

// ─── What this phone saw running (per computer, encrypted cache) ────────────
function pkDev(){return S.demo?'':S.device?.id||'';}
async function pkLoad(){const dev=pkDev();if(!dev)return null;if(PK.storeFor===dev&&PK.store)return PK.store;
 if(PK.loading?.dev===dev)return PK.loading.p;
 const p=(async()=>{const v=await cacheGet('pickup:seen',dev).catch(()=>null);if(pkDev()!==dev)return null;
  if(PK.storeFor!==dev||!PK.store){PK.store={items:Array.isArray(v?.items)?v.items.filter(x=>x&&PK_KINDS[x.kind]&&PK_ID.test(x.id||'')).slice(0,PK_MAX):[]};PK.storeFor=dev;}
  return PK.store;})();
 PK.loading={dev,p};try{return await p;}finally{if(PK.loading?.p===p)PK.loading=null;}}
function pkEntries(){return PK.storeFor===pkDev()&&PK.store?PK.store.items:[];}
function pkSave(){const dev=pkDev();if(!dev||PK.storeFor!==dev||!PK.store)return;const now=Date.now();
 PK.store.items=PK.store.items.filter(x=>now-(x.last||0)<PK_KEEP).sort((a,b)=>(b.last||0)-(a.last||0)).slice(0,PK_MAX);
 cachePut('pickup:seen',{items:PK.store.items,at:now},dev);}
// Called whenever the live list is stored (cacheLive) or tmux is read: remember what runs.
async function pkNote(){
 const dev=pkDev();if(!dev)return;const store=await pkLoad();if(!store||pkDev()!==dev)return;
 const now=Date.now();let changed=false;
 for(const a of liveAgents()){const c=pkFromAgent(a);if(!c)continue;
  let e=store.items.find(x=>x.key===c.key);
  if(!e){e={key:c.key,kind:c.kind,id:c.id,first:now};store.items.push(e);}
  const where=a.tmux?'tmux':'herdr',pane=a.tmux?a.tmux_pane?.pane_id||a.pane_id:a.pane_id,term=a.tmux?a.tmux_pane?.identity||'':a.terminal_id||'';
  const next={host:c.host,cwd:c.cwd||e.cwd||'',title:c.title||e.title||'',record:c.record||e.record||null,where,session:a.tmux?'':S.session,pane,term};
  if(Object.keys(next).some(k=>JSON.stringify(e[k])!==JSON.stringify(next[k])))changed=true;
  Object.assign(e,next,{last:now});
  for(const k of ['gone','dismissed','closed','resumed','exited'])if(k in e){delete e[k];changed=true;}}
 // Written when something changed, else at most every 5 minutes (the list polls every few seconds).
 if(changed||now-(PK.savedAt||0)>300000){PK.savedAt=now;pkSave();}
 pkCheck();}
// The app closed or exited it on purpose (close.js): not "disconnected".
function pkClosed(a){const c=pkFromAgent(a),e=c&&pkEntries().find(x=>x.key===c.key);if(e){e.closed=Date.now();pkSave();}}

// ─── 最近断开的 ─────────────────────────────────────────────────────────────
// Seen here before, not running now, its pane gone (checked once, below), not dismissed / closed /
// already picked up, and seen within the last 3 days.
function pkHerdrFresh(){return !S.demo&&!!S.device&&!!S.session&&!!S.liveAt&&!S.fromCache&&!S.liveError;}
function pkTmuxFresh(){const st=typeof tmuxState==='function'?tmuxState():null;return !!st?.loaded&&!st.failed;}
function pkCandidates(){
 const now=Date.now(),live=pkLiveMap(),herdr=pkHerdrFresh(),tmux=pkTmuxFresh();
 return pkEntries().filter(e=>!e.closed&&!e.dismissed&&!e.resumed&&!e.exited&&now-(e.last||0)<PK_SHOW&&!pkLiveFor(e,live)&&
  (e.where==='tmux'?tmux:herdr&&e.session===S.session));}
function pkGone(){return pkCandidates().filter(e=>e.gone).sort((a,b)=>(b.last||0)-(a.last||0));}
// Not running any more: is its pane still there? A pane still holding the same terminal (a shell
// now, or another agent) means the agent was quit there: not listed. Herdr `panes` is read once
// for the new candidates; tmux panes are in the tmux list already.
async function pkCheck(){
 if(PK.checking||S.demo)return;const todo=pkCandidates().filter(e=>!e.gone);if(!todo.length)return;
 const dev=pkDev(),session=S.session;PK.checking=true;let changed=false;
 try{
  const tmuxAll=typeof tmuxPanes==='function'?tmuxPanes():[];
  for(const e of todo.filter(x=>x.where==='tmux')){const p=tmuxAll.find(x=>x.pane_id===e.pane&&x.identity===e.term);if(p)e.exited=Date.now();else e.gone=Date.now();changed=true;}
  const herdr=todo.filter(x=>x.where==='herdr');
  if(herdr.length&&session){
   const r=await remote('panes',{session});if(pkDev()!==dev||S.session!==session)return;
   const alive=new Set((r?.panes||[]).map(p=>p.pane_id+'/'+(p.terminal_id||'')).concat(S.agents.map(a=>a.pane_id+'/'+(a.terminal_id||''))));
   for(const e of herdr){if(alive.has(e.pane+'/'+(e.term||'')))e.exited=Date.now();else e.gone=Date.now();changed=true;}}}
 catch(_){/* unknown: asked again after the next list */}
 finally{PK.checking=false;if(changed&&pkDev()===dev){pkSave();pkRepaint();}}}
// Repaint 会话 only when what 最近断开的 shows changed, and not under an open swipe row.
function pkRepaint(force){const sig=pkTarget()?pkGone().filter(e=>!pkPendingKey(e.key)).map(e=>e.key).join(','):'';
 if(!force&&sig===PK.shown)return;if(typeof SWIPE!=='undefined'&&SWIPE.open)return;PK.shown=sig;if(typeof newPendingPaint==='function')newPendingPaint();}
function pkPendingKey(key){return typeof NEW!=='undefined'&&NEW.pending.some(p=>p.resume===key&&p.device===pkDev())||PK.tmux.some(t=>t.key===key&&t.device===pkDev());}
// For other screens (the Herdr guardian's "restarted" card): how many could be picked up.
function pickupCount(){return pkGone().filter(e=>!pkPendingKey(e.key)).length;}

function pkAgo(at){const a=ago(Date.now()-at);return a==='刚刚'?'刚刚':a+'前';}
function pkLabel(e){return PK_KINDS[e.kind]||providerName(e.kind);}
function pkTitle(e){return e.title||(e.record?.title?cleanTitle(e.record.title).slice(0,80):'')||pkLabel(e)+(e.cwd?' · '+e.cwd.split('/').filter(Boolean).pop():'');}
function pkSection(main){
 const list=pkGone().filter(e=>!pkPendingKey(e.key));PK.shown=pkTarget()?list.map(e=>e.key).join(','):'';if(!list.length||!pkTarget())return 0;
 const h=el('div','section-label group-label pk-label');h.append(el('span','','最近断开的'),el('span','group-count',String(list.length)));
 if(list.length>1){const all=btn('全部继续','link-btn pk-all',()=>pickupAll(),'refresh');all.setAttribute('aria-label','全部继续 · '+list.length+' 个对话');h.append(all);}
 const card=el('div','card list-card pk-list');list.forEach(e=>card.append(pkRow(e)));
 const note=el('p','fine pk-note','这些对话之前在这台电脑上开着，现在窗格没了（比如 Herdr 重启过）。点一下就能接着聊。');
 const anchor=main.querySelector(':scope>.agent-list,:scope>.tmux-label,:scope>.tmux-list,:scope>.empty,:scope>.loading-card');
 for(const n of [h,card,note])anchor?main.insertBefore(n,anchor):main.append(n);
 return list.length;}
function pkRow(e){
 const b=btn('','card-button agent-row pk-row',()=>pickupSheet(pkConv(e.kind,e.id,{host:e.host,cwd:e.cwd,title:pkTitle(e),record:e.record})));
 const title=pkTitle(e),project=(e.cwd||'').split('/').filter(Boolean).pop()||pkLabel(e);
 b.setAttribute('aria-label','继续「'+title+'」 · '+project+' · '+pkAgo(e.last)+'断开');
 const t=el('div','grow');t.append(el('div','card-title',title));
 const meta=el('div','card-meta');meta.append(el('span','project',project));if(e.kind==='ch')meta.append(el('span','tag remote-tag','远端'));if(e.where==='tmux')meta.append(el('span','tag tmux-tag','tmux'));
 meta.append(el('span','sep',pkAgo(e.last)+'还开着'));t.append(meta);
 const side=el('div','row-side');const go=el('span','pk-go');go.append(icon('refresh'),document.createTextNode('继续'));side.append(go);
 b.append(avatar(e.kind==='ch'?'claude':e.kind,'muted'),t,side);
 const drop=()=>{e.dismissed=Date.now();pkSave();pkRepaint();toast('不放在「最近断开的」里了');};
 closeHold(b,()=>pkRowActions(e,drop));
 return closeSwipe(b,[['不用了','x','',drop],['更多','more','',()=>pkRowActions(e,drop)]]);}
function pkRowActions(e,drop){
 const conv=pkConv(e.kind,e.id,{host:e.host,cwd:e.cwd,title:pkTitle(e),record:e.record});const box=sheet(pkTitle(e));
 box.append(el('p','fine close-sub',[pkLabel(e),e.cwd?shortPath(e.cwd):'',pkAgo(e.last)+'还开着'].filter(Boolean).join(' · ')));
 menuItem(box,'继续这个对话',()=>pickupSheet(conv),'refresh');
 if(e.record&&!e.record.remote)menuItem(box,'只读查看历史',()=>openRecord(e.record),'history','不开 Agent，只看记录');
 menuItem(box,'不用了',drop,'x','从「最近断开的」里拿掉，记录不删');}

// ─── The sheet ──────────────────────────────────────────────────────────────
function pkWhereText(conv){const t=pkTarget();return t==='tmux'?'新的 tmux 会话（后台，不抢电脑屏幕）':'同目录的工作区里新开标签页，没有就新开工作区（电脑上的画面不会被切走）';}
function pkFacts(box,conv){
 const list=el('div','new-facts');const row=(k,v,cls)=>{const n=el('div','new-fact');n.append(el('span','new-fact-key',k),el('span','new-fact-value'+(cls?' '+cls:''),v));list.append(n);};
 row('对话',conv.title||pkLabel(conv));row('Agent',pkLabel(conv)+(conv.kind==='ch'?' · 主机 '+conv.host:''));
 row('目录',conv.cwd?shortPath(conv.cwd):'家目录','mono');row('开在',pkWhereText(conv));
 row('命令',conv.kind==='claude'?'claude --resume '+conv.id.slice(0,8)+'…':conv.kind==='codex'?'codex resume '+conv.id.slice(0,8)+'…':'ch --host '+conv.host+' resume '+conv.id.slice(0,8)+'…','mono');
 box.append(list);}
// Already open somewhere: offer that one instead of a second copy.
function pkOpenSheet(conv,a){
 const box=sheet('这段对话已经开着');box.classList.add('pk-sheet');
 box.append(el('p','muted','「'+(conv.title||titleOf(a))+'」正在'+(a.tmux?' tmux ':' Herdr ')+'里运行（'+stateLabel(a)+'）。直接打开它就行，不用再开一个。'));
 const row=el('div','sheet-actions');row.append(btn('取消','secondary',closeSheet),btn('打开','primary',()=>{closeSheet();pickupOpen(a);},'chat'));box.append(row);}
function pickupOpen(a){if(typeof leaveTerminal==='function')leaveTerminal();if(S.tab!=='live'){S.tab='live';S.epoch++;}openAgent(a);}
function pickupSheet(conv){
 if(!conv){toast('这段对话没法接着聊（子 Agent，或者不知道它的会话 ID）');return;}
 const a=pkLiveFor(conv);if(a){pkOpenSheet(conv,a);return;}
 if(pkPendingKey(conv.key)){toast('它已经在启动了，等一下');return;}
 const box=sheet('继续这个对话');box.classList.add('pk-sheet');
 box.append(el('p','muted','开一个新的 '+pkLabel(conv)+'，接着这段对话聊。之前的内容都还在。'));
 pkFacts(box,conv);
 const target=pkTarget();
 const foot=el('div','new-foot');box.append(foot);
 const status=el('div','new-status hidden');status.setAttribute('role','status');status.setAttribute('aria-live','polite');foot.append(status);
 const acts=el('div','sheet-actions');const go=btn('继续','primary',()=>pkGo(conv,go,status),'refresh');go.setAttribute('aria-label','继续这个对话');
 acts.append(btn('取消','secondary',closeSheet),go);foot.append(acts);
 if(!target){newStatus(status,'error',pkNoTarget());go.disabled=true;}}
async function pkGo(conv,go,status){
 if(S.demo){closeSheet();toast('演示模式：不会真的继续');return;}
 if(PK.busy.has(conv.key))return;
 if(PK.bulk){toast('正在一个个继续，稍等一下');return;}
 go.disabled=true;go.replaceChildren(el('span','spinner'),document.createTextNode('正在继续…'));
 newStatus(status,'busy',pkTarget()==='tmux'?'正在开 tmux 会话，接上这段对话…':'正在开标签页，接上这段对话…');
 const r=await pkRun(conv);
 if(r.ok){if(status.isConnected)closeSheet();pkAfter(conv,r);return;}
 if(r.open){if(status.isConnected)closeSheet();pkOpenSheet(conv,r.open);return;}
 if(!status.isConnected){toast(r.message);return;}
 if(r.unknown){const again=btn('刷新列表看看','link-btn',()=>{closeSheet();loadLive();});newStatus(status,'error',r.message,again);go.replaceChildren(document.createTextNode('结果未知'));return;}
 newStatus(status,'error',r.message);go.disabled=false;go.replaceChildren(icon('refresh'),document.createTextNode('继续'));}
// One resume request. {ok, result} / {open: agent} (it runs already) / {message, unknown?}.
async function pkRun(conv){
 const target=pkTarget();if(!target)return {message:pkNoTarget()};
 if(PK.busy.has(conv.key)||pkPendingKey(conv.key))return {message:'它已经在启动了，等一下'};
 if(target==='herdr'&&typeof NEW!=='undefined'&&NEW.busy)return {message:'上一个还在新建，稍等一下'};
 const resume=conv.kind==='ch'?{id:conv.id,host:conv.host}:{id:conv.id};
 PK.busy.add(conv.key);if(target==='herdr')NEW.busy=true;
 try{
  const r=target==='tmux'?await remote('tmuxNew',{id:uuid(),cwd:conv.cwd||'~',resume:{kind:conv.kind,...resume}})
   :await remote('create',{session:S.session,id:uuid(),kind:conv.kind,cwd:conv.cwd||'~',workspace:'auto',resume});
  if(!r?.created)return {message:'没继续：'+(target==='tmux'?'tmux':'Herdr')+' 没接受，可以再试一次'};
  return {ok:true,result:r,target};}
 catch(e){const m=e.message||String(e);
  if(/已经在运行/.test(m)){try{await (target==='tmux'?tmuxLoad():loadLive());}catch(_){}const a=pkLiveFor(conv);if(a)return {open:a};return {message:m};}
  if(/^没(创建|继续)/.test(m))return {message:m.replace(/^没创建：/,'没继续：')};
  if(/Unknown operation|不支持的操作|不认识的字段/.test(m))return {message:'没继续：电脑上的桥接程序太旧，到「设备」页重新安装（桥接程序那一行的「…」）'};
  // Unknown outcome: something may have started. Never retried on its own.
  return {unknown:true,message:'结果未知：'+m.replace(/^新建结果未知：/,'')+'。先刷新列表看看，别直接再点'};}
 finally{PK.busy.delete(conv.key);if(target==='herdr')NEW.busy=false;}}
// After a start: the 正在启动 row (create.js) or, in tmux, a short watch for the agent.
function pkAfter(conv,r,quiet){
 const e=pkEntries().find(x=>x.key===conv.key);if(e){e.resumed=Date.now();pkSave();}
 const res=r.result,label='「'+(conv.title||pkLabel(conv)).slice(0,24)+'」';
 // Started from 历史 or a read-only view: back to 会话, where its 正在启动 row is and its chat opens.
 if(!quiet&&(S.tab!=='live'||S.chat||typeof T!=='undefined'&&T.view))setTab('live');
 if(r.target==='tmux'){pkTmuxWatch(conv,res,label,quiet);return;}
 const place=res.new_workspace?'':res.workspace_label||'';
 if(quiet&&res.state!=='failed'){createPending({...res,place_label:place,resume:conv.key},'',label,true);return;}
 createDone({...res,place_label:place,resume:conv.key},'',label);}
function pkTmuxWatch(conv,res,label,quiet){
 if(!res.typed){toast('tmux 会话开好了，可启动命令没输进去'+(res.detail?'：'+res.detail:'')+'，去终端看看');if(res.pane&&!quiet)tmuxOpen(res.pane);return;}
 const w={key:conv.key,device:pkDev(),pane:res.pane?.pane_id||'',at:Date.now(),label};PK.tmux.push(w);
 if(!quiet)toast('tmux 会话开好了，'+label+' 正在启动，出来后自动打开');
 const tick=async()=>{if(!PK.tmux.includes(w))return;
  if(Date.now()-w.at>60000||pkDev()!==w.device){PK.tmux=PK.tmux.filter(x=>x!==w);pkRepaint();return;}
  try{await tmuxLoad();}catch(_){}
  const p=tmuxPanes().find(x=>x.pane_id===w.pane&&x.agent);
  if(p){PK.tmux=PK.tmux.filter(x=>x!==w);const a=tmuxAgent(p);
   if(!quiet&&S.tab==='live'&&!S.chat&&!(typeof T!=='undefined'&&T.view)&&!overlay.childElementCount){toast(label+' 起来了');openAgent(a);}else{toast(label+' 起来了，在会话列表里');pkRepaint();}return;}
  setTimeout(tick,2000);};
 setTimeout(tick,1500);}

// ─── 全部继续 ───────────────────────────────────────────────────────────────
function pickupAll(){
 const list=pkGone().filter(e=>!pkPendingKey(e.key));
 if(!list.length){toast('没有要继续的对话');return;}
 if(!pkTarget()){toast(pkNoTarget());return;}
 const box=sheet('全部继续？');box.classList.add('pk-sheet','pk-bulk');
 box.append(el('p','muted','下面这些对话之前开着，会一个接一个重新开起来（每个一个新标签页'+(pkTarget()==='tmux'?'，在 tmux 里':'')+'）。不想要的点一下取消勾选。'));
 const rows=el('div','pk-picks');const pick=new Map();
 for(const e of list){const conv=pkConv(e.kind,e.id,{host:e.host,cwd:e.cwd,title:pkTitle(e),record:e.record});if(!conv)continue;pick.set(conv.key,{conv,on:true,state:''});}
 const draw=()=>{rows.replaceChildren();for(const [k,v] of pick){const b=btn('','menu-item pk-pick'+(v.on?' on':''),()=>{if(PK.bulk||v.state)return;v.on=!v.on;draw();},null);
  b.setAttribute('role','checkbox');b.setAttribute('aria-checked',String(v.on));
  const box2=el('span','pk-check'+(v.on?' on':''));if(v.on)box2.append(icon('check'));b.append(box2);
  b.append(avatar(v.conv.kind==='ch'?'claude':v.conv.kind));
  const t=el('span','grow');t.append(el('span','menu-label',v.conv.title||pkLabel(v.conv)),el('small','truncate',[pkLabel(v.conv),v.conv.cwd?shortPath(v.conv.cwd):''].filter(Boolean).join(' · ')));
  if(v.message)t.append(el('small','pk-pick-error',v.message));b.append(t);
  if(v.state==='busy')b.append(el('span','spinner mini'));else if(v.state==='ok')b.append(el('span','badge ok','开了'));else if(v.state==='error')b.append(el('span','badge alert','没继续'));
  rows.append(b);}
  const n=[...pick.values()].filter(v=>v.on&&!v.state).length;go.disabled=PK.bulk||!n;if(!PK.bulk)go.replaceChildren(icon('refresh'),document.createTextNode(n?'继续 '+n+' 个':'继续'));};
 box.append(rows);
 const foot=el('div','new-foot');box.append(foot);
 const status=el('div','new-status hidden');status.setAttribute('role','status');status.setAttribute('aria-live','polite');foot.append(status);
 const acts=el('div','sheet-actions');const cancel=btn('取消','secondary',closeSheet);const go=btn('继续','primary',()=>pkBulkRun(pick,draw,go,cancel,status),'refresh');
 acts.append(cancel,go);foot.append(acts);draw();}
async function pkBulkRun(pick,draw,go,cancel,status){
 if(S.demo){closeSheet();toast('演示模式：不会真的继续');return;}
 if(PK.bulk)return;PK.bulk=true;go.disabled=true;go.replaceChildren(el('span','spinner'),document.createTextNode('正在继续…'));
 const todo=[...pick.values()].filter(v=>v.on&&!v.state);let ok=0,bad=0,unknown=false;
 // One after another (each answers in a few seconds): Herdr is never asked for several tabs at once.
 for(const v of todo){if(unknown){break;}v.state='busy';draw();newStatus(status,'busy','正在继续「'+(v.conv.title||pkLabel(v.conv)).slice(0,30)+'」（'+(ok+bad+1)+'/'+todo.length+'）…');
  const r=await pkRun(v.conv);
  if(r.ok){v.state='ok';ok++;pkAfter(v.conv,r,true);}
  else if(r.open){v.state='ok';v.message='已经开着了';ok++;}
  else{v.state='error';v.message=r.message;bad++;if(r.unknown)unknown=true;}
  draw();}
 PK.bulk=false;
 if(!bad){if(status.isConnected)closeSheet();toast('继续了 '+ok+' 个对话，正在启动，起来后在会话列表里');if(typeof newPendingPaint==='function')newPendingPaint();return;}
 newStatus(status,'error',(ok?'继续了 '+ok+' 个，':'')+bad+' 个没继续'+(unknown?'（有一个结果未知，后面的先没开；刷新列表看看再说）':'，原因写在每一行下面'));
 go.replaceChildren(document.createTextNode('完成'));go.disabled=false;go.onclick=()=>{closeSheet();newPendingPaint();};cancel.classList.add('hidden');draw();go.disabled=false;}

// ─── Entry points on other screens ──────────────────────────────────────────
// A button for a history view (the read-only footer, an exited agent's card): 继续 / 打开.
function pickupButton(conv,cls='primary small'){
 if(!conv)return null;const a=pkLiveFor(conv);
 if(a)return btn('打开在线会话',cls+' pk-open',()=>pickupOpen(a),'chat');
 const b=btn('继续这个对话',cls+' pk-resume',()=>pickupSheet(conv),'refresh');return b;}
function pkRecordConv(){const c=S.chat;if(!c||c.agent&&!c.stale)return null;return c.record?pkFromRecord(c.record):c.agent?pkFromAgent(c.agent):null;}

(function(){
 const baseLive=livePage,baseCacheLive=cacheLive,baseTmuxLoad=tmuxLoad,baseHistoryRow=historyRow,baseHistoryActions=historyActions,
  baseChatMenu=chatMenu,baseComposer=renderComposer,baseFollowFooter=followFooter,baseAfterPane=closeAfterPane,baseAfterExit=closeAfterExit;
 // 会话: 最近断开的 under 正在启动, above the agents (and on a computer with only tmux).
 livePage=function(main){baseLive(main);if(S.device&&!S.demo)try{pkSection(main);}catch(_){}};
 cacheLive=function(...args){const r=baseCacheLive(...args);if(!S.fromCache)pkNote();return r;};
 tmuxLoad=async function(...args){const r=await baseTmuxLoad(...args);if(tmuxDevice()&&pkTmuxFresh())pkNote();return r;};
 // 历史: rows say when that conversation is open right now; their actions offer 继续 / 打开.
 historyRow=function(r,hidden){const row=baseHistoryRow(r,hidden);const conv=pkFromRecord(r);
  if(conv&&pkLiveFor(conv,PK.liveCache&&PK.liveCache.at===S.liveAt?PK.liveCache.map:(PK.liveCache={at:S.liveAt,map:pkLiveMap()}).map)){const meta=row.querySelector('.card-meta');if(meta)meta.append(el('span','tag pk-live-tag','开着'));}
  return row;};
 historyActions=function(r){baseHistoryActions(r);const box=overlay.querySelector('.sheet');const conv=pkFromRecord(r);if(!box||!conv)return;
  const a=pkLiveFor(conv);const item=a?menuItem(box,'打开在线会话',()=>pickupOpen(a),'chat','它正在运行'):menuItem(box,'继续这个对话',()=>pickupSheet(conv),'refresh','新开一个 '+pkLabel(conv)+' 接着聊');
  const open=box.querySelector('.menu-item');if(open)open.after(item);};
 chatMenu=function(){baseChatMenu();const box=overlay.querySelector('.sheet');const conv=pkRecordConv();if(!box||!conv)return;
  const a=pkLiveFor(conv);const item=a?menuItem(box,'打开在线会话',()=>pickupOpen(a),'chat','它正在运行'):menuItem(box,'继续这个对话',()=>pickupSheet(conv),'refresh','新开一个 '+pkLabel(conv)+' 接着聊');
  const first=box.querySelector('.menu-item');if(first)box.insertBefore(item,first);};
 // The read-only footer of a history view gets the one way to talk again.
 renderComposer=function(...args){baseComposer(...args);const footer=document.getElementById('composer'),c=S.chat;
  if(!footer||!c||c.agent||!c.record||c.record.parent||!S.device&&!S.demo)return;const ro=footer.querySelector(':scope>.readonly');const conv=pkFromRecord(c.record);if(!ro||!conv)return;
  const live=pkLiveFor(conv);ro.textContent=live?'这段对话正在运行 · 这里是只读的历史':'历史只读 · 想接着聊就继续它';ro.classList.add('pk-readonly');
  const b=pickupButton(conv,'primary small');const bar=el('div','pk-bar');bar.append(ro,b);footer.replaceChildren(bar);};
 // An agent that quit (or whose pane closed) while its chat was open: 继续 right there.
 followFooter=function(footer){const done=baseFollowFooter(footer);const c=S.chat;if(!done||!c?.exited||c.newAgent)return done;
  const conv=pkFromAgent(c.agent)||(c.record&&pkFromRecord(c.record));const b=conv&&pickupButton(conv,'secondary small');if(!b)return done;
  const card=footer.querySelector('.follow-card');let row=card?.querySelector('.follow-actions');if(card&&!row){row=el('div','follow-actions');card.append(row);}if(row)row.prepend(b);return done;};
 // 设置 → 清除缓存: the seen list goes with the rest of the cache.
 const baseForget=cacheForget;cacheForget=function(...args){PK.store=null;PK.storeFor='';PK.loading=null;return baseForget(...args);};
 closeAfterPane=function(a,...rest){pkClosed(a);return baseAfterPane(a,...rest);};
 closeAfterExit=function(a,...rest){pkClosed(a);return baseAfterExit(a,...rest);};
})();
window.pickupAll=pickupAll;window.pickupCount=pickupCount;
