'use strict';
// tmux sessions on the connected computer (the SSH user's default tmux server, bridge op `tmux`).
// They are listed under the Herdr agents in 会话 and open straight on a terminal screen: there is
// no conversation to read, only the pane. The screen and its input reuse the 终端 view
// (terminals.js renderTerminal, kind 'tmux'): colored screen (tmuxRead → ansi.js), key bar and
// line input (tmuxSend, one UUID per press, never resent; an unconfirmed send pauses input).
// Local panes only: tmux on another computer behind a ch-cli route is not listed.
const TX={dev:'',panes:[],supported:true,loading:false,sig:''};
function tmuxDevice(){return S.device&&!S.demo?S.device.id:'';}
function tmuxPanes(){return TX.dev&&TX.dev===tmuxDevice()?TX.panes:[];}
function tmuxSig(list){return list.map(p=>[p.pane_id,p.identity,p.active,p.command,p.session,p.window_name,p.window_panes].join('/')).join(',');}
async function tmuxLoad(){
 const dev=tmuxDevice();if(!dev)return;
 if(TX.dev!==dev){TX.dev=dev;TX.panes=[];TX.supported=true;TX.sig='';}
 if(!TX.supported||TX.loading)return;TX.loading=true;
 try{const r=await remote('tmux');if(tmuxDevice()!==dev)return;TX.panes=Array.isArray(r?.panes)?r.panes.filter(p=>/^%\d+$/.test(p?.pane_id)&&typeof p.identity==='string'):[];}
 // An older bridge does not know the op: stop asking until the next device. Other failures
 // (tmux hung, a slow link) keep the last list; tmux is a side dish here, never an error card.
 catch(e){if(/Unknown operation|不支持的操作|unexpected remote op/.test(e?.message||''))TX.supported=false;return;}
 finally{if(TX.dev===dev)TX.loading=false;}
 const sig=tmuxSig(TX.panes);if(sig===TX.sig)return;TX.sig=sig;tmuxRepaint();}
// Repaint the list only when nothing is in the way: a sheet, a chat, a terminal, or typing in search.
function tmuxRepaint(){
 if(S.tab!=='live'||S.chat||(typeof T!=='undefined'&&T.view)||overlay.childElementCount)return;
 const a=document.activeElement;if(a&&/^(INPUT|TEXTAREA)$/.test(a.tagName)&&app.contains(a))return;
 const main=app.querySelector('.main'),top=main?main.scrollTop:0;render();
 const next=app.querySelector('.main');if(next){next.classList.remove('pane-enter');next.scrollTop=top;}}
function tmuxTitle(p){return (p.session||'tmux')+':'+(p.window_name||p.window_index);}
function tmuxWhere(p){return shortPath(p.cwd||'');}
// 会话 list: a quiet section after the agents, only when tmux has panes.
function tmuxSection(main){
 const list=tmuxPanes();if(!list.length)return;
 const label=el('div','section-label group-label tmux-label');label.append(el('span','','tmux'),el('span','group-count',String(list.length)));main.append(label);
 const card=el('div','card list-card tmux-list');
 for(const p of list){
  const b=btn('','card-button term-row tmux-row',()=>tmuxOpen(p));b.setAttribute('aria-label','tmux '+tmuxTitle(p)+(p.command?' · '+p.command:'')+(p.active?' · 活动':''));
  const av=el('div','avatar term-av');av.append(icon('terminal'));
  const t=el('div','grow');t.append(el('div','card-title term-cmd',tmuxTitle(p)));
  const meta=el('div','card-meta');meta.append(el('span','tmux-cmd',p.command||'shell'));const where=tmuxWhere(p);if(where)meta.append(el('span','sep',where));
  if(p.window_panes>1)meta.append(el('span','sep','窗格 '+p.pane_index));t.append(meta);
  b.append(av,t);if(p.active){const side=el('div','row-side');side.append(el('span','badge ok','活动'));b.append(side);}
  card.append(b);}
 main.append(card);}
function tmuxOpen(p){termPrefs();termFontVar();
 T.view={kind:'tmux',pane:p,title:tmuxTitle(p),text:'正在读取 tmux 窗格…',ansi:'',draft:'',paused:false,busy:false,demo:false,stick:true,readAt:0};
 renderTerminal();pollTerminal();}
function tmuxSub(entry){const p=entry.pane;return 'tmux · '+[p.command,tmuxWhere(p)].filter(Boolean).join(' · ');}
// Read the pane (called from pollTerminal, which runs every 500 ms): about once a second.
async function tmuxPoll(entry){
 if(Date.now()-entry.readAt<900)return;entry.readAt=Date.now();
 let r;try{r=await remote('tmuxRead',{target:entry.pane.pane_id,identity:entry.pane.identity});}
 catch(e){if(/关了或换了/.test(e.message)&&T.view===entry){entry.ended=true;terminalStatus(entry,'这个 tmux 窗格已经关了，回到列表看看');tmuxLoad();return;}throw e;}
 if(T.view!==entry)return;if(r.pane)entry.pane={...entry.pane,...r.pane};
 if(r.text===entry.text&&(r.ansi||'')===entry.ansi)return;entry.text=r.text;entry.ansi=r.ansi||'';
 const n=document.getElementById('pane-screen');if(!n)return;screenPaint(n,paneText(entry.text),entry.ansi);
 if(entry.stick!==false)n.scrollTop=n.scrollHeight;termJump(entry,true);}
// sendPane's ops, as tmuxSend actions: paneRun = text + Enter, paneText = text, paneKey = a key.
async function tmuxSend(entry,op,args){
 const action=op==='paneKey'?'key':op==='paneRun'?'run':'text';
 const r=await remote('tmuxSend',{target:entry.pane.pane_id,identity:entry.pane.identity,id:uuid(),action,...(action==='key'?{key:args.key}:{text:args.text})});
 entry.readAt=0;return r;}
// 终端选项 extra: wrap or keep the desktop width (the same per-phone choice as the agent screens).
function tmuxMenu(box){
 menuItem(box,ANSI.raw?'自动换行':'原始宽度',()=>{ANSI.raw=!ANSI.raw;ANSI.set=true;cachePut('term:raw',{raw:ANSI.raw});const n=document.getElementById('pane-screen');if(n)n.classList.toggle('raw',ANSI.raw);toast(ANSI.raw?'原始宽度：左右滑动查看':'自动换行');},'terminal',ANSI.raw?'长行折到屏幕宽度':'按电脑上的宽度显示，左右滑动');}

(function(){
 const baseLive=livePage,baseLoad=loadLive;
 livePage=function(main){baseLive(main);if(S.device&&!(S.liveLoading&&!S.agents.length))tmuxSection(main);};
 loadLive=function(...args){tmuxLoad();return baseLoad(...args);};
})();
// The list follows tmux while it is on screen (new sessions, windows renamed, commands changing).
setInterval(()=>{if(S.active&&S.tab==='live'&&!S.chat&&!(typeof T!=='undefined'&&T.view))tmuxLoad();},8000);
