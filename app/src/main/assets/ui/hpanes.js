'use strict';
// Herdr's plain terminals in 会话: every Herdr pane without an agent Herdr lists (shells, servers,
// builds, logs…), as a 「Herdr 终端」 section between the agents and tmux. The 终端 tab lists the
// same panes; here they sit next to the conversations, the way tmux sessions do.
//  · No poll of their own: the list asks for them with the agents it already reads (bridge
//    `agents` / `status` with `panes: true`, only while 会话 is on screen, on a tablet also beside an
//    open chat). Each pane comes with its tab label and what runs in front (`kind`, `foreground`:
//    a process name, never arguments).
//  · Left out: panes Herdr lists as agents (pane id in S.agents), ch panes (kind `ch`: ch's relay
//    or SSH attach whose agent Herdr does not list right now, e.g. while it reconnects; their agent
//    row comes back by itself, and a terminal row in between would only flicker) and Herdr clients
//    (kind `herdr`: Herdr inside Herdr). A pane whose foreground is a tmux client is left out while
//    the tmux section lists panes: that session is there already, read straight from tmux; with no
//    tmux list (another user's server, an old bridge) it stays, tagged tmux.
//  · A row opens straight on that pane's terminal (terminals.js openPane: screen, key bar, input,
//    each input with its own UUID, an unconfirmed one pauses and is never resent).
//  · Swipe / long press: 打开终端, 复制目录, 新建终端 (a new tab in the same workspace and directory,
//    bridge `create` with kind `shell`), 关闭窗格 (close.js closeSession: the same sheet, closeInfo
//    identity check and receipt as for an agent's pane).
//  · Repaints only when what the section shows changed, and never under a row swiped open, a sheet
//    or typing: then it waits for the next answer.
const HP={by:new Map(),all:false,creating:false};
const HP_RECENT=10*60*1000,HP_FOLD=8,HP_FOLDED=6;
const HP_PANE_RE=/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/;
function hpKey(dev=S.device?.id||'',session=S.session){return dev&&session?dev+'|'+session:'';}
// Per computer and Herdr session (several computers can be connected at once).
function hpState(key=hpKey()){if(!key)return null;let st=HP.by.get(key);
 if(!st){st={panes:[],loaded:false,sig:'',dirty:false,seen:new Map()};HP.by.set(key,st);}return st;}
// Whether the next list read should bring the panes: the list is (or stays) on screen.
function hpWant(){if(S.demo||!S.device||S.herdr===false||S.tab!=='live'||!S.session)return false;
 if(typeof T!=='undefined'&&T.view)return false;return !S.chat||(typeof LAYOUT!=='undefined'&&LAYOUT.wide);}
// What the shell's title or the bridge says runs there.
function hpKind(p){if(typeof p?.kind==='string'&&p.kind)return p.kind;
 const cmd=paneInfo(p).cmd;return /^ch(\s|$)/.test(cmd)?'ch':/^herdr(\s|$)/.test(cmd)?'herdr':/^tmux(\s|$)/.test(cmd)?'tmux':'';}
function hpMark(p){return [p.identity,p.terminal_title_stripped||p.terminal_title||'',p.foreground||'',p.kind||'',p.foreground_cwd||p.cwd||''].join('|');}
// Takes a pane list from an answer (undefined: the bridge could not list them, keep the last one).
// Returns true when the section would look different.
function hpTake(list,dev=S.device?.id||'',session=S.session){
 const st=hpState(hpKey(dev,session));if(!st||!Array.isArray(list))return false;
 const now=Date.now(),panes=list.filter(p=>HP_PANE_RE.test(p?.pane_id||'')&&typeof p.identity==='string');
 for(const p of panes){const m=hpMark(p),old=st.seen.get(p.pane_id);
  // First sight is not news; a pane that turns up later, or whose command / title / directory changes, is.
  if(!old)st.seen.set(p.pane_id,{mark:m,at:st.loaded?now:0});else if(old.mark!==m)st.seen.set(p.pane_id,{mark:m,at:now});}
 for(const k of [...st.seen.keys()])if(!panes.some(p=>p.pane_id===k))st.seen.delete(k);
 st.panes=panes;st.loaded=true;
 // The 终端 tab shows the same panes: keep it current too (it reloads its own when opened).
 if(typeof T!=='undefined'&&hpKey(dev,session)===hpKey()&&S.tab!=='terminals')T.panes=panes;
 const sig=hpSig(st);if(sig===st.sig&&!st.dirty)return false;st.sig=sig;return hpKey(dev,session)===hpKey();}
function hpSig(st){const now=Date.now();return st.panes.map(p=>{const at=st.seen.get(p.pane_id)?.at||0;return [p.pane_id,hpMark(p),p.focused?1:0,p.tab_label||'',p.workspace_label||'',at&&now-at<HP_RECENT?at:0].join('/');}).join(',');}
// The rows 会话 shows (see the head comment for what is left out).
function hpVisible(){const st=hpState();if(!st||S.demo||S.herdr===false)return [];
 const agents=new Set(S.agents.map(a=>a.pane_id)),tmuxOn=typeof tmuxPanes==='function'&&tmuxPanes().length>0;
 return st.panes.filter(p=>{const k=hpKind(p);return !agents.has(p.pane_id)&&k!=='ch'&&k!=='herdr'&&!(k==='tmux'&&tmuxOn);});}
function hpRepaint(){
 const st=hpState();if(!st||S.tab!=='live'||(typeof T!=='undefined'&&T.view))return;
 // A tablet keeps the list beside the open chat: layout.js repaints it when nothing is in the way.
 if(S.chat){if(typeof LAYOUT!=='undefined'&&LAYOUT.wide&&LAYOUT.refreshList)LAYOUT.refreshList(true);return;}
 // A row swiped open (关闭 / 更多 showing), a sheet or typing: leave it, the next answer repaints.
 const a=document.activeElement,typing=a&&/^(INPUT|TEXTAREA)$/.test(a.tagName)&&app.contains(a);
 if(overlay.childElementCount||app.querySelector('.swipe.open,.swipe.dragging')||typing){st.dirty=true;return;}
 st.dirty=false;const main=app.querySelector('.main'),top=main?main.scrollTop:0;render();
 const next=app.querySelector('.main');if(next){next.classList.remove('pane-enter');next.scrollTop=top;}}
function hpWhere(p){return shortPath(p.foreground_cwd||p.cwd||'');}
function hpKindTag(k){return k==='ssh'?'SSH':k==='tmux'?'tmux':'';}
function hpRow(p,single){
 const i=paneInfo(p),k=hpKind(p),where=hpWhere(p)||i.dir,seen=hpState()?.seen.get(p.pane_id);
 const recent=seen?.at&&Date.now()-seen.at<HP_RECENT?seen.at:0;
 const b=btn('','card-button term-row hp-row'+(i.idle?' is-idle':''),()=>hpOpen(p));
 b.setAttribute('aria-label','Herdr 终端 '+i.title+(where?' · '+where:'')+(p.focused?' · 电脑屏幕上正显示':''));
 const av=el('div','avatar term-av'+(i.idle?' idle':''));av.append(icon(k==='ssh'?'globe':'terminal'));
 // Something runs in front (not a prompt): the same green dot the live SSH shell has.
 if(!i.idle)av.append(el('span','status-dot ok'));
 const t=el('div','grow');t.append(el('div','card-title term-cmd'+(i.idle?' idle':''),i.title));
 const meta=el('div','card-meta');const tag=hpKindTag(k);if(tag)meta.append(el('span','tag hp-tag',tag));
 meta.append(el('span','hp-where',where));
 if(p.tab_label)meta.append(el('span','sep hp-tab','标签页 '+p.tab_label));
 // One workspace has no group header: its name goes on the row.
 if(single&&p.workspace_label)meta.append(el('span','sep',p.workspace_label));
 t.append(meta);b.append(av,t);
 const side=el('div','row-side');
 if(p.focused){const f=el('span','badge ok hp-focus','当前');f.title='电脑屏幕上正显示这个窗格';side.append(f);}
 else if(recent){const n=since(recent,'ago');n.classList.add('row-time','hp-changed');n.title='刚有变化';side.append(n);}
 if(side.childElementCount)b.append(side);
 closeHold(b,()=>hpActions(p));
 return closeSwipe(b,[['关闭','x','danger',()=>hpClose(p)],['更多','more','',()=>hpActions(p)]]);}
// The section: grouped by workspace; within one, commands first, then shells at their prompt
// (Herdr's order otherwise). Many panes fold to the first few.
function hpSection(main){
 const list=hpVisible();if(!list.length)return;
 const groups=new Map();for(const p of list){const k=p.workspace_label||'工作区';if(!groups.has(k))groups.set(k,[]);groups.get(k).push(p);}
 for(const [k,g] of groups)groups.set(k,g.map((p,i)=>({p,i,idle:paneInfo(p).idle?1:0})).sort((x,y)=>x.idle-y.idle||x.i-y.i).map(x=>x.p));
 const fold=!HP.all&&list.length>HP_FOLD;let left=fold?HP_FOLDED:Infinity;
 const frag=document.createDocumentFragment();
 const label=el('div','section-label group-label hp-label');label.append(el('span','','Herdr 终端'),el('span','group-count',String(list.length)));frag.append(label);
 const single=groups.size<=1;
 for(const [ws,g] of groups){if(left<=0)break;
  if(!single){const w=el('div','ws-label hp-ws','工作区 · '+ws);frag.append(w);}
  const card=el('div','card list-card hp-list');for(const p of g){if(left--<=0)break;card.append(hpRow(p,single));}frag.append(card);}
 if(fold){const more=btn('显示全部 '+list.length+' 个终端','link-btn hp-more',()=>{HP.all=true;hpRepaint();},'down');frag.append(more);}
 // Before tmux (and the row-gesture hint), after the agents.
 const anchor=main.querySelector(':scope>.tmux-label,:scope>.tmux-none-note,:scope>.close-hint');
 if(anchor)main.insertBefore(frag,anchor);else main.append(frag);
 if(!main.querySelector(':scope>.close-hint'))closeHint(main);}
function hpOpen(p){if(typeof openPane!=='function')return;openPane(p);}

// ─── Long press / 更多 ───────────────────────────────────────────────────────
function hpActions(p){
 const i=paneInfo(p),cwd=p.foreground_cwd||p.cwd||'',k=hpKind(p);
 const box=sheet(i.title);
 box.append(el('p','fine close-sub',[hpKindTag(k)||(i.idle?'shell':p.foreground||''),p.workspace_label?'工作区 '+p.workspace_label:'',p.tab_label?'标签页 '+p.tab_label:'',p.focused?'电脑屏幕上正显示':''].filter(Boolean).join(' · ')));
 menuItem(box,'打开终端',()=>hpOpen(p),'terminal','在手机上看、输入，等于在电脑上敲键盘');
 if(cwd)menuItem(box,'复制目录',()=>copyText(cwd),'copy',hpWhere(p));
 if(p.workspace_id)menuItem(box,'新建终端',()=>hpNew(p),'plus','在「'+(p.workspace_label||p.workspace_id)+'」开个新标签页'+(cwd?'，目录 '+hpWhere(p):''));
 menuItem(box,'关闭窗格…',()=>hpClose(p),'x','关掉这个窗格，里面跑的程序会结束');}
// The same close sheet as an agent's pane: closeInfo re-checks the pane's identity first.
function hpClose(p){closeSession({...p,agent:null});}
// 终端选项 of a Herdr pane opened from either list.
function hpMenu(box,entry){const p=entry?.pane;if(!p||entry.ended)return;
 if(p.workspace_id)menuItem(box,'新建终端',()=>hpNew(p),'plus','同一个工作区，新标签页');
 menuItem(box,'关闭窗格…',()=>hpClose(p),'x','关掉这个窗格，里面跑的程序会结束');}

// ─── 新建终端: a new tab with a plain shell in the same workspace ───────────
async function hpNew(p){
 if(S.demo){toast('演示模式：不会真的新建');return;}
 if(!S.device||!S.session){toast('先连接电脑');return;}
 if(HP.creating){toast('上一个还在新建，稍等一下');return;}
 const dev=S.device.id,session=S.session,cwd=p.foreground_cwd||p.cwd||'~';
 HP.creating=true;toast('正在新建终端…');
 try{const r=await remote('create',{session,id:uuid(),kind:'shell',workspace:p.workspace_id,cwd});
  if(!r?.created){toast('没创建：Herdr 没接受');return;}
  if(S.device?.id!==dev||S.session!==session){toast('新终端开好了');return;}
  const np=r.pane&&r.pane.pane_id===r.pane_id&&typeof r.pane.identity==='string'?{...r.pane,kind:'shell'}:null;
  const st=hpState(hpKey(dev,session));
  if(np&&st&&!st.panes.some(x=>x.pane_id===np.pane_id)){st.panes=st.panes.concat(np);st.seen.set(np.pane_id,{mark:hpMark(np),at:Date.now()});st.sig='';}
  if(np&&!S.chat&&!(typeof T!=='undefined'&&T.view)&&!overlay.childElementCount){toast('新终端开好了');hpOpen(np);}
  else{toast('新终端开好了'+(np?'':'，在会话列表里'));hpRepaint();if(!np)refreshStatus();}}
 catch(e){const m=e.message||String(e);
  if(/不支持的 Agent 类型|Unknown operation|不支持的操作/.test(m))toast('没创建：电脑上的桥接程序太旧，到「设备」页重新安装（桥接程序那一行的「…」）');
  else if(/^没创建/.test(m))toast(m);
  // Unknown outcome: a tab may exist now. Never retried on its own.
  else toast('新建结果未知，刷新列表看看，别直接再建');}
 finally{HP.creating=false;}}

(function(){
 const baseLive=livePage,baseAfterPane=closeAfterPane;
 livePage=function(main){baseLive(main);
  if(!S.device||S.liveError||noHerdr()||S.liveLoading&&!S.agents.length)return;hpSection(main);};
 // A closed pane leaves this list (and its terminal, if that is what is open) at once.
 closeAfterPane=function(a,r,info){
  for(const st of HP.by.values()){const n=st.panes.length;st.panes=st.panes.filter(x=>x.pane_id!==a.pane_id);if(st.panes.length!==n)st.sig='';}
  if(typeof T!=='undefined'){T.panes=T.panes.filter(x=>x.pane_id!==a.pane_id);if(T.view?.kind==='pane'&&T.view.pane.pane_id===a.pane_id)leaveTerminal();}
  return baseAfterPane(a,r,info);};
})();
