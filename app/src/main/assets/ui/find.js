'use strict';
// Find in a conversation (「对话操作 → 在对话里搜索」, Ctrl+F) and in the file viewer (fileview.js).
//  · Hits are <mark> elements wrapped around existing text nodes (no HTML strings), found per
//    visual block, so a hit may span **bold** or `code` pieces of one paragraph.
//  · In a chat the loaded messages are searched as data first (prompts, replies, progress notes,
//    tool commands and output), and the folded 「工作过程」 / tool rows holding a hit are opened so
//    the hit can be shown. Whatever search opened closes again when the search closes.
//  · The counter runs from the newest hit in a chat (Enter = next = further back) and from the
//    top in a file. When the loaded pages run out, earlier pages load until a hit turns up.
const FIND_INLINE=new Set(['SPAN','STRONG','EM','CODE','B','I','DEL','S','SMALL','MARK','A','SUB','SUP','KBD','LABEL']);
const FIND_SKIP='button:not(.file-chip):not(.sub-chip),svg,textarea,input,.find-bar,.message-label,.work-time,.notice-time,.tool-state,.chev,.spinner,.code-bar,.fv-no,.msg-acts';
const FIND_MAX=999;
const findTick=()=>new Promise(r=>setTimeout(r,0));

// ─── Marking ────────────────────────────────────────────────────────────────
function findBlock(n){let p=n.parentElement;while(p&&FIND_INLINE.has(p.tagName))p=p.parentElement;return p;}
// Wraps every occurrence of q under root; returns hits (arrays of <mark> pieces) in document order.
function findMark(root,q){
 const hits=[];if(!root||!q)return hits;
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT,{acceptNode:n=>n.nodeType===1?(n.matches(FIND_SKIP)?NodeFilter.FILTER_REJECT:n.tagName==='BR'?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_SKIP):NodeFilter.FILTER_ACCEPT});
 const groups=[];let g=null;
 for(let n=walker.nextNode();n;n=walker.nextNode()){
  if(n.nodeType===1){g=null;continue;}
  const b=findBlock(n);if(!g||g.block!==b){g={block:b,nodes:[],text:''};groups.push(g);}
  g.nodes.push([n,g.text.length]);g.text+=n.data;}
 const needle=q.toLowerCase();
 for(const grp of groups){
  const low=grp.text.toLowerCase(),hay=low.length===grp.text.length?low:grp.text,want=hay===low?needle:q;
  const found=[];for(let at=hay.indexOf(want);at>=0&&found.length<FIND_MAX;at=hay.indexOf(want,at+want.length))found.push(at);
  if(!found.length)continue;
  const local=[];
  // Last match first: splitting a text node keeps the offsets of everything before the split.
  for(let k=found.length-1;k>=0;k--){const s=found[k],e=s+want.length,pieces=[];
   for(let j=grp.nodes.length-1;j>=0;j--){const [node,off]=grp.nodes[j],len=node.data.length;
    if(off>=e||off+len<=s)continue;
    const a=Math.max(0,s-off),z=Math.min(len,e-off);let t=node;
    if(z<t.data.length)t.splitText(z);if(a>0)t=t.splitText(a);
    const m=document.createElement('mark');m.className='find-hit';t.replaceWith(m);m.append(t);pieces.unshift(m);}
   if(pieces.length)local.unshift(pieces);}
  hits.push(...local);
  if(hits.length>=FIND_MAX)break;}
 return hits;}
function findUnmark(root){if(!root)return;const parents=new Set();
 root.querySelectorAll('mark.find-hit').forEach(m=>{const p=m.parentNode;if(!p)return;m.replaceWith(...m.childNodes);parents.add(p);});
 parents.forEach(p=>p.normalize());}
const findVisible=hit=>hit.some(m=>m.getClientRects().length>0);
function findUnwrap(hit){hit.forEach(m=>{const p=m.parentNode;if(!p)return;m.replaceWith(...m.childNodes);p.normalize();});}

// ─── Find bar ───────────────────────────────────────────────────────────────
// o: {root:()=>Element, mount:bar=>void, label, placeholder, fromEnd, prepare?:async q=>void,
//     more?:{has:()=>bool, load:async()=>bool}, watch?:bool, onClose?:()=>void}
function makeFinder(o){
 paths.up=paths.up||'M6 15l6-6 6 6';
 const F={q:'',hits:[],i:-1,token:0,seq:0,busy:false,opened:new Map(),loading:0,closed:false,observer:null,timer:0};
 const bar=el('div','find-bar');bar.setAttribute('role','search');bar.setAttribute('aria-label',o.label);
 const row=el('div','find-row'),field=el('label','find-field');
 const input=el('input');input.type='text';input.placeholder=o.placeholder;input.setAttribute('aria-label',o.label);input.enterKeyHint='search';input.autocomplete='off';input.spellcheck=false;
 field.append(icon('search'),input);
 const count=el('span','find-count');count.setAttribute('aria-live','polite');
 const up=ib('up','上一处',()=>step(-1,true)),down=ib('down','下一处',()=>step(1,true)),close=ib('close','关闭搜索',()=>F.close());
 up.classList.add('find-nav');down.classList.add('find-nav');
 row.append(field,count,up,down,close);
 const moreRow=el('div','find-more hidden'),moreText=el('span','grow'),moreBtn=btn('加载更早的记录继续找','find-more-btn',()=>F.loading?stopLoading():loadMore());
 moreRow.append(icon('history'),moreText,moreBtn);bar.append(row,moreRow);
 let typing=0;
 input.oninput=()=>{clearTimeout(typing);typing=setTimeout(()=>{F.q=input.value;stopLoading();run(false);},180);};
 input.onkeydown=e=>{
  if(e.key==='Escape'){e.preventDefault();F.close();return;}
  if(e.key==='Enter'){e.preventDefault();if(F.q!==input.value){clearTimeout(typing);F.q=input.value;run(false);return;}next(e.shiftKey?-1:1);}};
 // Navigation order: in a chat the newest hit is 1 and "next" goes further back.
 const order=k=>o.fromEnd?F.hits.length-1-k:k;
 function next(d){step(o.fromEnd?-d:d,false);}
 function step(d){
  if(!F.hits.length){if(F.q&&o.more?.has())loadMore();return;}
  let i=F.i+d;
  if(i<0){if(o.more?.has()){loadMore();return;}if(o.fromEnd){toast('已经是最早的一处');return;}i=F.hits.length-1;}
  if(i>=F.hits.length){if(o.fromEnd){toast('已经是最新的一处');return;}i=0;}
  go(i);}
 function paint(){
  const n=F.hits.length,q=F.q;
  count.textContent=!q?'':n?(order(F.i)+1)+'/'+(n>=FIND_MAX?FIND_MAX+'+':n):'无结果';
  count.classList.toggle('none',!!q&&!n);
  const can=n>0||!!(q&&o.more?.has());
  up.disabled=!can;down.disabled=!n;
  const show=!!q&&!!o.more&&(F.loading||o.more.has()&&(!n||F.i===0));
  moreRow.classList.toggle('hidden',!show);
  if(F.loading){moreText.textContent='正在加载更早的记录… 第 '+F.loading+' 页';moreBtn.textContent='停止';}
  else{moreText.textContent=n?'更早的记录还没加载':'已加载的记录里没找到';moreBtn.textContent='加载更早的记录继续找';}}
 function go(i){
  const prev=F.hits[F.i];if(prev)prev.forEach(m=>m.classList.remove('current'));
  F.i=i;const hit=F.hits[i];if(!hit){paint();return;}
  hit.forEach(m=>m.classList.add('current'));
  F.busy=true;
  reveal(hit[0]);
  hit[0].scrollIntoView({block:'center',inline:'nearest',behavior:document.documentElement.classList.contains('reduce-motion')||matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  F.observer?.takeRecords();F.busy=false;paint();}
 // Folded or clipped places around a hit open up so it can be seen.
 function reveal(m){
  for(let d=m.closest('details');d;d=d.parentElement?.closest('details'))if(!d.open)openD(d);
  const fold=m.closest('.md-fold');if(fold&&!fold.classList.contains('open')&&!fold.classList.contains('short'))fold.querySelector(':scope > .md-more')?.click();
  const code=m.closest('.code-block.clipped');if(code)code.querySelector(':scope > .code-more')?.click();
  const bubble=m.closest('.bubble.clamped');if(bubble)bubble.parentElement?.querySelector(':scope > .prompt-more')?.click();}
 function openD(d){if(d.open)return;d.open=true;F.opened.set(d,d.dataset.key||'');}
 F.open=openD;
 function restore(){
  const root=o.root();
  F.opened.forEach((key,d)=>{const live=d.isConnected?d:key&&root?root.querySelector('details[data-key="'+CSS.escape(key)+'"]'):null;if(live)live.open=false;});
  F.opened.clear();}
 // keep: re-mark after the page changed (new messages, earlier pages) and stay on the same hit.
 async function run(keep){
  const seq=++F.seq,root=o.root();if(!root)return;
  F.busy=true;
  let anchor=null;
  if(keep&&F.hits[F.i]){const m=F.hits[F.i][0],sec=m.closest('[data-id]');const inSec=sec?F.hits.filter(h=>sec.contains(h[0])):[];anchor={id:sec?.dataset.id,nth:inSec.indexOf(F.hits[F.i]),back:F.hits.length-1-F.i};}
  findUnmark(root);F.hits=[];
  if(!keep)restore();
  const q=F.q;
  if(q&&o.prepare){await o.prepare(q,openD);if(seq!==F.seq||F.closed)return;}
  const fresh=o.root();if(!fresh){F.busy=false;return;}
  const all=findMark(fresh,q);
  F.hits=all.filter(h=>{if(findVisible(h))return true;findUnwrap(h);return false;});
  // What search opened but holds no hit closes again.
  F.opened.forEach((key,d)=>{if(d.isConnected&&!d.querySelector('mark.find-hit')){d.open=false;F.opened.delete(d);}});
  F.observer?.takeRecords();F.busy=false;
  if(!F.hits.length){F.i=-1;paint();return;}
  let i=o.fromEnd?F.hits.length-1:0;
  if(anchor){const sec=anchor.id?fresh.querySelector('[data-id="'+CSS.escape(anchor.id)+'"]'):null;const inSec=sec?F.hits.filter(h=>sec.contains(h[0])):[];
   i=inSec[anchor.nth]?F.hits.indexOf(inSec[anchor.nth]):Math.max(0,F.hits.length-1-anchor.back);
   F.i=i;F.hits[i].forEach(m=>m.classList.add('current'));paint();return;}
  // A page change without a current hit selects quietly; only a new query scrolls.
  if(keep){F.i=i;F.hits[i].forEach(m=>m.classList.add('current'));paint();return;}
  if(!o.fromEnd){const top=fresh.getBoundingClientRect().top;const k=F.hits.findIndex(h=>h[0].getBoundingClientRect().bottom>=top);if(k>0)i=k;}
  go(i);}
 F.refresh=()=>{if(F.closed||!F.q||F.busy||F.loading)return;clearTimeout(F.timer);F.timer=setTimeout(()=>run(true),300);};
 // Earlier pages, one at a time, until a new hit appears (or the record starts, or 30 pages).
 async function loadMore(){
  if(F.loading||!o.more?.has())return;const token=F.token;const before=F.hits.length;let pages=0;
  F.loading=1;paint();
  try{
   while(o.more.has()&&pages<30){F.loading=pages+1;paint();
    const ok=await o.more.load();if(token!==F.token||F.closed||!F.loading)return;if(!ok)break;pages++;
    await run(true);if(token!==F.token||F.closed)return;
    if(F.hits.length>before)break;}}
  finally{if(token===F.token&&!F.closed){F.loading=0;paint();}}
  const added=F.hits.length-before;
  if(added>0)go(o.fromEnd?added-1:F.hits.length-added);
  else toast(S.chat?.historyError||(o.more.has()?'翻了 30 页还没找到，可以继续加载':'到记录起点了，没有更多结果'));}
 function stopLoading(){if(F.loading){F.loading=0;F.token++;paint();}}
 F.watch=root=>{F.observer?.disconnect();if(!o.watch||!root)return;F.observer=new MutationObserver(()=>{if(!F.busy)F.refresh();});F.observer.observe(root,{childList:true,subtree:true});};
 F.close=()=>{if(F.closed)return;F.closed=true;F.token++;clearTimeout(F.timer);clearTimeout(typing);F.observer?.disconnect();
  findUnmark(o.root());restore();bar.remove();o.onClose?.();};
 F.bar=bar;F.input=input;F.run=run;F.focus=()=>{input.focus();input.select();};
 o.mount(bar);F.watch(o.root());paint();
 return F;}

// ─── In a conversation ──────────────────────────────────────────────────────
const FIND={finder:null,chat:null,appWatch:null};
const FIND_TEXT=new WeakMap();
function findText(m){let t=FIND_TEXT.get(m);if(t===undefined){
 t=String(m.text||'');if(m.kind==='tool')try{t+='\n'+toolInput(m);}catch(_){}
 if(m.kind==='user')t=promptText(t);t=(t+'\n'+(m.title||'')).toLowerCase();FIND_TEXT.set(m,t);}return t;}
// Opens the 「工作过程」 blocks, tool rows and notices whose messages contain q (the bodies are
// built only when opened, so the text is not in the page before that).
async function findChatPrepare(q,open){
 const body=document.getElementById('chat-scroll');if(!body||S.chatMode==='terminal')return;
 const needle=q.toLowerCase(),match=new Set();
 for(const m of S.messages)if(findText(m).includes(needle))match.add(m.id);
 if(!match.size)return;
 const callOf=new Map();S.messages.forEach(m=>{if(m.kind==='tool'&&m.call_id)callOf.set(m.call_id,m.id);});
 S.messages.forEach(m=>{if(m.kind==='result'&&match.has(m.id)&&callOf.has(m.call_id))match.add(callOf.get(m.call_id));});
 const at=new Map(S.messages.map((m,i)=>[m.id,i]));
 const secs=[...body.querySelectorAll('section.turn[data-id]')];
 secs.forEach((sec,k)=>{const a=at.get(sec.dataset.id);if(a===undefined)return;const b=k+1<secs.length?at.get(secs[k+1].dataset.id)??S.messages.length:S.messages.length;
  for(let j=a;j<b;j++)if(match.has(S.messages[j].id)){const w=sec.querySelector(':scope > details.work');if(w)open(w);break;}});
 await findTick();await findTick();
 body.querySelectorAll('details.tool-row[data-id]').forEach(d=>{if(!match.has(d.dataset.id))return;const g=d.closest('details.tool-group');if(g)open(g);open(d);});
 body.querySelectorAll('details.notice-row[data-key]').forEach(d=>{if(match.has(d.dataset.key.replace(/^(notice|agent):/,'')))open(d);});
 await findTick();await findTick();}
async function findChatMore(){
 for(let k=0;S.polling&&k<200;k++)await new Promise(r=>setTimeout(r,50));
 if(!S.more||S.polling)return false;const n=S.messages.length;
 await fetchHistory(true);return S.messages.length>n;}
function findOpen(){
 if(!S.chat||!document.getElementById('chat-head'))return;
 if(FIND.finder&&FIND.finder.bar.isConnected&&FIND.chat===S.chat){FIND.finder.focus();return;}
 FIND.finder?.close();FIND.chat=S.chat;
 const f=makeFinder({label:'搜索对话',placeholder:'在这段对话里找',fromEnd:true,watch:true,
  root:()=>document.getElementById('chat-scroll'),
  mount:bar=>document.getElementById('chat-head')?.after(bar),
  prepare:findChatPrepare,
  more:{has:()=>!!(S.more&&S.chat?.record&&S.chatMode!=='terminal'&&!S.chat.cached),load:findChatMore},
  onClose:()=>{if(FIND.finder===f){FIND.finder=null;FIND.chat=null;}}});
 FIND.finder=f;f.focus();
 // A repaint of the whole chat (tab switch, reconnect) drops the bar: put it back, or close it
 // when another chat (or another screen) opened.
 if(!FIND.appWatch){FIND.appWatch=new MutationObserver(()=>{const fd=FIND.finder;if(!fd||fd.bar.isConnected)return;
   const head=document.getElementById('chat-head');
   if(!head||S.chat!==FIND.chat){fd.close();return;}
   head.after(fd.bar);fd.watch(document.getElementById('chat-scroll'));if(fd.input.value)fd.run(true);});
  FIND.appWatch.observe(app,{childList:true});}}
document.addEventListener('keydown',e=>{
 if(!(e.ctrlKey||e.metaKey)||e.altKey||e.key.toLowerCase()!=='f')return;
 const viewer=document.querySelector('.fv-sheet');
 if(viewer){e.preventDefault();viewer.dispatchEvent(new CustomEvent('fv-find'));return;}
 if(S.chat&&document.getElementById('chat-head')&&!overlay.firstElementChild){e.preventDefault();findOpen();}});
