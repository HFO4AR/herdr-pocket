'use strict';
// Two-pane layout for tablets and unfolded foldables. Loaded after app.js; it wraps the shell
// instead of changing it, so the phone layout (and everything that renders into it) stays as is.
//
// Wide = at least 840 px wide on a device whose short side is at least 600 px (Android's
// tablet line). The short side comes from the screen, not the window, so an on-screen keyboard
// shrinking the window never flips the layout while you type; landscape phones stay single-pane.
//
// Wide frame: a navigation rail (the same nav buttons, moved), the 会话 / 历史 list, and the open
// conversation (or a "选一个会话" placeholder) side by side. Other tabs use rail + one column.
// render() paints the list and the right pane; renderChat() only repaints the right pane, so
// opening, closing and switching chats never rebuilds the list (scroll and filters stay).
const LAYOUT={wide:false,frame:null,target:null,tab:'',sig:'',pendingList:false};
function layoutWide(){const short=Math.min(screen.width||innerWidth,screen.height||innerHeight);return innerWidth>=840&&short>=600;}
LAYOUT.wide=layoutWide();
function splitTab(){return S.tab==='live'||S.tab==='history';}

(function(){
 const baseShell=shell,baseRender=render,baseRenderChat=renderChat,baseAgentRow=agentRow,baseHistoryRow=historyRow,
  baseOpenAgent=openAgent,baseOpenRecord=openRecord,baseRefreshStatus=refreshStatus,baseLoadLive=loadLive,baseLoadCatalog=loadCatalog;
 const L=LAYOUT;

 function frame(){
  if(L.frame&&L.frame.root.parentNode===app)return L.frame;
  const root=el('div','wide-frame');const banner=el('div','demo-banner wide-banner','离线演示 · 示例数据，不连接电脑');
  const rail=el('aside','wide-rail');rail.setAttribute('aria-label','导航');
  const list=el('section','wide-list');const detail=el('section','wide-detail');detail.setAttribute('aria-label','对话');
  root.append(banner,rail,list,detail);app.replaceChildren(root);
  L.frame={root,banner,rail,list,detail};L.tab='';L.sig='';return L.frame;}
 function setMode(mode){const f=frame();f.root.dataset.mode=mode;f.root.classList.toggle('has-banner',!!S.demo);
  const de=document.documentElement;de.classList.add('wide-on');de.classList.toggle('wide-split',mode==='split'&&!!S.chat);de.classList.toggle('wide-focus',mode==='focus');}
 function narrow(){L.frame=null;L.tab='';const de=document.documentElement;de.classList.remove('wide-on','wide-split','wide-focus');}

 // The shell goes into whichever pane is being painted; anything else (the full terminal view)
 // takes the content column next to the rail.
 shell=function(){
  if(!L.wide){narrow();return baseShell();}
  const f=frame();let host=L.target;
  if(!host){host=f.list;setMode('solo');f.detail.replaceChildren();}
  host.replaceChildren();const root=el('div','shell');host.append(root);return root;};

 render=function(){
  if(!L.wide)return baseRender();
  if(!S.chat&&typeof T!=='undefined'&&T.view){renderTerminal();return;}
  const split=splitTab();frame();setMode(S.chat&&!split?'focus':split?'split':'solo');
  paintList();
  if(S.chat)paintChat();else if(split)paintEmpty();else L.frame.detail.replaceChildren();};

 renderChat=function(){
  if(!L.wide)return baseRenderChat();
  const f=frame(),want=splitTab()?'split':'focus';
  if(f.root.dataset.mode!==want||!f.rail.firstChild||L.tab!==S.tab){render();return;}
  setMode(want);paintChat();};

 // The list pane: the regular page with the chat hidden from it, nav moved into the rail.
 // Repaints of the same tab keep the scroll position and skip the entrance animation.
 function paintList(){
  const f=L.frame,same=L.tab===S.tab,old=f.list.querySelector('.main'),top=same&&old?old.scrollTop:0;
  const chat=S.chat;S.chat=null;L.target=f.list;
  try{baseRender();}finally{S.chat=chat;L.target=null;}
  const nav=f.list.querySelector('.bottom-nav');if(nav){nav.classList.add('rail-nav');f.rail.replaceChildren(nav);}
  const main=f.list.querySelector('.main');if(main&&same){main.classList.remove('pane-enter');main.scrollTop=top;}
  L.tab=S.tab;L.sig=listSig();L.pendingList=false;markSelected();}

 function paintChat(){
  const f=L.frame;L.target=f.detail;
  try{baseRenderChat();}finally{L.target=null;}
  // Two panes: the list never goes away, so the header button closes the chat (or steps back
  // out of a sub-agent you drilled into).
  const back=f.detail.querySelector('#chat-head > .icon-btn');
  if(back){const label=S.chatStack.length?'返回上一层':'关闭对话';back.setAttribute('aria-label',label);back.title=label;if(!S.chatStack.length)back.replaceChildren(icon('close'));}
  f.detail.firstElementChild?.classList.add('pane-enter');
  document.documentElement.classList.toggle('wide-split',f.root.dataset.mode==='split');
  markSelected();}

 // Right pane with nothing open: what to do, and the agents that are waiting for you.
 function paintEmpty(){
  const f=L.frame,live=S.tab==='live',box=el('div','wide-empty pane-enter');box.setAttribute('role','note');
  const art=el('div','wide-empty-art');art.append(icon(live?'chat':'history'));box.append(art);
  if(!S.device&&!(typeof cacheBrowsing==='function'&&cacheBrowsing())){
   box.append(el('h2','',S.loading?'正在连接你的电脑':'还没连上电脑'),el('p','',S.loading?'连上后，会话在左边，对话在这里打开。':'先在「设备」里连一台电脑。会话在左边，对话在这里打开。'));}
  else if(live){
   box.append(el('h2','','选一个会话'),el('p','','点左边的 Agent，对话在这里打开，列表一直都在。'));
   const waiting=sortAgents(S.agents.filter(a=>a.agent_status==='blocked')).slice(0,3);
   if(waiting.length){const card=el('div','wide-wait');card.append(el('div','wide-wait-head',waiting.length===1?'有 1 个在等你确认':'有 '+waiting.length+' 个在等你确认'));
    waiting.forEach(a=>{const b=btn('','wide-wait-row',()=>openAgent(a));const t=el('span','grow');t.append(el('span','wide-wait-title',titleOf(a)),el('small','',projectOf(a)||providerName(a.agent)));b.append(avatar(a.agent,'alert'),t,icon('chevron'));card.append(b);});
    box.append(card);}}
  else box.append(el('h2','','选一条历史'),el('p','','点左边的记录，在这里只读查看。想接着聊，去「会话」打开在线的 Agent。'));
  const hint=el('p','wide-keys');hint.append(el('kbd','','Ctrl'),' + ',el('kbd','','Enter'),' 发送 · 返回键关闭对话');box.append(hint);
  f.detail.replaceChildren(box);}

 // Rows carry what they open, so the open one can be highlighted.
 function tagRow(wrap,key){const b=wrap.matches('.card-button')?wrap:wrap.querySelector('.card-button');if(b)b.dataset.sel=key;return wrap;}
 agentRow=function(a){return tagRow(baseAgentRow(a),'a:'+agentKey(a));};
 historyRow=function(r,hidden){return tagRow(baseHistoryRow(r,hidden),'r:'+r.id);};
 function selectedKey(){const c=S.chatStack[0]||S.chat;if(!c)return '';return c.agent?'a:'+S.session+'/'+c.agent.identity:c.record?'r:'+c.record.id:'';}
 function markSelected(){
  if(!L.frame)return;const k=selectedKey();
  L.frame.list.querySelectorAll('[data-sel]').forEach(b=>{const on=!!k&&b.dataset.sel===k;b.classList.toggle('is-selected',on);if(on)b.setAttribute('aria-current','true');else b.removeAttribute('aria-current');});}

 // Tapping the row that is already open keeps the conversation (and where you were in it).
 openAgent=function(a){
  if(L.wide&&S.chat?.agent&&!S.chat.stale&&!S.chatStack.length&&agentKey(S.chat.agent)===agentKey(a)){S.unread.delete(agentKey(a));markSelected();return Promise.resolve();}
  return baseOpenAgent(a);};
 openRecord=function(r,push=false){
  if(L.wide&&!push&&!S.chatStack.length&&S.chat&&!S.chat.agent&&S.chat.record?.id===r.id)return;
  return baseOpenRecord(r,push);};

 // The list stays on screen while a chat is open, so status changes repaint it too — unless
 // you are typing in its search box, have a row swiped open, or a sheet is up.
 function listSig(){return S.tab+'|'+S.session+'|'+S.agents.map(a=>a.pane_id+'/'+a.identity+'/'+agentState(a)+'/'+(kidsOf(a)?.total||0)+'/'+titleOf(a)+(S.unread.has(agentKey(a))?'/u':'')).join(',');}
 function listBusy(){const f=L.frame,a=document.activeElement;return overlay.childElementCount>0||(a&&f.list.contains(a)&&/^(INPUT|TEXTAREA)$/.test(a.tagName))||!!f.list.querySelector('.swipe.open,.swipe.dragging');}
 function refreshList(force){
  if(!L.wide||!L.frame||!S.chat||!splitTab()||L.frame.root.dataset.mode!=='split')return;
  if(!force&&S.tab==='live'&&listSig()===L.sig&&!L.pendingList)return;
  if(listBusy()){L.pendingList=true;return;}
  paintList();}
 refreshStatus=async function(...args){const r=await baseRefreshStatus(...args);if(S.tab==='live')refreshList(false);return r;};

 // A list load that something else superseded (opening a chat bumps S.epoch) used to leave its
 // loading flag set, which also stopped the status refresh. Clear it when no newer load runs.
 let liveRun=0,catalogRun=0;
 function rescueChat(){if(L.wide&&S.chat?.record&&!S.messages.length&&!S.polling)fetchHistory(false,true);}
 loadLive=async function(...args){const t=++liveRun;try{return await baseLoadLive(...args);}
  finally{if(t===liveRun){if(S.liveLoading)S.liveLoading=false;if(S.chat&&S.tab==='live'){refreshList(true);rescueChat();}}}};
 loadCatalog=async function(...args){const t=++catalogRun;try{return await baseLoadCatalog(...args);}
  finally{if(t===catalogRun){if(S.catalogLoading)S.catalogLoading=false;if(L.wide&&S.chat&&S.tab==='history'&&L.frame){renderHistoryList();markSelected();rescueChat();}}}};

 // Rotation, split-screen and window resizes switch layouts in place: the open chat, drafts
 // (kept in S.drafts) and the reading position survive; nothing is fetched again.
 // The reading position is kept as "this message at this height", not as pixels: line wraps
 // change with the width. Timeline nodes are reused across repaints (timeline.js TL_KEEP).
 // It is noted while you scroll at a settled width; once the window starts resizing, the
 // browser's own scroll anchoring moves things around, so that is ignored.
 function readingAnchor(body){
  const top=body.getBoundingClientRect().top;let best=null;
  for(const n of body.querySelectorAll('.timeline > *, .timeline article, .timeline details')){const r=n.getBoundingClientRect();
   if(r.bottom<=top+1)continue;if(r.top<=top+1){best=n;continue;}if(!best)best=n;break;}
  return best?{node:best,offset:best.getBoundingClientRect().top-top}:null;}
 let anchorW=innerWidth,anchor=null,anchorFrame=0;
 document.addEventListener('scroll',e=>{if(e.target.id!=='chat-scroll'||innerWidth!==anchorW||anchorFrame)return;
  anchorFrame=requestAnimationFrame(()=>{anchorFrame=0;const b=document.getElementById('chat-scroll');if(b&&innerWidth===anchorW)anchor=readingAnchor(b);});},true);
 function relayout(){
  const sc=document.getElementById('chat-scroll'),top=sc?sc.scrollTop:0,stick=S.stick,mark=sc&&!stick&&anchor&&sc.contains(anchor.node)?anchor:null;
  const a=document.activeElement,typing=!!(a&&a.tagName==='TEXTAREA'&&a.closest('#composer'));
  L.frame=null;L.tab='';
  render();
  const n=document.getElementById('chat-scroll');
  if(n){S.stick=stick;if(stick)n.scrollTop=n.scrollHeight;else if(mark&&n.contains(mark.node))n.scrollTop+=mark.node.getBoundingClientRect().top-n.getBoundingClientRect().top-mark.offset;else n.scrollTop=top;
   if(typeof updateJump==='function')updateJump();}
  anchorW=innerWidth;anchor=n&&!stick?readingAnchor(n):null;
  if(typing)document.querySelector('#composer textarea')?.focus();
  if(L.wide)L.frame?.list.querySelector('.is-selected')?.scrollIntoView?.({block:'nearest'});}
 // Only a change between one and two panes repaints, so this runs right away (no debounce:
 // nothing should be able to grab a node that is about to be replaced).
 addEventListener('resize',()=>{const w=layoutWide();if(w===L.wide){anchorW=innerWidth;return;}L.wide=w;relayout();});
 LAYOUT.relayout=relayout;LAYOUT.mark=markSelected;LAYOUT.refreshList=refreshList;
})();
