'use strict';
// New session from the phone: pick Codex / Claude / Claude via ch, a project directory and
// where to open it; the bridge opens a new Herdr tab there (never stealing focus on the
// computer) and starts the agent with a command line it chooses itself. The optional first
// message goes out through the normal prompt path, only once the new agent is ready.
const NEW={info:null,infoSession:'',busy:false,watch:0,form:null,recent:null,recentFor:'',homes:new Map()};
function newHome(home){if(typeof home==='string'&&home.startsWith('/')&&S.device&&!S.demo)NEW.homes.set(S.device.id,home.replace(/\/+$/,'')||'/');}
const NEW_KINDS={codex:['Codex','codex','本机运行'],claude:['Claude','claude','本机运行'],ch:['Claude · ch','claude','用 ch new 开']};
// Other agents Herdr can start (bridge createInfo `more`: only kinds whose command is installed).
// [label, avatar kind, detail]: they run like any agent; their replies are read from the terminal.
function newKind(k){return NEW_KINDS[k]||[providerName(k),k,'看终端回复'];}
const NEW_DEMO={kinds:[{kind:'codex',found:true},{kind:'claude',found:true},{kind:'ch',found:true}],home:'/home/demo',
 workspaces:[{workspace_id:'w1',label:'pocket',focused:true,dirs:[{path:'/home/demo/projects/pocket',agents:2,panes:3}]},{workspace_id:'w2',label:'site',dirs:[{path:'/home/demo/projects/site',agents:1,panes:1}]}],
 dirs:[{path:'/home/demo/projects/pocket',source:'pane',agents:2,workspace_id:'w1'},{path:'/home/demo/projects/site',source:'pane',agents:1,workspace_id:'w2'},{path:'/home/demo/notes',source:'history',modified:Date.now()/1000-86400*2}]};

function createButton(){const b=btn('新建','new-btn',openCreate,'plus');b.setAttribute('aria-label','新建会话');return b;}
function newPref(k,v){try{if(v===undefined)return localStorage.getItem('hp.new.'+k)||'';localStorage.setItem('hp.new.'+k,v);}catch(_){}return '';}
function newShort(p){const home=NEW.info?.home;return home&&(p===home||p.startsWith(home+'/'))?'~'+p.slice(home.length):p;}
function newAgo(t){const a=ago(Date.now()-t*1000);return a==='刚刚'?'刚用过':a+'前用过';}
function newBase(p){return NEW.info?.home&&p.replace(/\/+$/,'')===NEW.info.home?'家目录':p.split('/').filter(Boolean).pop()||'/';}

// The last directories used from this phone (per computer, in the encrypted cache): they go first.
async function newRecentLoad(){const dev=S.device?.id||'';if(S.demo||NEW.recentFor===dev)return;const v=await cacheGet('new:recent');NEW.recent=Array.isArray(v?.dirs)?v.dirs.filter(d=>typeof d?.path==='string').slice(0,6):[];NEW.recentFor=dev;if(v?.kind)NEW.lastKind=v.kind;}
function newRecentSave(path,kind){const dev=S.device?.id||'';if(S.demo||!dev)return;const list=(NEW.recentFor===dev&&NEW.recent||[]).filter(d=>d.path!==path);list.unshift({path,at:Date.now()/1000});NEW.recent=list.slice(0,6);NEW.recentFor=dev;NEW.lastKind=kind;cachePut('new:recent',{dirs:NEW.recent,kind});}
async function openCreate(){
 if(!S.device){toast('先连接电脑');return;}
 if(!S.session&&!S.demo){toast('还没读到 Herdr 会话，刷新一下');return;}
 if(NEW.busy){toast('上一个还在新建，稍等一下');return;}
 const box=sheet('新建会话');box.classList.add('new-sheet');
 // Just a terminal: a new tmux session instead of an agent (tmux.js).
 if(!S.demo&&typeof tmuxCan==='function'&&tmuxCan()){const t=menuItem(box,'新建 tmux 会话',tmuxNewSheet,'terminal','不开 Agent，只开一个终端');t.classList.add('new-tmux');}
 const body=el('div','new-body');box.append(body);
 const cached=NEW.infoSession===S.session?NEW.info:null;
 if(cached)createForm(body,cached);else body.append(el('div','loading','读取目录和工作区…'));
 try{const info=S.demo?NEW_DEMO:await remote('createInfo',{session:S.session});
  await newRecentLoad().catch(()=>{});NEW.info=info;NEW.infoSession=S.session;newHome(info.home);
  if(!body.isConnected||NEW.busy)return;
  if(!cached)createForm(body,info);}
 catch(e){if(body.isConnected&&!cached)body.replaceChildren(el('p','note error','读不到目录：'+e.message));}}

function createForm(body,info){
 body.replaceChildren();
 const kinds=info.kinds.filter(k=>k.found||k.kind!=='ch').map(k=>k.kind).concat((info.more||[]).filter(k=>k&&k.found&&kindSafe(k.kind)&&!NEW_KINDS[k.kind]).map(k=>k.kind));
 const found=k=>info.kinds.concat(info.more||[]).find(x=>x.kind===k)?.found;
 const last=NEW.lastKind||newPref('kind'),recent=(NEW.recentFor===(S.device?.id||'')&&NEW.recent)||[];
 const f=NEW.form={kind:kinds.includes(last)?last:kinds[0]||'codex',dir:'',custom:false,place:'new',placeTouched:false};
 // Recently used from here first (marked), then what the computer reports (busiest first).
 const known=new Map((info.dirs||[]).map(d=>[d.path,d]));const dirs=[];
 for(const r of recent){dirs.push({...(known.get(r.path)||{path:r.path,source:'recent'}),recentAt:r.at});known.delete(r.path);}
 dirs.push(...known.values());
 f.dir=dirs[0]?.path||'';f.custom=!dirs.length;

 // Agent kind
 body.append(el('div','section-label','用哪个 Agent'));
 const kindRow=el('div','new-kinds');kindRow.setAttribute('role','radiogroup');kindRow.setAttribute('aria-label','Agent 类型');body.append(kindRow);
 function drawKinds(){kindRow.replaceChildren();for(const k of kinds){const [label,av,detail]=newKind(k);
  const b=btn('','new-kind'+(f.kind===k?' on':''),()=>{f.kind=k;drawKinds();},null);b.setAttribute('role','radio');b.setAttribute('aria-checked',String(f.kind===k));b.setAttribute('aria-label',label);
  const t=el('span','new-kind-text');t.append(el('strong','',label),el('small','',found(k)?detail:'没找到命令'));b.append(avatar(av),t);kindRow.append(b);}}
 drawKinds();

 // Directory
 body.append(el('div','section-label','在哪个目录'));
 const dirList=el('div','new-dirs');dirList.setAttribute('role','radiogroup');dirList.setAttribute('aria-label','项目目录');body.append(dirList);
 const pathInput=el('input','field new-path');pathInput.type='text';pathInput.placeholder='~/projects/app';pathInput.autocomplete='off';pathInput.spellcheck=false;pathInput.setAttribute('aria-label','目录路径');pathInput.setAttribute('autocapitalize','off');
 pathInput.oninput=()=>{f.dir=pathInput.value.trim();autoPlace();};
 let showAll=dirs.findIndex(d=>d.path===f.dir)>=4;
 function dirRow(d){const on=!f.custom&&f.dir===d.path;const b=btn('','menu-item new-dir'+(on?' on':''),()=>{f.custom=false;f.dir=d.path;drawDirs();autoPlace();},'folder');b.setAttribute('role','radio');b.setAttribute('aria-checked',String(on));
  const t=el('span','grow');t.append(el('span','menu-label',newBase(d.path)));
  const meta=(d.recentAt?(d===dirs[0]?'上次用的':'最近用过')+(d.agents?' · ':''):'')+(d.source==='pane'?(d.agents?d.agents+' 个 Agent 在用':d.recentAt?'':'有终端在这'):d.recentAt?'':d.modified?newAgo(d.modified):'用过');
  t.append(el('small','truncate',newShort(d.path)+' · '+meta));b.append(t);if(on)b.append(icon('check'));return b;}
 function drawDirs(){dirList.replaceChildren();const list=showAll?dirs:dirs.slice(0,4);list.forEach(d=>dirList.append(dirRow(d)));
  if(!showAll&&dirs.length>4)dirList.append(btn('更多目录 · '+(dirs.length-4),'link-btn new-more',()=>{showAll=true;drawDirs();}));
  const other=btn('','menu-item new-dir'+(f.custom?' on':''),()=>{f.custom=true;f.dir=pathInput.value.trim();drawDirs();autoPlace();setTimeout(()=>pathInput.focus(),30);},'edit');other.setAttribute('role','radio');other.setAttribute('aria-checked',String(f.custom));
  const t=el('span','grow');t.append(el('span','menu-label','其他目录'),el('small','','家目录下的路径，要已经存在'));other.append(t);dirList.append(other);
  if(f.custom)dirList.append(pathInput);}
 drawDirs();

 // Where: a new tab in a workspace (matched by directory), or a new workspace.
 body.append(el('div','section-label','开在哪里'));
 const places=el('div','new-places');places.setAttribute('role','radiogroup');places.setAttribute('aria-label','位置');body.append(places);
 const placeNote=el('p','fine new-note');body.append(placeNote);
 function placeLabel(w){return w.label||'工作区 '+w.workspace_id.slice(1);}
 function drawPlaces(){places.replaceChildren();
  for(const w of info.workspaces){const on=f.place===w.workspace_id;const b=btn(placeLabel(w),'pill'+(on?' active':''),()=>{f.place=w.workspace_id;f.placeTouched=true;drawPlaces();});b.setAttribute('role','radio');b.setAttribute('aria-checked',String(on));places.append(b);}
  const on=f.place==='new';const n=btn('新工作区','pill'+(on?' active':''),()=>{f.place='new';f.placeTouched=true;drawPlaces();},'plus');n.setAttribute('role','radio');n.setAttribute('aria-checked',String(on));places.append(n);
  const w=info.workspaces.find(x=>x.workspace_id===f.place);
  placeNote.textContent=w?'在「'+placeLabel(w)+'」里加一个标签页，电脑上的画面不会被切走。':'新开一个工作区，电脑上的画面不会被切走。';}
 function autoPlace(){if(f.placeTouched){drawPlaces();return;}
  const p=f.dir.replace(/\/+$/,'');let best=null,score=0;
  for(const w of info.workspaces){const d=w.dirs.find(x=>x.path===p);const s=d?100+d.agents*3+d.panes:(placeLabel(w)===newBase(p)?50:0);if(s>score){score=s;best=w;}}
  f.place=best?best.workspace_id:'new';drawPlaces();}
 autoPlace();

 // Optional first message
 body.append(el('div','section-label','第一条消息 · 可不填'));
 const first=el('textarea','field new-first');first.rows=3;first.placeholder='准备好之后自动发给它';first.setAttribute('aria-label','第一条消息');body.append(first);
 const box=body.closest('.sheet');if(box)box.keepOpen=()=>!!first.value.trim()&&!NEW.busy;
 // Status and buttons stay pinned to the bottom of the sheet.
 const foot=el('div','new-foot');body.append(foot);
 const status=el('div','new-status hidden');status.setAttribute('role','status');status.setAttribute('aria-live','polite');foot.append(status);
 const actions=el('div','sheet-actions');const go=btn('新建','primary',()=>createSubmit(first.value,go,status),'plus');go.setAttribute('aria-label','开始新建');
 actions.append(btn('取消','secondary',closeSheet),go);foot.append(actions);}

function newStatus(status,kind,text,extra){status.className='new-status '+kind;status.replaceChildren();if(kind==='busy')status.append(el('span','spinner'));else status.append(icon('alert'));const t=el('div','grow');t.append(el('div','',text));if(extra)t.append(extra);status.append(t);}

async function createSubmit(text,go,status){
 const f=NEW.form;if(!f||NEW.busy)return;
 if(!f.dir){toast(f.custom?'先填目录路径':'先选一个目录');return;}
 if(S.demo){closeSheet();toast('演示模式：不会真的新建');return;}
 const label=newKind(f.kind)[0];
 NEW.busy=true;go.disabled=true;go.replaceChildren(el('span','spinner'),document.createTextNode('正在新建…'));
 // The bridge answers in a few seconds (tab open, start handed to Herdr); the rest shows on the list.
 newStatus(status,'busy','正在开标签页，把 '+label+' 叫起来…');
 const req={session:S.session,id:uuid(),kind:f.kind,cwd:f.dir,workspace:f.place};
 // Named for the 正在启动 / 没起来 sheets (the pane id means nothing to a person).
 const ws=f.place==='new'?null:(NEW.info?.workspaces||[]).find(w=>w.workspace_id===f.place),placeName=ws?ws.label||'工作区 '+ws.workspace_id.slice(1):'';
 try{
  const r=await remote('create',req);NEW.busy=false;
  if(!r||!r.created){newStatus(status,'error','没创建：Herdr 没接受，可以改一下再试');restoreGo(go);return;}
  newPref('kind',f.kind);newRecentSave(f.dir.replace(/\/+$/,''),f.kind);NEW.info=null;
  if(status.isConnected)closeSheet();createDone({...r,place_label:placeName},text.trim()?text:'',label);}
 catch(e){NEW.busy=false;const m=e.message||String(e);
  if(/^没创建/.test(m)){if(status.isConnected){newStatus(status,'error',m);restoreGo(go);}else toast(m);return;}
  // Unknown outcome: something may have been created. Never retry on its own.
  const again=btn('刷新列表看看','link-btn',()=>{closeSheet();loadLive();});
  if(status.isConnected){newStatus(status,'error','结果未知：'+m.replace(/^新建结果未知：/,''),again);go.replaceChildren(document.createTextNode('结果未知'));}
  else toast('新建结果未知，刷新列表看看，别直接再建');}}
function restoreGo(go){go.disabled=false;go.replaceChildren(icon('plus'),document.createTextNode('新建'));}

// After creation: open the new chat once Herdr shows the agent (history appears once it writes it).
async function createDone(r,text,label){
 if(r.state==='failed'){createFailed(r,text,label);return;}
 const seen=r.state==='ready'||r.state==='blocked'||r.detected;
 if(!seen){createPending(r,text,label);return;}
 toast(r.state==='blocked'?label+' 开好了，它在等你确认':r.state==='ready'?label+' 开好了':label+' 开好了，还在准备');
 await createOpen(r.pane_id,text);}
async function createOpen(pane,text){
 if(S.tab!=='live'||S.chat||(typeof T!=='undefined'&&T.view)){if(S.tab==='live'&&!S.chat)loadLive();return false;}
 await loadLive();
 const a=S.agents.find(x=>x.pane_id===pane&&x.agent);
 if(!a||S.chat||S.tab!=='live')return !!a;
 openAgent(a);
 if(text&&S.chat?.agent?.pane_id===pane){
  S.drafts.set(draftKey(),text);renderComposer();
  const input=document.querySelector('#composer textarea');
  if(['idle','done'].includes(a.agent_status)&&input)sendMessage(input);
  else toast('第一条消息放在输入框里了，它准备好再发');}
 return true;}

// ─── 正在启动: the tab is open, the agent is not visible yet ──────────────────
// A row at the top of 会话 for each start still on its way (per computer and Herdr session),
// polled with the cheap `status` read until Herdr shows an agent in that pane. Nothing is ever
// started again from here: the only actions are looking at the terminal and no longer waiting.
NEW.pending=[];
const NEW_POLL=1500,NEW_SLOW=45000,NEW_GIVE_UP=120000;
function newPendingHere(){const dev=S.device?.id||'';return NEW.pending.filter(p=>p.device===dev&&p.session===S.session);}
function createPending(r,text,label){
 const p={device:S.device?.id||'',session:S.session,pane:r.pane_id,kind:r.kind,label,cwd:r.cwd||'',text,at:Date.now(),state:'starting',newWorkspace:!!r.new_workspace,place:r.place_label||''};
 NEW.pending=NEW.pending.filter(x=>!(x.device===p.device&&x.pane===p.pane)).concat(p);
 toast('标签页开好了，'+label+' 正在启动，出来后自动打开');
 if(S.tab==='live'&&!S.chat&&!(typeof T!=='undefined'&&T.view))render();
 createWatch();}
function newPendingDrop(p){NEW.pending=NEW.pending.filter(x=>x!==p);if(!NEW.pending.some(x=>x.state!=='lost'))clearInterval(NEW.watch);}
function createWatch(){
 clearInterval(NEW.watch);let busy=false;
 NEW.watch=setInterval(async()=>{
  const live=NEW.pending.filter(p=>p.state!=='lost');if(!live.length){clearInterval(NEW.watch);return;}
  const here=newPendingHere().filter(p=>p.state!=='lost');
  // Waiting too long: say so on the row; after a while stop asking (the row stays until dismissed).
  for(const p of live){const age=Date.now()-p.at;const st=age>NEW_GIVE_UP?'lost':age>NEW_SLOW?'slow':'starting';if(st!==p.state){p.state=st;newPendingPaint();}}
  if(!here.length||busy||!S.device||S.demo)return;busy=true;
  try{const s=await remote('status',{session:here[0].session});if(here[0].device!==(S.device?.id||''))return;
   for(const p of here){const a=(s.agents||[]).find(x=>x.pane_id===p.pane&&x.agent);if(!a||!NEW.pending.includes(p)||p.opening)continue;
    if(S.tab==='live'&&!S.chat&&!(typeof T!=='undefined'&&T.view)&&!overlay.childElementCount){
     // The row stays (as 起来了) until the chat is open, so the list never shows neither.
     p.opening=true;newPendingPaint();toast(p.label+' 起来了');try{await createOpen(p.pane,p.text);}finally{newPendingDrop(p);if(!S.chat)newPendingPaint();}}
    else{newPendingDrop(p);if(p.text)S.drafts.set(p.session+'/'+a.identity,p.text);toast(p.label+' 起来了，在会话列表里'+(p.text?'；第一条消息放在它的输入框里了':''));newPendingPaint();}}}
  catch(_){/* the next beat asks again */}
  finally{busy=false;}},NEW_POLL);}
// Repaint the list for a changed row, unless something is in the way (same rule as tmux.js).
function newPendingPaint(){
 if(S.tab!=='live'||S.chat||(typeof T!=='undefined'&&T.view)||overlay.childElementCount)return;
 const a=document.activeElement;if(a&&/^(INPUT|TEXTAREA)$/.test(a.tagName)&&app.contains(a))return;
 const main=app.querySelector('.main'),top=main?main.scrollTop:0;render();
 const next=app.querySelector('.main');if(next){next.classList.remove('pane-enter');next.scrollTop=top;}}
// livePage (app.js) calls this under its toolbar; returns how many rows it drew.
function newPendingSection(main){
 // An agent the list already shows is not starting any more: its row hides (the watcher still
 // opens it, so a list refresh that saw it first does not swallow the chat or the first message).
 const listed=p=>S.agents.some(a=>a.pane_id===p.pane&&a.agent);
 // One the watcher gave up on that shows up later: its first message goes into its input box, not out.
 for(const p of newPendingHere())if(p.state==='lost'&&listed(p)){newPendingDrop(p);const a=S.agents.find(x=>x.pane_id===p.pane&&x.agent);
  if(p.text&&a){S.drafts.set(p.session+'/'+a.identity,p.text);setTimeout(()=>toast(p.label+' 出来了；第一条消息放在它的输入框里了，没发'),0);}}
 const list=newPendingHere().filter(p=>!listed(p)||p.opening);if(!list.length)return 0;
 const h=el('div','section-label group-label g-work new-pending-label');h.append(el('span','','正在启动'),el('span','group-count',String(list.length)));main.append(h);
 const card=el('div','card list-card new-pending-list');list.forEach(p=>card.append(newPendingRow(p)));main.append(card);
 return list.length;}
function newPendingRow(p){
 const slow=p.state!=='starting'&&!p.opening,where=newBase(p.cwd||'')+(p.cwd?' · '+newShort(p.cwd):'');
 const b=btn('','card-button agent-row new-pending tone-'+(slow?'alert':'work'),()=>newPendingSheet(p));
 b.setAttribute('aria-label',(slow?p.label+' 还没出现':'正在启动 '+p.label+'…')+' · '+where);
 const t=el('div','grow');t.append(el('div','card-title',slow?p.label+' 还没出现':'正在启动 '+p.label+'…'));
 const meta=el('div','card-meta');meta.append(el('span','project',newBase(p.cwd||'')||p.label));
 meta.append(el('span','sep',p.opening?'起来了，正在打开':p.state==='lost'?'没等到，去电脑上看看那个标签页':slow?'等得有点久，点开看看':p.kind==='ch'?'ch 在连另一台电脑':'标签页开好了，等它出来'));
 t.append(meta);
 const side=el('div','row-side');if(p.state!=='lost')side.append(el('span','spinner mini'));const tm=since(p.at);tm.classList.add('row-time');side.append(tm);
 b.append(avatar(newKind(p.kind)[1],slow?'alert':'work'),t,side);return b;}
// What was started and where, in words: the Agent, its directory and the workspace it went into.
function newFacts(box,kind,cwd,newWorkspace,place){
 const [label,,detail]=newKind(kind);const list=el('div','new-facts');
 const row=(k,v,cls)=>{const n=el('div','new-fact');n.append(el('span','new-fact-key',k),el('span','new-fact-value'+(cls?' '+cls:''),v));list.append(n);};
 row('Agent',label+(detail&&NEW_KINDS[kind]?' · '+detail:''));
 if(cwd)row('目录',shortPath(cwd),'mono');
 row('开在',newWorkspace?'新工作区':place?'「'+place+'」里的新标签页':'已有工作区里的新标签页');
 box.append(list);}
function newPendingSheet(p){
 const box=sheet(p.state==='starting'?'正在启动 '+p.label:p.label+' 还没出现');
 box.append(el('p','muted',(p.newWorkspace?'新工作区':'新标签页')+'已经开好了，'+(p.state==='starting'?p.label+' 正在启动，出来后这里会自动打开它。':'可 '+p.label+' 一直没出现。可能停在了终端里（比如登录、更新提示），去终端看看。')));
 newFacts(box,p.kind,p.cwd,p.newWorkspace,p.place);
 box.append(el('p','fine','不会再启动一次。'+(!p.text?'':p.state==='lost'?'第一条消息没发；它之后出来的话，会放在它的输入框里。':'第一条消息等它出来再发。')));
 const row=el('div','sheet-actions new-acts');
 row.append(btn('不等了','secondary',()=>{newPendingDrop(p);closeSheet();newPendingPaint();toast('不等了，标签页还留在电脑上');}),btn('去终端看看','primary',()=>newPaneOpen(p.pane),'terminal'));
 box.append(row);}
// 去终端看看: straight to that tab's terminal (the 终端 list shows several look-alike idle shells).
async function newPaneOpen(paneId){
 closeSheet();setTab('terminals');
 for(let i=0;i<60&&T.loading;i++)await new Promise(r=>setTimeout(r,150));
 if(S.tab!=='terminals'||T.view)return;
 if(!T.panes.some(x=>x.pane_id===paneId))await loadPanes();
 const pane=T.panes.find(x=>x.pane_id===paneId);
 if(pane&&S.tab==='terminals'&&!T.view)openPane(pane);else if(!pane&&S.tab==='terminals')toast('没在普通窗格里找到它（可能已经起了 Agent 或被关了），看看会话列表');}
function createFailed(r,text,label){
 const box=sheet(label+' 没起来');
 box.append(el('p','muted',(r.new_workspace?'新工作区':'新标签页')+'已经开好了，但 '+label+' 没启动成功'+(r.detail?'：'+r.detail:'')+'。'));
 newFacts(box,r.kind,r.cwd,!!r.new_workspace,r.place_label);
 box.append(el('p','fine',(r.typed?'启动命令可能已经输进去了，':'')+'标签页留在电脑上，没有关掉。'+(text?'第一条消息没发。':'')));
 const row=el('div','sheet-actions new-acts');row.append(btn('知道了','secondary',closeSheet),btn('去终端看看','primary',()=>newPaneOpen(r.pane_id),'terminal'));box.append(row);}
