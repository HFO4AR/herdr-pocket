'use strict';
// New session from the phone: pick Codex / Claude / Claude via ch, a project directory and
// where to open it; the bridge opens a new Herdr tab there (never stealing focus on the
// computer) and starts the agent with a command line it chooses itself. The optional first
// message goes out through the normal prompt path, only once the new agent is ready.
const NEW={info:null,infoSession:'',busy:false,watch:0,form:null};
const NEW_KINDS={codex:['Codex','codex','本机运行'],claude:['Claude','claude','本机运行'],ch:['Claude · ch','claude','用 ch new 开']};
const NEW_DEMO={kinds:[{kind:'codex',found:true},{kind:'claude',found:true},{kind:'ch',found:true}],home:'/home/demo',
 workspaces:[{workspace_id:'w1',label:'pocket',focused:true,dirs:[{path:'/home/demo/projects/pocket',agents:2,panes:3}]},{workspace_id:'w2',label:'site',dirs:[{path:'/home/demo/projects/site',agents:1,panes:1}]}],
 dirs:[{path:'/home/demo/projects/pocket',source:'pane',agents:2,workspace_id:'w1'},{path:'/home/demo/projects/site',source:'pane',agents:1,workspace_id:'w2'},{path:'/home/demo/notes',source:'history',modified:Date.now()/1000-86400*2}]};

function createButton(){const b=btn('新建','new-btn',openCreate,'plus');b.setAttribute('aria-label','新建会话');return b;}
function newPref(k,v){try{if(v===undefined)return localStorage.getItem('hp.new.'+k)||'';localStorage.setItem('hp.new.'+k,v);}catch(_){}return '';}
function newShort(p){const home=NEW.info?.home;return home&&(p===home||p.startsWith(home+'/'))?'~'+p.slice(home.length):p;}
function newAgo(t){const a=ago(Date.now()-t*1000);return a==='刚刚'?'刚用过':a+'前用过';}
function newBase(p){return NEW.info?.home&&p.replace(/\/+$/,'')===NEW.info.home?'家目录':p.split('/').filter(Boolean).pop()||'/';}

async function openCreate(){
 if(!S.device){toast('先连接电脑');return;}
 if(!S.session&&!S.demo){toast('还没读到 Herdr 会话，刷新一下');return;}
 if(NEW.busy){toast('上一个还在新建，稍等一下');return;}
 const box=sheet('新建会话');box.classList.add('new-sheet');
 const body=el('div','new-body');box.append(body);
 const cached=NEW.infoSession===S.session?NEW.info:null;
 if(cached)createForm(body,cached);else body.append(el('div','loading','读取目录和工作区…'));
 try{const info=S.demo?NEW_DEMO:await remote('createInfo',{session:S.session});
  NEW.info=info;NEW.infoSession=S.session;
  if(!body.isConnected||NEW.busy)return;
  if(!cached)createForm(body,info);}
 catch(e){if(body.isConnected&&!cached)body.replaceChildren(el('p','note error','读不到目录：'+e.message));}}

function createForm(body,info){
 body.replaceChildren();
 const kinds=info.kinds.filter(k=>k.found||k.kind!=='ch').map(k=>k.kind);
 const last=newPref('kind'),lastDir=newPref('dir');
 const f=NEW.form={kind:kinds.includes(last)?last:kinds[0]||'codex',dir:'',custom:false,place:'new',placeTouched:false};
 const dirs=info.dirs||[];f.dir=dirs.some(d=>d.path===lastDir)?lastDir:dirs[0]?.path||'';f.custom=!dirs.length;

 // Agent kind
 body.append(el('div','section-label','用哪个 Agent'));
 const kindRow=el('div','new-kinds');kindRow.setAttribute('role','radiogroup');kindRow.setAttribute('aria-label','Agent 类型');body.append(kindRow);
 function drawKinds(){kindRow.replaceChildren();for(const k of kinds){const [label,av,detail]=NEW_KINDS[k];const found=info.kinds.find(x=>x.kind===k)?.found;
  const b=btn('','new-kind'+(f.kind===k?' on':''),()=>{f.kind=k;drawKinds();},null);b.setAttribute('role','radio');b.setAttribute('aria-checked',String(f.kind===k));b.setAttribute('aria-label',label);
  const t=el('span','new-kind-text');t.append(el('strong','',label),el('small','',found?detail:'没找到命令'));b.append(avatar(av),t);kindRow.append(b);}}
 drawKinds();

 // Directory
 body.append(el('div','section-label','在哪个目录'));
 const dirList=el('div','new-dirs');dirList.setAttribute('role','radiogroup');dirList.setAttribute('aria-label','项目目录');body.append(dirList);
 const pathInput=el('input','field new-path');pathInput.type='text';pathInput.placeholder='~/projects/app';pathInput.autocomplete='off';pathInput.spellcheck=false;pathInput.setAttribute('aria-label','目录路径');pathInput.setAttribute('autocapitalize','off');
 pathInput.oninput=()=>{f.dir=pathInput.value.trim();autoPlace();};
 let showAll=dirs.findIndex(d=>d.path===f.dir)>=4;
 function dirRow(d){const on=!f.custom&&f.dir===d.path;const b=btn('','menu-item new-dir'+(on?' on':''),()=>{f.custom=false;f.dir=d.path;drawDirs();autoPlace();},'folder');b.setAttribute('role','radio');b.setAttribute('aria-checked',String(on));
  const t=el('span','grow');t.append(el('span','menu-label',newBase(d.path)));
  const meta=d.source==='pane'?(d.agents?d.agents+' 个 Agent 在用':'有终端在这'):d.modified?newAgo(d.modified):'用过';
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
 const label=NEW_KINDS[f.kind][0];
 NEW.busy=true;go.disabled=true;go.replaceChildren(el('span','spinner'),document.createTextNode('正在启动…'));
 newStatus(status,'busy','正在开标签页并启动 '+label+'，一般要十几秒');
 const req={session:S.session,id:uuid(),kind:f.kind,cwd:f.dir,workspace:f.place};
 try{
  const r=await remote('create',req);NEW.busy=false;
  if(!r||!r.created){newStatus(status,'error','没创建：Herdr 没接受，可以改一下再试');restoreGo(go);return;}
  newPref('kind',f.kind);if(!f.custom)newPref('dir',f.dir);NEW.info=null;
  if(status.isConnected)closeSheet();createDone(r,text.trim()?text:'',label);}
 catch(e){NEW.busy=false;const m=e.message||String(e);
  if(/^没创建/.test(m)){if(status.isConnected){newStatus(status,'error',m);restoreGo(go);}else toast(m);return;}
  // Unknown outcome: something may have been created. Never retry on its own.
  const again=btn('刷新列表看看','link-btn',()=>{closeSheet();loadLive();});
  if(status.isConnected){newStatus(status,'error','结果未知：'+m.replace(/^新建结果未知：/,''),again);go.replaceChildren(document.createTextNode('结果未知'));}
  else toast('新建结果未知，刷新列表看看，别直接再建');}}
function restoreGo(go){go.disabled=false;go.replaceChildren(icon('plus'),document.createTextNode('新建'));}

// After creation: open the new chat (history appears once the agent writes it).
async function createDone(r,text,label){
 if(r.state==='failed'){createFailed(r,text,label);return;}
 const seen=r.state==='ready'||r.state==='blocked'||r.detected;
 if(!seen){toast('标签页开好了，'+label+' 还在启动，出来后自动打开');createWatch(r,text,label);return;}
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
// The agent had not shown up yet: look a few times, then open it (only if the person is still on the list).
function createWatch(r,text,label){
 clearInterval(NEW.watch);let n=0;
 NEW.watch=setInterval(async()=>{
  if(++n>14||!S.device){clearInterval(NEW.watch);if(n>14)toast(label+' 还没出现，去电脑上看看那个标签页');return;}
  try{const s=await remote('status',{session:S.session});const a=s.agents.find(x=>x.pane_id===r.pane_id&&x.agent);
   if(!a)return;clearInterval(NEW.watch);
   if(S.tab==='live'&&!S.chat&&!overlay.childElementCount)await createOpen(r.pane_id,text);
   else toast(label+' 起来了，在会话列表里');}catch(_){}},3000);}
function createFailed(r,text,label){
 const box=sheet(label+' 没起来');
 box.append(el('p','muted','新标签页已经开好了（'+r.pane_id+'），但 '+label+' 没启动成功'+(r.detail?'：'+r.detail:'')+'。'),
  el('p','fine',(r.typed?'启动命令可能已经输进去了，':'')+'标签页留在电脑上，没有关掉。'+(text?'第一条消息没发。':'')));
 const row=el('div','sheet-actions');row.append(btn('知道了','secondary',closeSheet),btn('去终端看看','primary',()=>{closeSheet();setTab('terminals');},'terminal'));box.append(row);}
