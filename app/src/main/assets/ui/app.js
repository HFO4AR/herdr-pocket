'use strict';
// Herdr Pocket UI. Plain DOM, no innerHTML: every remote string is inserted as text.
// terminals.js shares the helpers and state declared here (S, el, btn, ib, sheet, remote…).

// ─── Icons & DOM helpers ────────────────────────────────────────────────────
const paths={chat:'M6 4h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4V6a2 2 0 0 1 2-2z',history:'M3 12a9 9 0 1 0 3-6M3 3v6h6M12 7v5l3 2',device:'M5 4h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 20h8M12 16v4',account:'M20 21v-2a7 7 0 0 0-14 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',plus:'M12 5v14M5 12h14',back:'M15 5l-7 7 7 7',close:'M6 6l12 12M18 6L6 18',search:'M21 21l-5-5M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16',chevron:'M9 5l7 7-7 7',down:'M6 9l6 6 6-6',send:'M12 19V5M5 12l7-7 7 7',more:'M5 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0M17 12a1 1 0 1 0 2 0a1 1 0 1 0-2 0',terminal:'M4 6l6 6-6 6M12 18h8',branch:'M6 3v12a4 4 0 0 0 8 0V9M10 9l4-4 4 4',refresh:'M20 7a8 8 0 1 0 1 7M20 3v5h-5',lock:'M6 10h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM8 10V7a4 4 0 0 1 8 0v3',check:'M4 12l5 5L20 6',edit:'M16 3l5 5-12 12H4v-5z',folder:'M4 5h5l2 2.5h9a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',pause:'M8 5v14M16 5v14',file:'M6 2h8l5 5v15H6zM14 2v5h5',pen:'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',globe:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',tool:'M14 7a4 4 0 0 0 5 5l-8 8-4-4 8-8z',x:'M7 7l10 10M17 7L7 17',copy:'M9 9h11v11H9zM5 15V4h11',alert:'M12 3l10 18H2zM12 10v5M12 18h.01',stop:'M7 6h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z',plug:'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4',image:'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5h.01',camera:'M3 8h4l2-3h6l2 3h4v11H3zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7',download:'M12 4v11M7 10l5 5 5-5M5 20h14',settings:'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',reply:'M10 8V4L3 11l7 7v-4c5 0 8.5 1.5 11 5-1-5-4-10-11-11z'};
function icon(name){const n=document.createElementNS('http://www.w3.org/2000/svg','svg');n.setAttribute('viewBox','0 0 24 24');n.setAttribute('aria-hidden','true');const p=document.createElementNS(n.namespaceURI,'path');p.setAttribute('d',paths[name]||paths.chat);n.append(p);return n;}
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function btn(text,cls,fn,name){const n=el('button',cls);n.type='button';if(name)n.append(icon(name));if(text)n.append(document.createTextNode(text));n.onclick=fn;return n;}
function ib(name,label,fn){const n=btn('','icon-btn',fn,name);n.setAttribute('aria-label',label);n.title=label;return n;}
function uuid(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&3|8)).toString(16);});}

// ─── Native bridge ──────────────────────────────────────────────────────────
let seq=0;const pending=new Map();
// Requests that belong to one computer name it (several can be connected, onboard.js LINKS): the one on
// screen when the request starts, unless the caller already named one. Native routes by it.
const RPC_DEVICE=new Set(['remote','install','reconnect','uploadImage','uploadFile','image','shellOpen','shellRead','shellWrite','shellResize','shellClose','watchState']);
function rpc(op,args={},progress){if(RPC_DEVICE.has(op)&&args.device===undefined&&S.device&&!S.demo)args={...args,device:S.device.id};return new Promise((resolve,reject)=>{const id='r'+(++seq);pending.set(id,{resolve,reject,progress});try{PocketNative.request(id,op,JSON.stringify(args));}catch(e){pending.delete(id);reject(e);}});}
window.nativeResult=(id,r)=>{const p=pending.get(id);if(!p)return;pending.delete(id);if(r.ok){p.resolve(r.data);return;}const e=new Error(r.error);if(r.code)e.code=r.code;if(r.info)e.info=r.info;p.reject(e);};
window.nativeProgress=(id,stage)=>{pending.get(id)?.progress?.(stage);};
// Connection events pushed by the native layer (silent reconnects); see onboard.js.
window.nativeEvent=e=>netEvent(e);
window.openFromNotification=(pane,device)=>{
 // An alert from a computer that is connected but not on screen: switch to it first.
 if(device&&S.device&&!S.demo&&device!==S.device.id&&linkConnected(device)){const d=S.devices.find(x=>x.id===device)||LINKS.devs.get(device);switchDevice(d,{list:true,quiet:true}).then(()=>{if(S.device?.id===device)window.openFromNotification(pane);});return;}
 S.pendingPane=pane;if(!S.device)return;const a=liveAgents().find(x=>x.pane_id===pane);if(a){openPending();return;}setTab('live');};
// A tmux pane (%N) is looked up in the tmux list, which may still be loading (tmux.js calls this again).
function openPending(){const pane=S.pendingPane;if(!pane||!S.device)return;const a=liveAgents().find(x=>x.pane_id===pane);
 if(!a&&/^%/.test(pane)&&typeof tmuxState==='function'&&!tmuxState()?.loaded)return;
 S.pendingPane=null;if(!a){toast('那个 Agent 已经不在这个会话里了');return;}if(typeof T!=='undefined')leaveTerminal();closeSheet();openAgent(a);}
// The background watcher only notifies about changes after what the UI already showed.
// "kids" counts as working there too; `kids` names each agent's record so the watcher can check
// its sub-agents (read-only glance) before saying 做完了. `asks` are the Codex questions the app
// already shows or that were put aside (暂不回答): the watcher never notifies those (glance.js).
// Agents in tmux panes (tmux.js) are watched too: `tmux: true` makes the watcher's read-only status
// poll list them next to Herdr's (also on a computer without Herdr, where there is no session).
function syncWatch(){if(S.demo||!S.device)return;const all=liveAgents(),c=S.chat?.agent;if(c?.tmux&&!S.chat.stale&&!all.some(a=>a.identity===c.identity))all.push(c);
 const tmux=all.some(a=>a.tmux);if(!S.session&&!tmux)return;
 const states={},kids={};all.forEach(a=>{const k=a.pane_id+'/'+a.identity;states[k]=agentState(a);const it=kidsWatchItem(a);if(it)kids[k]=it;});rpc('watchState',{session:S.session||'',...(tmux?{tmux:true}:{}),states,kids,asks:glanceWatchAsks()}).catch(()=>{});}
// Herdr's agents and the ones found in tmux panes (tmux.js): the switch sheet, alerts, previews.
function liveAgents(){return typeof tmuxAgents==='function'?S.agents.concat(tmuxAgents()):S.agents.slice();}
// Reassignable on purpose: offline tests wrap it to observe requests.
let remote=(op,args={})=>S.demo?demoRequest(op,args):rpc('remote',{op,...args});

// ─── State ──────────────────────────────────────────────────────────────────
const S={tab:'devices',devices:[],device:null,demo:false,version:'',agents:[],session:'',sessions:[],records:[],next:null,total:0,
 chat:null,chatMode:'conversation',messages:[],children:[],before:0,more:false,drafts:new Map(),bindings:new Map(),outbox:[],
 epoch:0,active:true,polling:false,paused:false,loading:false,connecting:null,connectStage:'',connectError:'',liveLoading:false,liveError:'',
 chatStack:[],search:'',filter:'all',account:null,activity:'',statusBusy:false,statusSupported:true,
 since:new Map(),unread:new Set(),stick:true,unseen:0};
const app=document.getElementById('app'),overlay=document.getElementById('overlay');

// ─── Feedback ───────────────────────────────────────────────────────────────
let toastTimer;
function toast(text){const n=document.getElementById('toast');toastSpot(n);n.textContent=text;n.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>{n.classList.remove('show');
 // Empty once faded so screen readers never find an old message (aria-hidden toggling made Android WebView drop the next one).
 toastTimer=setTimeout(()=>{n.textContent='';},400);},4200);}
function error(e){toast(e.message||String(e));}
// An error already written inline where it happened (role=alert in a card or form) is not toasted
// again while that line is on screen; off screen (scrolled away, view changed) the toast still tells it.
function toastUnlessShown(text,sel){const n=[...document.querySelectorAll(sel)].find(x=>x.textContent===text);
 if(n){const r=n.getBoundingClientRect();if(r.height>0&&r.bottom>0&&r.top<innerHeight)return;}toast(text);}
// Where the toast may sit without covering what it talks about: above an open sheet, above the
// composer (with its question card), or under the header when those leave no room.
function toastSpot(n){
 const c=document.getElementById('composer'),sh=document.querySelector('#overlay .sheet');let below=0;
 if(sh)below=sh.offsetHeight+12;else if(c)below=c.offsetHeight+14;
 if(below&&below>innerHeight*(sh?.66:.45)){const head=document.querySelector('.chat-tabs,.app-header,header');n.style.bottom='auto';n.style.top=(sh?12:Math.round(head?head.getBoundingClientRect().bottom+8:12))+'px';}
 else{n.style.top='';n.style.bottom=below?below+'px':'';}}
async function copyText(text){try{await navigator.clipboard.writeText(text);}catch(_){const t=el('textarea');t.value=text;document.body.append(t);t.select();document.execCommand('copy');t.remove();}toast('已复制');}
function sheet(title){dropGhost();overlay.replaceChildren();const back=el('div','sheet-backdrop');const body=el('section','sheet');body.setAttribute('role','dialog');body.setAttribute('aria-modal','true');body.setAttribute('aria-label',title);body.append(el('div','sheet-grip'));const head=el('div','sheet-head');head.append(el('h2','',title),ib('close','关闭',closeSheet));body.append(head);back.append(body);requestAnimationFrame(()=>{const t=document.getElementById('toast');if(t?.classList.contains('show'))toastSpot(t);});back.onclick=e=>{if(e.target!==back)return;if(body.keepOpen&&body.keepOpen()){toast('填的内容还没保存；不要了就点右上角 ×');return;}closeSheet();};overlay.append(back);return body;}
function closeSheet(){ghostSheet();overlay.replaceChildren();const t=document.getElementById('toast');if(t?.classList.contains('show'))toastSpot(t);}
// Exit animation without delaying the real close: an inert copy of the closing sheet lives in a closed
// shadow root (invisible to queries and assistive tech) and slides away on its own.
let sheetGhost=null,ghostCss=null;
function dropGhost(){if(sheetGhost){sheetGhost.remove();sheetGhost=null;}}
function ghostSheet(){dropGhost();const back=overlay.firstElementChild,panel=back&&back.classList.contains('sheet-backdrop')&&back.querySelector('.sheet');
 if(!panel||document.documentElement.classList.contains('reduce-motion')||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
 try{if(!ghostCss){ghostCss=new CSSStyleSheet();ghostCss.replaceSync([...document.querySelectorAll('style')].map(s=>s.textContent).join('\n'));}
  const host=el('div','sheet-ghost');host.setAttribute('aria-hidden','true');host.inert=true;const root=host.attachShadow({mode:'closed'});root.adoptedStyleSheets=[ghostCss];
  const wrap=el('div','sheet-ghost');const copy=back.cloneNode(true);wrap.append(copy);root.append(wrap);document.body.append(host);sheetGhost=host;
  copy.querySelector('.sheet').scrollTop=panel.scrollTop;const done=()=>{if(sheetGhost===host)dropGhost();};copy.querySelector('.sheet').addEventListener('animationend',done);setTimeout(done,400);}
 catch(_){dropGhost();}}
function confirmAction(title,text,label,action,danger){const box=sheet(title);box.append(el('p','muted',text));const row=el('div','sheet-actions');row.append(btn('取消','secondary',closeSheet),btn(label,'primary'+(danger?' danger-fill':''),()=>{closeSheet();action();}));box.append(row);}
function menuItem(box,label,fn,name,detail){const b=btn('','menu-item',()=>{closeSheet();fn();},name);const t=el('span','grow');t.append(el('span','menu-label',label));if(detail)t.append(el('small','',detail));b.append(t);box.append(b);return b;}

// ─── Formatting ─────────────────────────────────────────────────────────────
// "kids" (kids.js): Herdr says idle/done but the agent's sub-agents still run — a working state.
const STATUS={working:['执行中','work'],blocked:['等你确认','alert'],kids:['子 Agent 运行中','work'],idle:['空闲','ok'],done:['已完成','ok']};
function stateLabel(a){const s=agentState(a);return s==='kids'?kidsLabel(a):(STATUS[s]||['状态未知','muted'])[0];}
function stateTone(a){return (STATUS[agentState(a)]||['','muted'])[1];}
// Every agent kind Herdr detects is listed and driven the same way; this table only names them.
// [display name, avatar initials]. Unknown kinds: the kind capitalized, two letters, neutral avatar.
// Claude and Codex also have their own avatar colours and transcripts (history, glance, modes).
const AGENT_KINDS={claude:['Claude','Cl'],codex:['Codex','Cx'],opencode:['OpenCode','Oc'],gemini:['Gemini','Ge'],cursor:['Cursor','Cu'],
 devin:['Devin','Dv'],agy:['Antigravity','Ag'],cline:['Cline','Cn'],copilot:['Copilot','Co'],kimi:['Kimi','Ki'],kiro:['Kiro','Kr'],
 droid:['Droid','Dr'],amp:['Amp','Am'],grok:['Grok','Gk'],hermes:['Hermes','He'],kilo:['Kilo','Kl'],qodercli:['Qoder','Qd'],
 qwen:['Qwen','Qw'],maki:['Maki','Mk'],pi:['Pi','Pi'],mastracode:['Mastra Code','Ma']};
// Kinds whose conversation files the bridge reads (bridge TRANSCRIPT_PROVIDERS). Others open on 终端.
const TRANSCRIPT_KINDS=['claude','codex'];
function kindSafe(p){return typeof p==='string'&&/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(p)?p.toLowerCase():'';}
function providerName(p){const k=kindSafe(p);return AGENT_KINDS[k]?.[0]||(k?k[0].toUpperCase()+k.slice(1):'Agent');}
function kindInitials(p){const k=kindSafe(p);return AGENT_KINDS[k]?.[1]||(k?k[0].toUpperCase()+(k[1]||''):'');}
function hasTranscript(p){return TRANSCRIPT_KINDS.includes(p);}
// A live agent whose conversation the app cannot read (any kind but Claude / Codex).
function noTranscript(a){return !!a?.agent&&!hasTranscript(a.agent);}
// Prefer names that tell agents apart: Herdr's agent title, a meaningful terminal
// title (not the generic "<dir>: ch" / "<dir>: claude"), then the first prompt.
function cleanTitle(t){return String(t||'').replace(/<\/?pasted_content(?:\s+id="[^"]{0,40}")?\s*>/g,' ').replace(/^[\s✳✻✽✶⠀-⣿·•*]+/,'').replace(/\s*\|\s*[^|]+$/,'').trim();}
function genericTitle(t,a){if(!t||/^[^:]{1,60}:\s*(ch|claude|codex|bash|zsh|sh|ssh)$/i.test(t)||t===a.agent||/^(claude|codex)( code)?$/i.test(t))return true;
 const k=kindSafe(a.agent);return !!k&&(t.toLowerCase()===providerName(k).toLowerCase()||new RegExp('^[^:]{1,60}:\\s*'+k+'$','i').test(t));}
function titleOf(a){for(const raw of [a.title,a.terminal_title_stripped,a.terminal_title]){const t=cleanTitle(raw);if(!genericTitle(t,a))return t;}
 const first=cleanTitle(a.history_ref?.record?.title);if(first&&!/^This session is being continued/.test(first))return first.slice(0,60);
 return providerName(a.agent)+(projectOf(a)?' · '+projectOf(a):'');}
function projectOf(a){const p=a.foreground_cwd||a.cwd||'';return p.split('/').filter(Boolean).pop()||'';}
function toDate(v){if(!v)return null;const d=new Date(typeof v==='number'?v*1000:v);return isNaN(d)?null:d;}
function time(v){const d=toDate(v);return d?d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';}
function clock(v){const d=toDate(v);return d?d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';}
function dayLabel(v){const d=toDate(v);if(!d)return '';const today=new Date();today.setHours(0,0,0,0);const diff=Math.round((today-new Date(d).setHours(0,0,0,0))/864e5);return diff===0?'今天':diff===1?'昨天':diff<7&&diff>0?['周日','周一','周二','周三','周四','周五','周六'][d.getDay()]:d.toLocaleDateString('zh-CN',{month:'long',day:'numeric'});}
function relative(v){const d=toDate(v);if(!d)return '';const s=(Date.now()-d)/1000;if(s<60)return '刚刚';if(s<3600)return Math.floor(s/60)+' 分钟前';if(s<86400&&dayLabel(v)==='今天')return clock(v);return dayLabel(v)==='昨天'?'昨天 '+clock(v):time(v);}
function avatar(kind,status){const k=kindSafe(kind);const n=el('div','avatar'+(k?' '+k+(hasTranscript(k)?'':' kind-other'):''),kindInitials(k));if(!k)n.append(icon('device'));if(status)n.append(el('span','status-dot '+status));return n;}
function draftKey(){return S.chat?.agent?S.session+'/'+S.chat.agent.identity:S.chat?.record?.id||'';}
// Durations: a running clock under an hour ("2:05"), coarse after that.
function dur(ms){const s=Math.max(0,Math.floor(ms/1000));if(s<3600)return Math.floor(s/60)+':'+String(s%60).padStart(2,'0');const h=Math.floor(s/3600);return h<24?h+' 小时 '+Math.floor(s%3600/60)+' 分':Math.floor(h/24)+' 天';}
function ago(ms){const s=ms/1000;return s<60?'刚刚':s<3600?Math.floor(s/60)+' 分钟':s<86400?Math.floor(s/3600)+' 小时':Math.floor(s/86400)+' 天';}
// A live-updating duration node; the 1 s ticker below rewrites every [data-since].
// 'upd' reads "12 秒前更新" (list freshness).
function sinceText(fmt,ms){if(fmt==='upd'){const s=Math.max(0,ms/1000);return s<5?'刚刚更新':s<60?Math.floor(s)+' 秒前更新':ago(ms)+'前更新';}return fmt==='ago'?ago(ms):dur(ms);}
function since(at,fmt='dur',prefix=''){const n=el('span','since',prefix+sinceText(fmt,Date.now()-at));n.dataset.since=at;n.dataset.fmt=fmt;n.dataset.prefix=prefix;return n;}

// ─── Agent status memory (this run only) ────────────────────────────────────
// Herdr reports the current state but not when it changed, so the UI remembers
// when it saw each change. Agents that finish while you look elsewhere get an
// unread dot until you open them (or start them again from the computer).
function agentKey(a){return S.session+'/'+a.identity;}
function statusSince(a){return a?S.since.get(agentKey(a))?.at||null:null;}
// Newest of: the state change seen here, the transcript's last entry (glance), the record's mtime.
function lastActivity(a){const at=statusSince(a)||0,g=typeof glanceAt==='function'?glanceAt(a):0;if(at||g)return Math.max(at,g);const m=Number(a.history_ref?.record?.modified);return m?m*1000:0;}
function viewingKey(){return S.chat?.agent&&!S.chat.stale?agentKey(S.chat.agent):'';}
function noteStatus(list){
 const viewing=viewingKey(),now=Date.now();
 for(const a of list){const k=agentKey(a),s=agentState(a),prev=S.since.get(k);
  if(!prev){S.since.set(k,{status:s,at:null});if(s==='done'&&k!==viewing)S.unread.add(k);continue;}
  if(prev.status===s)continue;
  S.since.set(k,{status:s,at:now,prevAt:prev.at,prev:prev.status});
  if(s==='working'||s==='blocked'||(prev.status==='done'&&s==='idle'))S.unread.delete(k);
  if(k===viewing||!S.active)continue;
  if((prev.status==='working'||prev.status==='kids')&&(s==='idle'||s==='done')){S.unread.add(k);toast('「'+titleOf(a)+'」做完了');}
  else if(s==='blocked')toast('「'+titleOf(a)+'」在等你确认');}}
setInterval(()=>{if(!S.active)return;document.querySelectorAll('[data-since]').forEach(n=>{const ms=Date.now()-Number(n.dataset.since);n.textContent=(n.dataset.prefix||'')+sinceText(n.dataset.fmt,ms);});},1000);

// ─── App shell & navigation ─────────────────────────────────────────────────
const TABS=[['live','chat','会话'],['history','history','历史'],['terminals','terminal','终端'],['devices','device','设备'],['settings','settings','设置']];
function setTab(tab){if(tab==='history'&&noHerdr())tab='live';leaveTerminal();S.chat=null;S.chatStack=[];S.tab=tab;S.epoch++;S.liveLoading=false;render();if(tab==='terminals'&&S.device)loadPanes();if(tab==='live'&&S.device)loadLive();if(tab==='history'&&S.device)loadCatalog();if(tab==='devices'&&S.device&&!S.account)loadAccount();if(tab==='settings')settingsLoad().then(()=>{if(S.tab==='settings'&&!S.chat&&!overlay.childElementCount)paintSettings();});}
function shell(){app.replaceChildren();const root=el('div','shell');app.append(root);if(S.demo)root.append(el('div','demo-banner','离线演示 · 示例数据，不连接电脑'));return root;}
function header(root){
 const bar=el('header','topbar');const title=(TABS.find(t=>t[0]===S.tab)||[])[2]||'Herdr Pocket';bar.append(el('h1','',title));
 const many=!S.demo&&LINKS.ids.length>1;const chip=btn('','device-chip',()=>many&&!S.loading?deviceSheet():setTab('devices'));chip.setAttribute('aria-label',many?'当前设备，共连着 '+LINKS.ids.length+' 台':'当前设备');chip.append(el('span',S.loading?'spinner':S.device?'dot':'dot offline'),el('span','truncate',S.loading?'连接中':S.device?S.device.name:'未连接'));
 if(many){const n=el('span','chip-links',String(LINKS.ids.length));n.setAttribute('aria-hidden','true');chip.append(n);}bar.append(chip);root.append(bar);deviceSwitcher(root);
 connectionBanner(root);
}
function pageHead(main,kicker,title,subtitle,action){const h=el('div','page-head');const t=el('p','grow',subtitle||'');h.append(t);if(action)h.append(action);main.append(h);}
function loadingCard(main,title,detail){const box=el('div','loading-card');box.setAttribute('role','status');box.setAttribute('aria-live','polite');box.append(el('span','spinner'));const text=el('div');text.append(el('h2','',title),el('p','muted',detail));box.append(text);main.append(box);}
function skeleton(main,rows=4){for(let i=0;i<rows;i++){const r=el('div','skeleton-row');r.append(el('div','sk-avatar'),el('div','sk-lines'));main.append(r);}}
function empty(main,title,desc,action,name='chat'){const n=el('div','empty');const a=el('div','empty-icon');a.append(icon(name));n.append(a,el('h2','',title),el('p','',desc));if(action)n.append(action);main.append(n);}
function render(){
 if(S.chat){renderChat();return;}if(typeof T!=='undefined'&&T.view){renderTerminal();return;}
 const root=shell();header(root);const main=el('main','main pane-enter');root.append(main);
 if(S.tab==='live')livePage(main);else if(S.tab==='history')historyPage(main);else if(S.tab==='terminals')terminalsPage(main);else if(S.tab==='settings')settingsPage(main);else devicesPage(main);
 const nav=el('nav','bottom-nav');nav.setAttribute('aria-label','主导航');
 const waiting=S.agents.filter(a=>a.agent_status==='blocked'||glanceAsks(a)).length;
 // Without Herdr there are no transcripts to browse here: 历史 is left out.
 TABS.filter(([tab])=>tab!=='history'||!noHerdr()).forEach(([tab,i,label])=>{const n=btn(label,'nav-item'+(S.tab===tab?' active':''),()=>setTab(tab),i);n.setAttribute('aria-current',S.tab===tab?'page':'false');if(tab==='live'&&waiting){const badge=el('span','nav-badge',String(waiting));badge.setAttribute('aria-hidden','true');n.append(badge);n.title=waiting+' 个 Agent 等你确认';}if(tab==='settings'&&settingsBadge()){n.append(el('span','nav-dot'));n.title='有新版本';}nav.append(n);});
 root.append(nav);}
function requireDevice(main){if(S.device||cacheBrowsing())return true;if(S.loading){loadingCard(main,'连接正在进行','连接成功后会自动读取会话，请稍候。');return false;}empty(main,'先连接你的电脑','连接后，在线会话、历史记录和终端会出现在这里。',btn('选择设备','primary',()=>setTab('devices')));return false;}
function searchBox(placeholder,change,value=''){const box=el('div','search');const input=el('input');input.type='search';input.placeholder=placeholder;input.value=value;input.setAttribute('aria-label',placeholder);input.setAttribute('enterkeyhint','search');
 const clear=ib('x','清除搜索',()=>{input.value='';clear.classList.add('hidden');change('');input.focus();});clear.classList.add('search-clear');clear.classList.toggle('hidden',!value);
 input.oninput=()=>{clear.classList.toggle('hidden',!input.value);change(input.value);};input.onkeydown=e=>{if(e.key==='Enter')input.blur();};box.append(icon('search'),input,clear);return box;}
// Pull down at the top of a list to refresh it (touch only; the refresh button does the same).
function pullRefresh(main,fn){
 const tip=el('div','pull-tip');tip.setAttribute('aria-hidden','true');const spin=el('span','pull-icon');spin.append(icon('refresh'));const label=el('span','','下拉刷新');tip.append(spin,label);main.prepend(tip);
 let y0=null,dist=0;const max=72,need=56;
 main.addEventListener('touchstart',e=>{y0=main.scrollTop<=0&&e.touches.length===1&&!overlay.childElementCount?e.touches[0].clientY:null;dist=0;},{passive:true});
 main.addEventListener('touchmove',e=>{if(y0===null)return;dist=Math.max(0,Math.min(max,(e.touches[0].clientY-y0)*.5));if(main.scrollTop>0){y0=null;dist=0;}tip.style.height=dist+'px';tip.classList.toggle('ready',dist>=need);label.textContent=dist>=need?'松手刷新':'下拉刷新';spin.style.transform='rotate('+dist*4+'deg)';},{passive:true});
 const end=()=>{if(y0===null)return;const go=dist>=need;y0=null;dist=0;tip.style.height='';tip.classList.remove('ready');if(go){tip.classList.add('busy');label.textContent='正在刷新…';fn();}};
 main.addEventListener('touchend',end);main.addEventListener('touchcancel',()=>{y0=null;dist=0;tip.style.height='';});}

// ─── Devices & connection ───────────────────────────────────────────────────
// Devices, device form, connecting, host-key trust, bridge install and disconnect live in onboard.js.
async function startDemo(){if(S.loading){toast('正在连接，请稍候');return;}S.connectError='';if(S.device&&!S.demo){confirmAction('断开并体验演示？','演示不连接任何电脑，也不会给 Agent 发消息。','进入演示',async()=>{await disconnect(false);startDemo();});return;}try{await rpc('demo');S.demo=true;S.device={id:'demo',name:'演示工作站',user:'demo',host:'workstation.local',port:22};S.account={ssh_user:'demo',hostname:'workstation'};S.session='demo';S.sessions=['demo'];S.agents=demoAgents;S.records=demoRecords.slice().sort((a,b)=>b.modified-a.modified);S.tab='live';S.chat=null;render();}catch(e){error(e);}}
// The 设备 page's card on top: SSH user and host name, plus the bridge's own version (read-only `hello`;
// an old or unreadable bridge just shows a dash).
async function loadAccount(){const epoch=S.epoch;try{const [a,h]=await Promise.all([remote('account'),remote('hello').catch(()=>null)]);if(epoch!==S.epoch)return;S.account={...a,bridge:h?.version?String(h.version).slice(0,24):''};if(S.tab==='devices'&&!S.chat)render();}catch(e){if(epoch===S.epoch)error(e);}}

// ─── Live agents ────────────────────────────────────────────────────────────
// One row per agent: what it is (title), where (provider · project), and what it
// is doing right now (state + how long), with a dot when it finished unseen.
// Rows open on tap; swipe left (or long press) for 关闭.
function agentRow(a){
 const k=agentKey(a),unread=S.unread.has(k),asks=!!glanceAsks(a),tone=asks?'alert':stateTone(a),st=agentState(a);
 const n=btn('','card-button agent-row tone-'+tone+(unread?' unread':''),()=>openAgent(a));
 const text=el('div','grow');text.append(el('div','card-title',rowTitle(a)));
 // The avatar already says Claude / Codex; the meta line is where it runs, then a one-line
 // preview (glance.js): the current step, the question waiting for you, or the last reply.
 const meta=el('div','card-meta');meta.dataset.glance=k;const project=projectOf(a);meta.append(el('span','project',project||providerName(a.agent)));
 if(closeIsCh(a))meta.append(el('span','tag remote-tag','远端'));
 modeRowTags(meta,a);
 const ref=a.history_ref;if(ref&&ref.status!=='matched'&&ref.status!=='pending')meta.append(el('span','sep warn','历史未关联'));queueBadge(meta,a);
 const preview=glancePreview(a);if(preview){meta.append(preview);n.classList.add('has-glance');}
 text.append(meta);
 const side=el('div','row-side');const at=statusSince(a);
 // The group header, the avatar dot and the tint already say 执行中 / 等你确认: the side keeps
 // just how long, so the preview gets the width.
 if(st==='blocked'||st==='working'||st==='kids'){const t=at?since(at,'ago'):el('span','',rowTimeText(a));t.classList.add('row-time','state-time','t-'+tone);side.append(t);t.title=stateLabel(a);}
 else{side.append(el('span','row-time',rowTimeText(a)));
  if(asks)side.append(el('span','row-state t-ask','在问你'));
  else if(unread){const d=el('span','unread-dot');d.title='做完了，还没看';side.append(d,el('span','sr-only','有新进展'));}
  else if(st==='done')side.append(el('span','row-state','已完成'));}
 n.append(avatar(a.agent,tone),text,side);closeHold(n,()=>agentActions(a));
 return closeSwipe(n,[['关闭','x','danger',()=>closeSession(a)],['更多','more','',()=>agentActions(a)]]);}
// The meta line already names the project: a fallback title ("OpenCode · site") drops it there.
function rowTitle(a){const t=titleOf(a),p=projectOf(a);return p&&t===providerName(a.agent)+' · '+p?providerName(a.agent):t;}
function rowTimeText(a){const at=statusSince(a),last=lastActivity(a);if(!last)return '';return (at&&at>=last?ago(Date.now()-at)+'前':relative(last/1000)).replace('刚刚前','刚刚');}
// Within a group: unseen results first, then whatever changed most recently.
function sortAgents(items){return items.map((a,i)=>({a,i,u:S.unread.has(agentKey(a))?1:0,t:lastActivity(a)})).sort((x,y)=>y.u-x.u||y.t-x.t||x.i-y.i).map(x=>x.a);}
function liveProjects(){const m=new Map();for(const a of S.agents){const p=projectOf(a)||'其他';m.set(p,(m.get(p)||0)+1);}return [...m].sort((x,y)=>y[1]-x[1]||x[0].localeCompare(y[0]));}
function liveMatch(a,q){return !q||(titleOf(a)+' '+providerName(a.agent)+' '+projectOf(a)+' '+(a.foreground_cwd||a.cwd||'')).toLowerCase().includes(q);}
// A filter chip whose count is visual only, so its accessible name stays the plain label.
function chip(label,count,on,fn){const b=btn(label,'pill chip'+(on?' active':''),fn);b.setAttribute('aria-pressed',String(!!on));if(count!==undefined&&count!==''){const c=el('span','chip-count',String(count));c.setAttribute('aria-hidden','true');b.append(c);}return b;}
// Left of the toolbar: "22 个在线 · 2 个有新进展" over "12 秒前更新" — what needs you, how fresh.
function liveStatus(){
 const box=el('div','grow live-status');const facts=el('span','list-facts');
 const unread=S.agents.filter(a=>S.unread.has(agentKey(a))).length;
 facts.append(el('span','fact-count',S.agents.length+' 个在线'));
 if(unread)facts.append(el('span','sep fact-new',unread+' 个有新进展'));
 box.append(facts);
 if(S.fromCache)box.append(el('span','list-fresh cache-note',(S.device?'上次读取':'正在连接 · 显示上次读取的列表')+' · '+cacheAge(S.fromCache)));
 else if(S.liveLoading)box.append(el('span','list-fresh','正在刷新…'));
 else if(S.liveAt){const f=el('span','list-fresh');f.append(since(S.liveAt,'upd'));box.append(f);}
 return box;}
function livePage(main){
 if(!requireDevice(main))return;
 const actions=el('div','row list-actions');
 if(S.sessions.length>1){const s=btn('','pill session-pill',chooseSession,'folder');s.append(el('span','truncate',S.session||'选择会话'),icon('down'));s.setAttribute('aria-label','切换 Herdr 会话 · 当前 '+(S.session||'未选'));actions.append(s);}
 const counts=S.agents.length&&!S.liveError&&!(S.liveLoading&&!S.agents.length);
 actions.append(counts?liveStatus():el('span','grow'),ib('refresh','刷新会话',loadLive));
 // With no sessions the empty state carries the one 新建 button.
 const pendingHere=typeof newPendingHere==='function'?newPendingHere().length:0;
 if(S.device&&S.session&&(S.agents.length||pendingHere))actions.append(createButton());
 // Loading, failed and empty pages carry their own status and action (and new agents appear by
 // themselves): a lone refresh icon over them only looks unfinished.
 if(counts||S.sessions.length>1||pendingHere)main.append(actions);
 // Starts still on their way (create.js 正在启动) go first, also above an empty or loading list.
 const starting=typeof newPendingSection==='function'?newPendingSection(main):0;
 if(S.liveLoading&&!S.agents.length){loadingCard(main,'SSH 已连接，正在读取会话',S.liveLoading==='sessions'?'正在获取 Herdr 工作区…':'正在识别 Agent 并关联历史记录…');skeleton(main,3);return;}
 if(S.liveError){empty(main,'会话读取失败',S.liveError,btn('重新读取','primary',loadLive));return;}
 if(S.agents.length)glanceKick();
 const projects=liveProjects();if(S.liveProject&&!projects.some(p=>p[0]===S.liveProject))S.liveProject='';
 if(S.agents.length>8)main.append(searchBox('搜索标题、项目或 Agent',q=>{S.search=q;draw();},S.search));
 if(projects.length>1&&S.agents.length>5){const row=el('div','tabs chips');row.setAttribute('aria-label','按项目筛选');
  const draw2=()=>{row.replaceChildren(chip('全部',S.agents.length,!S.liveProject,()=>{S.liveProject='';draw2();draw();}));projects.forEach(([p,n])=>row.append(chip(p,n,S.liveProject===p,()=>{S.liveProject=S.liveProject===p?'':p;draw2();draw();})));};
  draw2();main.append(row);}
 const list=el('div','agent-list');main.append(list);
 function draw(){list.replaceChildren();const q=S.agents.length>8?S.search.trim().toLowerCase():'';const matches=S.agents.filter(a=>liveMatch(a,q)&&(!S.liveProject||(projectOf(a)||'其他')===S.liveProject));
  if(!matches.length){
   if(q||S.liveProject)empty(list,'没有匹配的 Agent','换个关键词，或者看看全部会话。',btn('清除筛选','secondary',()=>{S.search='';S.liveProject='';render();}));
   // tmux sessions listed below (tmux.js) are sessions too: only Herdr has no agent yet.
   else if(typeof tmuxPanes==='function'&&tmuxPanes().length){const n=el('div','herdr-none');n.setAttribute('role','note');const t=el('div','grow');t.append(el('strong','','Herdr 里还没有 Agent'),el('span','fine','新建一个，或者在 Herdr 里启动。'));n.append(t);if(S.device&&S.session)n.append(createButton());list.append(n);}
   else if(!starting)empty(list,'暂时没有会话','新建一个 Codex 或 Claude，或者在电脑的 Herdr 里启动任意 Agent，这里会自动出现。',S.device&&(S.session||tmuxCan())?createButton():undefined);
   return;}
  // 子 Agent 运行中 (kids.js) sits with 执行中: the agent is not done while its sub-agents work.
  // An idle Codex with an unanswered question (glance.js) waits for you too.
  const needs=a=>agentState(a)==='blocked'||!!glanceAsks(a);GL.askSig=glanceAskSig();
  const groups=[[matches.some(a=>glanceAsks(a))?'等你处理':'等你确认',needs,'alert'],['执行中',a=>!needs(a)&&['working','kids'].includes(agentState(a)),'work'],['空闲',a=>!needs(a)&&!['blocked','working','kids'].includes(agentState(a)),'']];
  for(const [label,test,tone] of groups){const items=sortAgents(matches.filter(test));if(!items.length)continue;const h=el('div','section-label group-label'+(tone?' g-'+tone:''));h.append(el('span','',label),el('span','group-count',String(items.length)));list.append(h);const g=el('div','card list-card');items.forEach(a=>{g.append(agentRow(a));const kids=kidsStrip(a);if(kids)g.append(kids);});list.append(g);}
  closeHint(list);}
 draw();
 pullRefresh(main,loadLive);}
// Herdr can run several sessions (sets of workspaces). The list, terminals and 新建 all work in one.
function chooseSession(){
 const box=sheet('切换 Herdr 会话');box.append(el('p','fine close-sub','电脑上的 Herdr 开了 '+S.sessions.length+' 个会话，每个会话有自己的工作区。会话、终端和新建都在当前会话里。'));
 S.sessions.forEach(name=>{const here=name===S.session;const b=menuItem(box,name,()=>switchSession(name),here?'check':'folder',here?'当前 · '+S.agents.length+' 个 Agent':'点一下切换');if(here){b.classList.add('current');b.setAttribute('aria-current','true');}});}
function switchSession(name){
 if(name===S.session)return;S.session=name;S.agents=[];S.liveProject='';S.search='';S.fromCache=false;if(typeof T!=='undefined')T.panes=[];
 if(S.tab==='terminals')loadPanes();else loadLive();toast('切到 Herdr 会话「'+name+'」');}
async function loadLive(){
 if(!S.device)return;const epoch=++S.epoch;S.liveLoading=S.agents.length?'agents':'sessions';S.liveError='';if(!S.agents.length)cacheShowLive();if(S.tab==='live'&&!S.chat)render();
 try{const r=await remote('sessions');if(epoch!==S.epoch)return;
  // No Herdr on this computer (bridge flag): no sessions, no agents, no error; tmux.js shows tmux only.
  S.herdr=r.herdr!==false;if(r.herdr===false){S.hostIssue=null;S.sessions=[];S.session='';S.agents=[];S.fromCache=false;if('tmux' in r)S.hostTmux=r.tmux;return;}
  S.sessions=r.sessions.filter(x=>x.running).map(x=>x.name);if(!S.sessions.includes(S.session))S.session=S.sessions[0]||'';if(!S.session){S.agents=[];S.fromCache=false;return;}
  S.liveLoading='agents';if(S.tab==='live'&&!S.chat&&!S.agents.length)render();
  const a=await remote('agents',{session:S.session});if(epoch!==S.epoch)return;S.agents=a.agents;S.liveAt=Date.now();noteStatus(S.agents);syncWatch();cacheLive();glanceRefresh(true);if(S.pendingPane){S.liveLoading=false;openPending();return;}}
 catch(e){if(epoch===S.epoch)S.liveError=e.message||String(e);}
 finally{if(epoch===S.epoch){S.liveLoading=false;if(S.tab==='live'&&!S.chat)render();}}}
// Lightweight status refresh: Herdr state only, keeps resolved history refs.
async function refreshStatus(){
 if(!S.device||S.demo||S.statusBusy||!S.session||!S.statusSupported||S.liveLoading)return;S.statusBusy=true;
 try{const r=await remote('status',{session:S.session});const known=new Map(S.agents.map(a=>[a.pane_id,a]));let changed=false;
  const next=r.agents.map(a=>{const old=known.get(a.pane_id);if(!old||old.identity!==a.identity){changed=true;return a;}if(old.agent_status!==a.agent_status||titleOf(old)!==titleOf(a))changed=true;return {...old,...a,history_ref:old.history_ref};});
  if(next.length!==S.agents.length)changed=true;
  const fresh=next.filter(a=>!known.has(a.pane_id)||known.get(a.pane_id).identity!==a.identity);
  noteStatus(next);S.agents=next;S.liveAt=Date.now();document.querySelectorAll('[data-fmt="upd"]').forEach(n=>{n.dataset.since=S.liveAt;});if(changed){syncWatch();cacheLive();}
  if(S.chat?.agent&&!S.chat.agent.tmux){const cur=next.find(a=>a.pane_id===S.chat.agent.pane_id);followHint(cur);if(!cur||cur.identity!==S.chat.agent.identity){if(!S.chat.stale){S.chat.stale=true;toast('这个窗格的 Agent 已变化，已停止发送');renderChat();}}else if(cur.agent_status!==S.chat.agent.agent_status){const was=S.chat.agent.agent_status;S.chat.agent={...S.chat.agent,agent_status:cur.agent_status};onAgentStatus(was,cur.agent_status);}}
  if(fresh.length&&S.tab==='live'&&!S.chat){loadLive();return;}
  if(changed&&!S.chat&&!(typeof T!=='undefined'&&T.view)&&!overlay.childElementCount)render();}
 catch(e){if(/Unknown operation|不支持的操作/.test(e.message))S.statusSupported=false;}
 finally{S.statusBusy=false;}}

// ─── Chat ───────────────────────────────────────────────────────────────────
function resetChat(chat){S.chat=chat;S.messages=[];S.children=[];S.more=false;S.before=0;S.historyNote='';S.terminalText='';S.terminalAnsi='';S.activity='';S.chatMode='conversation';S.paused=false;S.stick=true;S.unseen=0;}
async function openAgent(a){
 S.unread.delete(agentKey(a));S.chatStack=[];resetChat({agent:a,record:null,title:titleOf(a),provider:a.agent});
 // No transcript reader for this kind: the terminal is the conversation. Say so once, calmly.
 if(noTranscript(a)){S.chat.noTranscript=true;S.chatMode='terminal';S.epoch++;renderChat();fetchTerminal(true);return;}
 const epoch=++S.epoch;renderChat();
 const ref=a.history_ref;
 if(ref?.record){S.bindings.delete(S.session+'/'+a.identity);S.chat.record=ref.record;await fetchHistory(false,true);return;}
 const remembered=S.bindings.get(S.session+'/'+a.identity);if(remembered){S.chat.record=remembered;S.chat.manual=true;await fetchHistory(false,true);return;}
 const id=ref?.thread||(a.agent_session?.kind!=='path'?a.agent_session?.value:null);
 if(id&&ref?.status!=='pending'&&S.device){try{const r=await remote('catalog',{thread:id});if(epoch!==S.epoch)return;const rec=r.records.find(x=>x.provider===a.agent&&(!ref?.record_id||x.id===ref.record_id));if(rec){S.chat.record=rec;await fetchHistory(false,true);return;}}catch(e){if(epoch===S.epoch)error(e);}}
 if(epoch===S.epoch){S.chat.historyIssue=historyIssueText(ref);paintTimeline();if(a.agent_status==='working'||a.agent_status==='blocked')fetchTerminal(true);}}
function historyIssueText(ref){const reason=ref?.reason;switch(ref?.status){case 'remote_error':return '远端历史读取失败：'+(reason||'连接不可用');case 'pending':return (reason||'会话刚开始，历史文件还没写出')+'。稍后会自动出现。';case 'remote_candidates':case 'ambiguous':case 'unavailable':return (reason||'没有能唯一确认的会话标识')+(ref?.candidates?.length?'，下面列出了候选。':'。');case 'remote_missing':return reason||'远端这个工作目录下还没有历史记录。';case 'remote':return '这个窗格通过 SSH 连到别的电脑，历史在那台电脑上；终端输出仍可查看。';case 'missing':return reason||'会话标识已知，但没找到对应的历史文件。';default:return reason||'没有能确认的会话标识，可以手动选择历史，或查看终端输出。';}}
function openRecord(r,push=false){
 if(push&&S.chat)S.chatStack.push({...S.chat,mode:S.chatMode,savedMessages:S.messages,savedChildren:S.children,savedBefore:S.before,savedMore:S.more,savedScroll:document.getElementById('chat-scroll')?.scrollTop||0,savedStick:S.stick});else S.chatStack=[];
 resetChat({record:r,agent:null,title:r.title,provider:r.provider});S.epoch++;renderChat();fetchHistory(false,true);}
// History reads never overlap (S.polling). A read asked for while another runs is not lost: an
// earlier page waits its turn and then goes first, a refresh or poll runs right after (polls
// coalesce). HQ.state is the earlier-page state shown at the top of the list (timeline.js olderSync).
const HQ={epoch:-1,state:'',error:'',older:null,again:0,againEpoch:-1};
function histBusy(){return S.polling&&S.fetchEpoch===S.epoch;}
function olderPending(){return !!HQ.older&&HQ.older.epoch===S.epoch;}
function fetchHistory(older=false,initial=false){
 if(!S.chat?.record)return Promise.resolve();
 if(older)return historyOlder();
 if(histBusy()||!initial&&olderPending()){HQ.again=HQ.againEpoch===S.epoch?Math.max(HQ.again,initial?2:1):initial?2:1;HQ.againEpoch=S.epoch;return Promise.resolve();}
 return historyRead(false,initial);}
function olderSet(epoch,state,error=''){if(epoch!==S.epoch)return;HQ.epoch=epoch;HQ.state=state;HQ.error=error;olderSync();}
function olderReady(){const c=S.chat;return !!(c?.record&&S.more&&S.messages.length&&!c.cached&&!c.waiting&&!c.historyLoading&&S.chatMode!=='terminal');}
// Reading near the top pulls in the previous page by itself (not after an error: that waits for 重试).
function olderNear(n){return !!n&&!S.stick&&n.scrollTop<Math.max(320,n.clientHeight*.6)&&olderReady()&&!olderPending()&&!(HQ.epoch===S.epoch&&HQ.state==='error');}
function historyOlder(){
 const epoch=S.epoch;if(olderPending())return HQ.older.p;if(!olderReady())return Promise.resolve();
 const job={epoch};HQ.older=job;olderSet(epoch,'loading');
 job.p=(async()=>{
  try{while(histBusy()&&epoch===S.epoch)await new Promise(r=>setTimeout(r,40));
   if(epoch===S.epoch&&olderReady())await historyRead(true,false);}
  finally{if(HQ.older===job)HQ.older=null;if(HQ.epoch===epoch&&HQ.state==='loading')olderSet(epoch,'');
   if(HQ.again&&HQ.againEpoch===S.epoch&&!histBusy()){const init=HQ.again===2;HQ.again=0;fetchHistory(false,init);}}})();
 return job.p;}
// Keep what the reader looks at in place while rows are added above it: the first rows in view
// that survive the render are the anchor (a turn that grew an earlier start is rebuilt, so a
// later one is used); without one, the height added above is subtracted.
function keepPlace(n,render){
 const vt=n.getBoundingClientRect().top,marks=[];const list=n.querySelector('.timeline');
 // Rows inside turns, not the turns: a turn's own top padding changes once a turn lands above it.
 if(list)for(const c of list.querySelectorAll(':scope>.turn>*,:scope>.message,:scope>.tool-row,:scope>.slash-card')){const r=c.getBoundingClientRect();if(r.bottom>vt+1){marks.push([c,r.top]);if(marks.length>=8)break;}}
 const top=n.scrollTop,h=n.scrollHeight;render();
 const m=marks.find(([c])=>c.isConnected);
 if(m)n.scrollTop+=m[0].getBoundingClientRect().top-m[1];else n.scrollTop=top+n.scrollHeight-h;}
async function historyRead(older,initial){
 S.polling=true;const epoch=S.epoch;S.fetchEpoch=epoch;const record=S.chat.record;
 try{
 // A cached copy is painted first; before SSH is up the read waits for the connection.
 if(initial){const wait=await cacheFill(record,epoch);if(epoch!==S.epoch||wait){if(wait&&epoch===S.epoch)paintTimeline();return;}S.chat.historyLoading=true;paintTimeline();}
 const args={record_id:record.id};if(record.remote)args.remote=record.remote;if(older)args.before=S.before;
 try{const r=await remote('history',args);if(epoch!==S.epoch)return;kidsFromHistory(record,r);const hadError=!!S.chat.historyError;S.chat.historyError=null;S.chat.historyLoading=false;S.chat.cached=0;S.chat.waiting=false;const prior=S.messages.length+':'+(S.messages.at(-1)?.id||'')+':'+(S.messages.at(-1)?.text.length||0);
  const known=new Set(S.messages.map(x=>x.id));
  if(older)S.messages=r.messages.filter(m=>!known.has(m.id)).concat(S.messages);
  else if(initial)S.messages=r.messages.slice();
  else{const map=new Map(S.messages.map(x=>[x.id,x]));r.messages.forEach(m=>map.set(m.id,m));S.messages=[...map.values()].sort((a,b)=>Number(a.id.split(':')[0])-Number(b.id.split(':')[0])||Number(a.id.split(':')[1])-Number(b.id.split(':')[1]));}
  S.children=r.children||[];if(initial||older){S.before=r.before;S.more=r.has_more;}
  S.historyNote=r.bounded?'本页到了读取窗口边界，可以继续加载更早记录。':'';
  const settled=settleOutbox();
  const now=S.messages.length+':'+(S.messages.at(-1)?.id||'')+':'+(S.messages.at(-1)?.text.length||0);
  if(older||initial&&HQ.epoch===epoch&&HQ.state==='error')olderSet(epoch,'');
  if(prior!==now||initial||older||hadError||settled){
   const n=document.getElementById('chat-scroll');
   if(older&&n){keepPlace(n,()=>renderTimeline({quiet:true}));updateJump();
    // Still near the top (a short page): keep reading upwards.
    requestAnimationFrame(()=>{if(epoch===S.epoch&&olderNear(n))fetchHistory(true);});}
   else{if(initial)S.stick=true;else if(!S.stick)S.unseen+=S.messages.filter(m=>!known.has(m.id)&&(m.kind==='user'||m.kind==='assistant')).length;paintTimeline();}}
  updateChatMeta();qaRefresh();cacheChat();}
 catch(e){if(epoch!==S.epoch)return;
  // An earlier page that did not load says so in place, with 重试; the chat itself keeps polling.
  if(older){olderSet(epoch,'error',e.message);return;}
  S.paused=true;S.chat.historyLoading=false;S.chat.historyError='历史读取失败：'+e.message;paintTimeline();}}
 finally{if(S.fetchEpoch===epoch)S.polling=false;
  if(HQ.again&&HQ.againEpoch===S.epoch&&!histBusy()&&(older||!olderPending())){const init=HQ.again===2;HQ.again=0;setTimeout(()=>fetchHistory(false,init),0);}}}
// Re-render the timeline but keep the reader where they are: follow the bottom
// only when they were already there, otherwise hold position and count news.
function paintTimeline(){const n=document.getElementById('chat-scroll');const top=n?n.scrollTop:0;const flip=n?tlFlipStart(n):null;renderTimeline();if(!n)return;n.scrollTop=S.stick?n.scrollHeight:top;if(flip)tlFlipEnd(n,flip);updateJump();}
function updateJump(){const j=document.getElementById('jump');if(!j)return;j.classList.toggle('hidden',S.stick);j.classList.toggle('has-count',S.unseen>0);const t=j.querySelector('.jump-text');if(t)t.textContent=S.unseen?S.unseen+' 条新消息':'';}
function showJump(v){S.stick=!v;updateJump();}
function chatSubtitle(){const c=S.chat;if(!c)return '';if(c.stale)return followSubtitle(c);if(c.agent){const parts=[stateLabel(c.agent),providerName(c.agent.agent)];const p=projectOf(c.agent);if(p)parts.splice(1,0,p);if(c.manual)parts.push('手动关联');return parts.join(' · ');}return (c.record?.parent?'子 Agent · '+(c.kidRunning?'运行中 · ':''):'')+providerName(c.provider)+' · 历史只读';}
// Subtitle: "执行中 2:05 · 项目" — state first so it survives truncation; the
// avatar already says Claude/Codex.
function updateChatMeta(){
 const n=document.getElementById('chat-meta'),c=S.chat;
 if(n&&c){n.replaceChildren();const a=c.agent&&!c.stale?c.agent:null;
  if(!a)n.append(chatSubtitle());
  else if(awaitingReply())n.append(el('span','meta-state work','正在读取回复…'),' · '+(projectOf(a)?projectOf(a)+' · ':'')+providerName(a.agent));
  else{const st=el('span','meta-state '+stateTone(a),stateLabel(a));const at=['working','blocked'].includes(agentState(a))?statusSince(a)||(a.agent_status==='working'&&c.sentAt)||0:0;if(at)st.append(' ',since(at));n.append(st);const p=projectOf(a);n.append(' · '+(p?p+' · ':'')+providerName(a.agent));if(c.manual)n.append(' · 手动关联');}}
 const d=document.getElementById('chat-dot');if(d)d.className='status-dot '+(c?.agent&&!c.stale?stateTone(c.agent):'muted');
 const b=document.getElementById('child-count');if(b){b.textContent=String(S.children.length);b.classList.toggle('hidden',!S.children.length);}kidsPaintHead();}
function renderChat(){
 const root=shell();root.classList.add('chat-shell');const head=el('header','chat-head');head.id='chat-head';head.append(ib('back','返回列表',pocketBack));
 const av=avatar(S.chat.provider);const dot=el('span','status-dot');dot.id='chat-dot';av.append(dot);head.append(av);
 const name=el('div','grow chat-id');name.append(el('h2','',S.chat.title||'对话'));const sub=el('small','chat-meta');sub.id='chat-meta';name.append(sub);head.append(name);
 const sw=ib('branch','切换 Agent',agentSwitcher);sw.classList.add('with-count');const count=el('span','icon-count hidden');count.id='child-count';count.setAttribute('aria-hidden','true');sw.append(count);
 const more=ib('more','更多操作',chatMenu);sw.classList.add('head-act');more.classList.add('head-act');head.append(sw,more);root.append(head);
 const tabs=el('div','chat-tabs');tabs.setAttribute('role','group');tabs.setAttribute('aria-label','视图');[['conversation','对话'],['commands','命令'],['terminal','终端']].filter(([mode])=>!(S.chat.noTranscript&&mode==='commands')).forEach(([mode,title])=>{const b=btn(title,S.chatMode===mode?'active':'',()=>{if(S.chatMode===mode)return;S.chatMode=mode;S.stick=true;S.unseen=0;S.epoch++;renderChat();if(mode==='terminal')fetchTerminal();else if(S.chat.record&&!S.messages.length)fetchHistory(false,true);});b.setAttribute('aria-pressed',String(S.chatMode===mode));tabs.append(b);});head.append(tabs);
 const wrap=el('div','chat-body-wrap');const body=el('main','chat-body');body.id='chat-scroll';
 body.onscroll=()=>{const bottom=body.scrollHeight-body.scrollTop-body.clientHeight<80;if(bottom!==S.stick||(bottom&&S.unseen)){S.stick=bottom;if(bottom)S.unseen=0;updateJump();}
  // Reading near the top pulls in the previous page (position is kept, see keepPlace).
  if(olderNear(body))fetchHistory(true);};
 // Keyboard opening or the live strip growing shrinks the view: stay pinned to the latest.
 if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>{if(S.stick)body.scrollTop=body.scrollHeight;}).observe(body);
 wrap.append(body);
 const jump=btn('','jump-btn hidden',()=>{S.stick=true;S.unseen=0;body.scrollTop=body.scrollHeight;updateJump();},'down');jump.id='jump';jump.setAttribute('aria-label','回到最新');jump.append(el('span','jump-text'));wrap.append(jump);root.append(wrap);
 const footer=el('footer','composer-wrap');footer.id='composer';root.append(footer);
 renderTimeline();renderComposer();updateChatMeta();
 const n=document.getElementById('chat-scroll');if(n&&S.stick)n.scrollTop=n.scrollHeight;}

// Composer, live state (question card / confirmation) and the footer rail (foot.js). The input itself survives
// status changes so typing (and the keyboard) is never interrupted.
function renderComposer(){
 const footer=document.getElementById('composer');if(!footer||!S.chat)return;const a=S.chat.agent;
 // Connecting with a cached chat: the composer stays (drafts can be written) but nothing is sent.
 const offline=!S.device&&!S.demo;if(offline&&(!a||S.chat.stale)&&cacheOffline(footer))return;
 if(!a||S.chat.stale){if(followFooter(footer))return;footer.replaceChildren(el('div','readonly',S.chat.stale?'这个窗格的 Agent 已变化，回到列表重新打开':S.chat.record?.parent?'子 Agent 的历史记录 · 只读，不会向父会话发送':'历史只读 · 在「会话」里打开在线 Agent 才能继续对话'));return;}
 const key=draftKey();let live=document.getElementById('live-state'),compose=footer.querySelector('.composer');
 if(!live||!compose||compose.dataset.key!==key){footer.replaceChildren();live=el('div','live-state');live.id='live-state';compose=buildComposer(key);footer.append(live,compose);}
 if(offline){live.replaceChildren(el('div','compose-note','正在连接 · 显示的是上次的缓存，连上后才能发送'));}else renderLiveState(live,a);
 const input=compose.querySelector('textarea'),send=compose.querySelector('.send'),st=a.agent_status,later=!offline&&(st==='working'||st==='blocked');
 input.placeholder=offline?'可以先写，连上再发':st==='working'?'写好会排队，停下就发':st==='blocked'?'写好会排队，确认完再发':S.chat.noTranscript?'发给 '+providerName(a.agent)+'…'+(slashKnown(a)?'（/ 看命令）':''):'接着说点什么…（/ 看命令）';
 if(input.value!==(S.drafts.get(key)||'')){input.value=S.drafts.get(key)||'';compose.grow();}
 // Busy agent: the button says it will queue, so sending never looks like it failed.
 send.classList.toggle('later',later);send.querySelector('.send-label').textContent=later?'排队':'';send.title=offline?'连上后才能发送':later?'先排队，它停下就发':'发送';
 compose.classList.toggle('offline',offline);imgTray(compose,key);fileTray(compose,key);send.disabled=offline||!input.value.trim()&&!attCount(key);
 footPaint(footer,a);}
function buildComposer(key){
 const compose=el('div','composer');compose.dataset.key=key;const input=el('textarea');input.rows=1;input.setAttribute('aria-label','消息输入框');input.setAttribute('enterkeyhint','enter');input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','false');input.value=S.drafts.get(key)||'';
 const send=btn('','send',()=>sendMessage(input),'send');send.setAttribute('aria-label','发送消息');send.append(el('span','send-label'));
 const grow=()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,innerHeight<560?96:140)+'px';};compose.grow=grow;
 // Enter is a newline on phones; Ctrl/⌘+Enter sends with a hardware keyboard.
 // While the slash list is open, arrows/Enter/Tab/Esc drive it (slash.js).
 input.onkeydown=e=>{if(slashKeydown(e,compose,input))return;if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();sendMessage(input);}};
 input.oninput=()=>{if(input.value)S.drafts.set(key,input.value);else S.drafts.delete(key);send.disabled=compose.classList.contains('offline')||!input.value.trim()&&!attCount(key);grow();slashSuggest(compose,input);};
 input.onblur=()=>setTimeout(()=>{if(document.activeElement!==input)slashClose(compose);},150);input.onfocus=()=>slashSuggest(compose,input);
 const attach=ib('plus','添加附件',imgMenu);attach.classList.add('attach');
 compose.append(attach,input,send);requestAnimationFrame(grow);return compose;}
function renderLiveState(live,a){
 live.replaceChildren();const st=a.agent_status;S.qaShown='';S.qaBar='';
 if(st==='blocked'){if(qaLive(live,a))return;const panel=el('section','confirm-panel');panel.setAttribute('role','alert');const h=el('div','confirm-head');h.append(icon('alert'));const t=el('strong','grow','等你确认');const at=statusSince(a);if(at)t.append(' ',since(at));h.append(t,btn('写消息','link-btn foot-write',footWrite,'pen'),btn('刷新','link-btn',()=>fetchTerminal(true)));panel.append(h);
  const pre=el('pre','confirm-screen');pre.id='confirm-screen';screenPaint(pre,S.terminalText||'正在读取终端画面…',S.terminalText&&S.terminalAnsi,12);panel.append(pre);
  const keys=el('div','confirm-keys');[['↑','up'],['↓','down'],['Enter 确认','enter'],['Esc','esc'],['Ctrl+C','ctrl+c']].forEach(([t,k])=>keys.append(btn(t,k==='enter'?'primary small':'secondary small',()=>sendKey(k,t))));panel.append(keys);live.append(panel);requestAnimationFrame(()=>{pre.scrollTop=pre.scrollHeight;});}
 // Working and 「做完了」 are one line in the footer rail (foot.js), not a block here.
 // A Codex question put aside with 「暂不回答」 stays one tap away (answer.js).
 if(st==='idle'||st==='done')qaAsyncBar(live);}
// 中断 sends Esc: both Claude Code and Codex stop the current turn on Esc and never quit on it,
// while a second Ctrl+C on an idle Claude would exit it. Ctrl+C stays in 终端按键.
function interruptButton(a){
 // Esc is checked for Claude Code and Codex only; another agent may treat it differently, so say so.
 const what=hasTranscript(a.agent)?'让 '+titleOf(a)+' 停下手上的事（发送 Esc，不会退出）。':'给 '+titleOf(a)+' 发送 Esc。多数 Agent 会停下当前这一步，但 '+providerName(a.agent)+' 具体怎么处理不一定，之后看一眼终端。';
 const b=btn('中断','secondary small',()=>confirmAction('中断 Agent？',what+'排队的消息会在它停下后接着发。','中断',async()=>{S.chat.interruptAt=Date.now();renderComposer();await sendKey('esc','Esc');setTimeout(()=>{if(S.chat)renderComposer();},4000);},true));
 b.disabled=!!S.chat?.interruptAt&&Date.now()-S.chat.interruptAt<4000;if(b.disabled)b.textContent='正在中断…';return b;}
async function sendKey(key,label){const a=S.chat?.agent;if(!a)return;try{await remote('key',{session:S.session,target:a.pane_id,identity:a.identity,key,id:uuid()});toast(S.demo?'演示：未发送按键':'已发送 '+label);setTimeout(()=>{refreshStatus();fetchTerminal(true);},700);}catch(e){toast('按键未确认：'+e.message+'。不会自动重发。');}}
async function sendMessage(input){
 const text=input.value;const a=S.chat?.agent;const key=draftKey();const pics=imgAttached(key).slice(),docs=fileAttached(key).slice();if((!text.trim()&&!pics.length&&!docs.length)||!a)return;
 if(!S.device&&!S.demo){toast('还在连接，连上后才能发送；草稿留着');return;}
 if(followHoldsSend())return;
 slashClose(input.closest('.composer'));
 // A panel left open by the last slash command would swallow this message (or Enter would pick in it).
 if(slashPanelCard(key)){if(S.slashChecking)return;S.slashChecking=true;let held;try{held=await slashHold(a,key);}finally{S.slashChecking=false;}if(held||slashPanelCard(key))return;return sendMessage(input);}
 // Busy, or something already waiting: it goes into the send queue (queue.js), in order.
 if(queueWants(a,key)){sendPulse(document.querySelector('#composer .send'));queueCompose(input,key,a,text,pics,docs);return;}
 const epoch=S.epoch,dev=S.device?.id;const button=document.querySelector('.send');sendPulse(button);button.disabled=true;
 const item={key,text,images:pics.map(p=>({url:p.thumb})),files:docs.map(f=>({file:f.name,size:f.size})),at:Date.now(),state:'sending',row:'s'+(++sendSeq)};
 // Slash commands get a 「命令输出」 card (slash.js) instead of a pending bubble: most never reach the transcript.
 const card=!S.demo&&!pics.length&&!docs.length&&slashIs(text,a)?slashCard(key,text):null;
 if(!S.demo){if(!card)S.outbox.push(item);S.stick=true;paintTimeline();}
 S.sendBusy=(S.sendBusy||0)+1;
 try{
  // Pictures go up first; only then is the one prompt sent (never resent automatically).
  const images=pics.length?await imgUpload(pics,stage=>{item.stage=stage;paintTimeline();}):null;
  const files=docs.length?await fileUpload(docs,a,stage=>{item.stage=stage;paintTimeline();}):null;item.stage='';
  await remote('prompt',{session:S.session,target:a.pane_id,identity:a.identity,text:card?text.trim():text,id:uuid(),...(dev&&!S.demo?{device:dev}:{}),...(images?{images,remote:!!a.history_ref?.remote}:{}),...(files?{files,remote:!!a.history_ref?.remote}:{})});
  if(S.demo){toast('演示模式：未发送，草稿已保留');return;}
  item.state='sent';if(card)card.state='sent';if(S.drafts.get(key)===text)S.drafts.delete(key);if(epoch===S.epoch&&input.value===text){input.value='';input.style.height='auto';}
  if(pics.length){imgSet(key,imgAttached(key).filter(p=>!pics.includes(p)));rpc('dropImages',{ids:pics.map(p=>p.id)}).catch(()=>{});}
  if(docs.length){fileSet(key,fileAttached(key).filter(f=>!docs.includes(f)));rpc('dropFiles',{ids:docs.map(f=>f.id)}).catch(()=>{});}
  // A slash command may not start a turn at all (/status), so no optimistic "working": Herdr's own state decides.
  if(S.chat?.agent){S.chat.sentAt=Date.now();S.chat.doneAt=0;if(!card)S.chat.agent={...S.chat.agent,agent_status:'working'};renderComposer();updateChatMeta();}
  S.stick=true;paintTimeline();if(card)slashCapture(card);if(epoch===S.epoch)setTimeout(()=>fetchHistory(),900);
  if(S.chat?.noTranscript&&!card){toast('发给 '+providerName(a.agent)+' 了，回复看终端');setTimeout(()=>{if(epoch===S.epoch)fetchTerminal(true);},900);}}
 catch(e){item.stage='';const notSent=/^没发出去/.test(e.message);if(!S.demo&&queueNotSent(e.message)){if(card)slashDrop(card);queueRejected(key,a,item,text,pics,input,e.message,docs);return;}queueHalt(key);item.state=notSent?'rejected':'failed';item.reason=e.message;if(card){card.state=item.state;card.reason=e.message;}paintTimeline();toast(notSent?e.message+'。草稿还在，处理好可以直接再发。':'发送未确认：'+e.message+'。草稿已保留，不会自动重发。');}
 finally{S.sendBusy=Math.max(0,(S.sendBusy||1)-1);button.disabled=!input.value.trim()&&!attCount(key);}}
// The send button answers the press at once (the haptic comes from native.js); the bubble follows.
let sendSeq=0;
function sendPulse(b){if(!b)return;b.classList.remove('fired');void b.offsetWidth;b.classList.add('fired');setTimeout(()=>b.classList.remove('fired'),400);}
function scrollBottom(){const n=document.getElementById('chat-scroll');if(n)n.scrollTop=n.scrollHeight;}
// A pending bubble disappears once the transcript shows the same user text.
function settleOutbox(){if(!S.outbox.length)return false;const count=S.outbox.length;
 const users=S.messages.filter(m=>m.kind==='user').slice(-8).map(m=>{const x=imgSplit(m);return {id:m.id,sig:msgSig(x.text)+'\u0000'+(x.specs.length?1:0),at:toDate(m.timestamp)?.getTime()||0};});
 const sig=o=>msgSig(o.text)+'\u0000'+(o.images?.length?1:0);
 // A send whose outcome was unknown, and whose text then shows up in the transcript (written after it
 // was sent, allowing for clock skew), did arrive. Anything still queued with the same words waits
 // for the person instead of going out a second time.
 for(const o of S.outbox){if(o.state!=='failed'||!users.some(u=>u.sig===sig(o)&&u.at>=o.at-120000))continue;
  o.state='sent';toast('刚才那条其实送到了');
  const q=Q.get(o.key),dup=q?.items.find(it=>it.state==='queued'&&it.text.trim()===o.text.trim());
  if(dup){dup.reason='和刚送到的那条一样，确认还要再发吗';queuePause(q,'排队里有一条和刚送到的消息一样，先停下。不需要就删掉，要发再点继续',true);}}
 // The transcript copy takes the bubble's place without an entrance of its own (timeline.js tlArrivals).
 S.outbox=S.outbox.filter(o=>{const u=o.state==='sent'&&users.find(u=>u.sig===sig(o));if(u){TL_HANDOFF.add(u.id);return false;}return Date.now()-o.at<180000;});return S.outbox.length!==count;}
// A finish only counts when Herdr itself reported working → stopped just now;
// the optimistic "working" set after sending must not flash "做完了".
function onAgentStatus(was,now){
 const rec=S.chat?.agent?S.since.get(agentKey(S.chat.agent)):null;
 if(was==='working'&&(now==='idle'||now==='done')&&rec?.prev==='working'&&rec.status===now&&Date.now()-rec.at<15000&&!kidsRunning(S.chat.agent)&&!bgHold(S.chat.agent)){
  S.chat.doneAt=Date.now();S.chat.took=rec.prevAt?rec.at-rec.prevAt:S.chat.sentAt?rec.at-S.chat.sentAt:0;
  const h=document.getElementById('chat-head');if(h){h.classList.remove('flash');void h.offsetWidth;h.classList.add('flash');}
  const doneAt=S.chat.doneAt;setTimeout(()=>{if(S.chat?.doneAt===doneAt)renderComposer();},8100);}
 renderComposer();updateChatMeta();
 // Rows depend on the state too (正在工作 / a Codex question becomes answerable once it stops):
 // repaint now instead of waiting for the transcript to change.
 if(S.chat?.record&&S.chatMode==='conversation'&&S.messages.length)paintTimeline();
 if(now==='blocked'){fetchTerminal(true);if(S.active)toast('Agent 在等你确认');}
 // Just stopped: it may have asked something. Read now and once more shortly after, in case the
 // transcript's last lines land a moment after Herdr's state.
 if(was==='working'&&now!=='working'){S.activity='';fetchHistory();const c=S.chat;setTimeout(()=>{if(S.chat===c&&!S.paused)fetchHistory();},1500);}}
// A screen read carries Herdr's state from the same request. Act on "blocked"/"working" at once so a
// question card shows without waiting for the next status poll; idle/done stay with the poll, because
// right after a send Herdr may not have noticed the new turn yet.
function applyReadStatus(now){
 const a=S.chat?.agent;if(!a||S.chat.stale||!['blocked','working'].includes(now)||now===a.agent_status)return;
 const updated={...a,agent_status:now};S.agents=S.agents.map(x=>x.pane_id===a.pane_id&&x.identity===a.identity?{...x,agent_status:now}:x);
 noteStatus([updated]);const was=a.agent_status;S.chat.agent=updated;onAgentStatus(was,now);}
async function fetchTerminal(quiet=false){
 if(!S.chat?.agent){if(!quiet)toast('这条历史没有在线终端');return;}const epoch=S.epoch;
 // Polls skip while a read for this chat is still out: on a slow link they would pile up behind each other.
 // A read asked for while one is out (e.g. the agent just stopped on a menu) runs right after it.
 if(quiet&&S.reading===epoch){S.readAgain=epoch;return;}S.reading=epoch;S.readAgain=null;
 // Colors cost a second screen read on the computer: ask only while the 终端 tab or the confirm screen shows.
  const color=S.chatMode==='terminal'||S.chat.agent.agent_status==='blocked';
  try{const r=await remote('read',{session:S.session,target:S.chat.agent.pane_id,identity:S.chat.agent.identity,...(color?{ansi:true}:{})});if(epoch!==S.epoch)return;S.terminalText=r.text;S.terminalAnsi=r.ansi||'';applyReadStatus(r.agent_status);qaScreen(r);modeScreen(r);
  const lines=r.text.split('\n').map(x=>x.trim()).filter(x=>x&&!/^[─━═\-_│|>›❯▌\s]+$/.test(x));S.activity=lines.at(-1)||'';
  screenPaint(document.getElementById('terminal-output'),r.text,S.terminalAnsi);const c=document.getElementById('confirm-screen');if(c){screenPaint(c,r.text,S.terminalAnsi,12);c.scrollTop=c.scrollHeight;}const l=document.getElementById('activity-line');if(l)l.textContent=S.activity;
  if(!S.chat.record&&S.chatMode==='conversation')paintTimeline();}
 catch(e){if(epoch!==S.epoch)return;if(!quiet)error(e);
  // Never leave 「正在读取…」 up after a failed read: say what happened and how to retry.
  if(!S.terminalText){const msg='读取终端画面失败：'+(e.message||e)+'。点「刷新」再试';screenPaint(document.getElementById('terminal-output'),msg,'');screenPaint(document.getElementById('confirm-screen'),msg,'');const l=document.getElementById('activity-line');if(l)l.textContent='读取终端失败，稍后会自动再试';}}
 finally{if(S.reading===epoch)S.reading=null;if(S.readAgain===epoch&&S.epoch===epoch){S.readAgain=null;setTimeout(()=>fetchTerminal(true),0);}}}

// ─── Sheets ─────────────────────────────────────────────────────────────────
function agentSwitcher(){
 const box=sheet('切换 Agent');
 if(S.chat?.record?.parent)menuItem(box,'返回父会话',async()=>{try{const r=await remote('catalog',{thread:S.chat.record.parent,...(S.chat.record.remote?{remote:S.chat.record.remote}:{})});if(r.records.length)openRecord(r.records[0],true);else toast('没找到父会话记录');}catch(e){error(e);}},'back');
 box.append(el('div','section-label','在线 Agent'));
 const all=liveAgents();if(!all.length)box.append(el('p','fine','还没读到在线 Agent，回到列表刷新一下。'));
 const current=S.chat?.agent?agentKey(S.chat.agent):'';const order={blocked:0,working:1,kids:1};
 sortAgents(all).sort((x,y)=>(order[agentState(x)]??2)-(order[agentState(y)]??2)).forEach(a=>{const k=agentKey(a),here=k===current;
  const b=btn('','menu-item agent-pick'+(here?' current':''),()=>{closeSheet();if(!here)openAgent(a);});if(here)b.setAttribute('aria-current','true');
  b.append(avatar(a.agent,stateTone(a)));const t=el('span','grow');t.append(el('span','menu-label',titleOf(a)),el('small','',(here?'当前 · ':'')+providerName(a.agent)+(a.tmux?' · tmux':'')+(projectOf(a)?' · '+projectOf(a):'')));b.append(t);
  if(S.unread.has(k))b.append(el('span','unread-dot'));b.append(el('span','badge '+stateTone(a),agentState(a)==='kids'?kidsShort(a):stateLabel(a)));box.append(b);});
 // This conversation's sub-agents, running first, live while the sheet is open (kids.js).
 kidsSection(box);}
function chatMenu(){
 const box=sheet('对话操作');
 menuItem(box,'在对话里搜索',findOpen,'search','消息、过程和命令输出');
 if(!S.chat.noTranscript){menuItem(box,'刷新对话',()=>{S.paused=false;fetchHistory(false,true);},'refresh');
  menuItem(box,S.paused?'恢复自动更新':'暂停自动更新',()=>{S.paused=!S.paused;toast(S.paused?'自动更新已暂停':'自动更新已恢复');},S.paused?'refresh':'pause');
  menuItem(box,'选择其他历史记录',pickHistory,'history');}
 if(S.chat.agent){menuItem(box,'终端按键',keyMenu,'terminal','↑ ↓ Enter Esc Ctrl+C'+(modeAgent(S.chat.agent)||modeShiftTab(S.chat.agent)?' Shift+Tab':''));menuItem(box,'查看终端',()=>{S.chatMode='terminal';S.epoch++;renderChat();fetchTerminal();},'terminal');}
 closeChatMenu(box);}
function keyMenu(){const box=sheet('终端按键');box.append(el('p','fine','先看一眼终端：Enter 可能会批准当前操作。'));[['↑ 上','up'],['↓ 下','down'],['Enter 确认','enter'],['Esc 返回','esc'],['Ctrl+C 中断','ctrl+c']].forEach(([t,key])=>{const b=btn(t,'menu-item',()=>{closeSheet();sendKey(key,t);});box.append(b);});
 if(modeAgent(S.chat?.agent)){const b=btn('Shift+Tab 切换模式','menu-item',()=>{closeSheet();modeCycle();});const why=modeBlockedWhy(S.chat.agent);b.disabled=!!why;if(why)b.title=why;box.append(b);}
 // Other agents: only when their own footer offers Shift+Tab (mode.js); what it does is theirs to say.
 else if(modeShiftTab(S.chat?.agent)){const a=S.chat.agent;const b=btn('Shift+Tab','menu-item',()=>{closeSheet();sendKey('shift+tab','Shift+Tab');});const why=a.agent_status==='blocked'?'它正等你确认，这时按 Shift+Tab 可能直接批准':'';b.disabled=!!why;if(why)b.title=why;box.append(b);}}
async function pickHistory(){
 const targetAgent=S.chat?.agent;const box=sheet('选择历史记录');box.append(el('p','fine','选中后先只读打开，不会把消息发给其他 Agent。'));const list=el('div','pick-list');let requestNumber=0;
 async function search(query=''){const token=++requestNumber;list.replaceChildren(el('div','loading','读取中…'));
  try{const r=await remote('catalog',{query,...(targetAgent?.history_ref?.remote?{remote:targetAgent.history_ref.remote}:{})});if(token!==requestNumber)return;list.replaceChildren();
   r.records.forEach(rec=>{const b=btn('','menu-item',()=>{closeSheet();chooseHistory(rec,targetAgent);});b.setAttribute('aria-label',rec.title+' · '+rec.thread.slice(0,8));const t=el('span','grow');t.append(el('span','menu-label',rec.title),el('small','',relative(rec.modified)+' · '+rec.thread.slice(0,8)));b.append(avatar(rec.provider),t);list.append(b);});
   if(!r.records.length)list.append(el('p','fine','没有匹配的记录'));if(r.next!==null&&r.next!==undefined)list.append(el('p','fine','超过 100 条，输入项目、标题或会话 ID 缩小范围。'));}
  catch(e){if(token===requestNumber)list.replaceChildren(el('p','note error',e.message));}}
 let timer;box.append(searchBox('搜索历史记录',q=>{clearTimeout(timer);timer=setTimeout(()=>search(q),400);}),list);await search(targetAgent?.history_ref?.query||'');}
function chooseHistory(rec,targetAgent){
 if(!targetAgent||targetAgent.agent_session?.value||rec.provider!==targetAgent.agent){openRecord(rec,true);return;}
 const box=sheet('确认历史与在线会话对应');
 box.append(el('p','fine','没能自动确认这个窗格的会话。只有确定这段记录属于下面的在线 Agent 时才关联；不会恢复或新建会话。'));
 const pair=el('div','card pair');pair.append(el('div','card-meta','在线 Agent'),el('div','card-title',titleOf(targetAgent)+' · '+targetAgent.pane_id),el('div','card-meta','历史记录'),el('div','card-title',rec.title+' · '+rec.thread.slice(0,8)));box.append(pair);
 const actions=el('div','sheet-actions');
 actions.append(btn('只读查看','secondary',()=>{closeSheet();openRecord(rec,true);}),btn('关联当前 Agent','primary',()=>{closeSheet();S.bindings.set(S.session+'/'+targetAgent.identity,rec);resetChat({agent:targetAgent,record:rec,title:titleOf(targetAgent),provider:targetAgent.agent,manual:true});S.epoch++;renderChat();fetchHistory(false,true);}));box.append(actions);}

// ─── History tab ────────────────────────────────────────────────────────────
// Day sections (sticky), filter chips with counts, debounced search and endless scrolling.
// Filters work on what is loaded; a "+" on a count means more pages are still on the computer.
let searchTimer;
const HISTORY_FILTERS=[['all','全部',()=>true],['codex','Codex',r=>r.provider==='codex'],['claude','Claude',r=>r.provider==='claude'],['child','子 Agent',r=>!!r.parent]];
function historyPage(main){
 if(!requireDevice(main))return;
 const head=el('div','row list-actions search-row');
 head.append(searchBox('搜索项目、标题或会话 ID',q=>{clearTimeout(searchTimer);S.catalogPending=q;historySummary();searchTimer=setTimeout(()=>loadCatalog(q.trim()),300);},S.catalogQuery||''),ib('refresh','刷新历史',()=>loadCatalog(S.catalogQuery||'')));main.append(head);
 const filters=el('div','tabs chips');filters.id='history-filters';filters.setAttribute('aria-label','筛选历史');main.append(filters);closeLoadHidden();
 const summary=el('div','list-status');summary.id='history-summary';main.append(summary);
 const list=el('div','history-list');list.id='history-list';main.append(list);renderHistoryList();
 pullRefresh(main,()=>loadCatalog(S.catalogQuery||''));}
function historyFilters(){
 const box=document.getElementById('history-filters');if(!box)return;box.replaceChildren();
 const hidden=new Set(closeHiddenIds()),shown=S.records.filter(r=>!hidden.has(r.id)),more=S.next!==null&&S.next!==undefined?'+':'';
 // Nothing read yet (loading, failed or truly empty): a row of zero counts only adds noise.
 box.classList.toggle('hidden',!S.records.length&&!S.catalogQuery&&!closeHiddenIds().length);
 // A filter with nothing behind it (and no more pages to read) is left out, unless it is the one on.
 for(const [id,label,test] of HISTORY_FILTERS){const n=shown.filter(test).length;if(id!=='all'&&!n&&!more&&S.filter!==id&&!S.catalogQuery)continue;box.append(chip(label,id==='all'?(S.catalogQuery?S.total:Math.max(n,(S.total||0)-hidden.size)):n+more,S.filter===id,()=>{S.filter=id;renderHistoryList();document.getElementById('history-list')?.scrollIntoView?.({block:'start'});}));}
 for(const [id,label] of closeHiddenFilter()){const b=btn(label,'pill chip'+(S.filter===id?' active':''),()=>{S.filter=id;renderHistoryList();});b.setAttribute('aria-pressed',String(S.filter===id));box.append(b);}}
// "找到 12 条" while searching; "正在搜索…" until the debounced read is back.
function historySummary(){
 const n=document.getElementById('history-summary');if(!n)return;n.replaceChildren();
 const q=S.catalogPending!==undefined?S.catalogPending.trim():S.catalogQuery||'';
 if(q&&(q!==S.catalogQuery||S.catalogLoading)){n.append(el('span','spinner small-spin'),el('span','grow list-facts','正在搜索「'+q+'」…'));return;}
 if(S.catalogQuery)n.append(el('span','grow list-facts','「'+S.catalogQuery+'」找到 '+S.total+' 条'));}
function historyRow(r,hidden){
 const b=btn('','card-button history-row',()=>openRecord(r));const text=el('div','grow');text.append(el('div','card-title',r.title));
 const meta=el('div','card-meta');const project=(r.cwd||'').split('/').filter(Boolean).pop();meta.append(el('span','project',project||providerName(r.provider)));if(r.parent)meta.append(el('span','tag child-tag','子 Agent'));text.append(meta);
 const side=el('div','row-side');side.append(el('span','row-time',clock(r.modified)));
 b.append(avatar(r.provider),text,side);closeHold(b,()=>historyActions(r));
 return closeSwipe(b,[[hidden?'放回':'移除',hidden?'history':'x',hidden?'':'danger',()=>closeSetHidden(r,!hidden)],['更多','more','',()=>historyActions(r)]]);}
function renderHistoryList(){
 const list=document.getElementById('history-list');if(!list)return;historyFilters();historySummary();list.replaceChildren();
 const test=(HISTORY_FILTERS.find(f=>f[0]===S.filter)||HISTORY_FILTERS[0])[2];
 const records=closeVisible(S.records.filter(r=>S.filter==='hidden'||test(r)));
 const more=S.next!==null&&S.next!==undefined;
 if(!records.length){
  if(S.catalogLoading)skeleton(list,5);
  else if(S.catalogQuery)empty(list,'没有匹配的记录','换个关键词试试：项目名、标题里的词，或者会话 ID 的开头。',btn('清除搜索','secondary',()=>{S.catalogPending=undefined;S.catalogQuery='';render();loadCatalog('');}));
  else if(S.filter!=='all'&&S.filter!=='hidden'&&more){list.append(el('p','fine center','已读到的记录里没有，继续往下加载…'));}
  else if(S.filter!=='all'&&S.filter!=='hidden')empty(list,'这一类还没有记录','切回「全部」看看。',btn('看全部','secondary',()=>{S.filter='all';renderHistoryList();}));
  // A failed first read is not an empty history: say so, with the one way forward.
  else if(S.catalogError&&S.filter!=='hidden'){empty(list,'历史读取失败',S.catalogError,btn('重新读取','primary',()=>loadCatalog('')),'history');return;}
  else if(S.filter!=='hidden')empty(list,'还没有历史记录','只显示当前 SSH 用户的 Codex / Claude 本地历史。开一个会话，聊过的内容会出现在这里。',btn('新建会话','primary',()=>{setTab('live');openCreate();},'plus'));
  if(!more||S.filter==='all'){closeHiddenNote(list);return;}}
 const hidden=new Set(closeHiddenIds());
 let day='',group=null;
 for(const r of records){const d=dayLabel(r.modified);if(d!==day||!group){day=d;const h=el('div','section-label day-label',d||'更早');list.append(h);group=el('div','card list-card');list.append(group);}
  group.append(historyRow(r,hidden.has(r.id)));}
 closeHiddenNote(list);
 if(more){const b=btn(S.catalogLoading?'正在加载…':'加载更多历史','secondary wide load-more',()=>loadCatalog(S.catalogQuery||'',true));b.disabled=!!S.catalogLoading;list.append(b);
  // Endless scroll: the button loads by itself once it scrolls into view.
  if(typeof IntersectionObserver!=='undefined'){const io=new IntersectionObserver(es=>{if(es.some(e=>e.isIntersecting)&&b.isConnected&&!S.catalogLoading){io.disconnect();loadCatalog(S.catalogQuery||'',true);}},{root:list.closest('.main'),rootMargin:'0px 0px 400px 0px'});io.observe(b);}}
 else if(records.length>20)list.append(el('p','fine center list-end','到底了 · 共 '+records.length+' 条'));}
async function loadCatalog(query='',more=false){
 if(!S.device)return;if(more&&S.catalogLoading)return;const epoch=++S.epoch;S.catalogLoading=true;
 if(!more&&!S.records.length){renderHistoryList();if(!query)cacheShowCatalog();}else if(more)renderHistoryList();else historySummary();
 try{const r=await remote('catalog',{offset:more?S.next||0:0,query});if(epoch!==S.epoch)return;S.records=more?S.records.concat(r.records):r.records;S.total=r.total;S.catalogError='';S.next=r.next;S.catalogQuery=query;if(S.catalogPending!==undefined&&S.catalogPending.trim()===query)S.catalogPending=undefined;if(!more&&!query)cacheCatalog();if(!more&&S.tab==='history'){const m=document.querySelector('.main');if(m)m.scrollTop=0;}}
 catch(e){if(epoch===S.epoch){if(!more&&!query&&!S.records.length)S.catalogError=e.message||String(e);else error(e);}}
 finally{if(epoch===S.epoch){S.catalogLoading=false;if(S.tab==='history'&&!S.chat){if(more||query||document.querySelector('.search input:focus'))renderHistoryList();else render();}}}}

// ─── Back & lifecycle ───────────────────────────────────────────────────────
function pocketBack(){
 if(overlay.childElementCount){closeSheet();return;}
 if(T.view){leaveTerminal();render();return;}
 if(S.chatStack.length){const prev=S.chatStack.pop();S.chat=prev;S.chatMode=prev.mode||'conversation';S.messages=prev.savedMessages||[];S.children=prev.savedChildren||[];S.before=prev.savedBefore||0;S.more=!!prev.savedMore;S.stick=prev.savedStick!==false;S.unseen=0;S.epoch++;renderChat();if(!S.stick)document.getElementById('chat-scroll').scrollTop=prev.savedScroll||0;if(prev.record&&!S.messages.length)fetchHistory(false,true);return;}
 if(S.chat){S.chat=null;S.epoch++;render();return;}
 if(S.tab!=='live'&&S.device)setTab('live');else if(S.tab!=='devices')setTab('devices');else toast('设备和保存的密码都在，可以直接关闭应用');}
window.pocketBack=pocketBack;
addEventListener('resize',()=>{const c=document.getElementById('confirm-screen');if(c)c.scrollTop=c.scrollHeight;});
window.setForeground=v=>{S.active=v;if(v){netForeground();refreshStatus();if(S.chat?.record&&!S.paused)fetchHistory();}};
// Busy agents refresh faster; nothing polls in the background or in demo mode.
// A ch pane's history is read over SSH on the other computer (~1 s a read), so it is polled
// half as often: every 5 s while the agent works, every 10 s when idle. Reads never overlap.
function historyDue(busy,n){return S.chat?.record?.remote?n%(busy?2:4)===0:busy||n%3===0;}
// Beat: 1.25 s. Reads keep their 2.5 s pace; the cheap Herdr status (~0.1 s) is asked every beat
// while the open agent works or just changed state or got a message, so a stop (and a question
// asked right before it) shows within about a second. The list polls every 2.5 s while anything
// works or waits, else every 7.5 s.
const POLL_BEAT=1250,POLL_HOT=15000,REPLY_WAIT=60000;
// Herdr can report a stop before the reply reaches the transcript (it watches the screen; a ch pane's
// transcript is a remote read away). While the newest prompt has no reply yet, say so and read fast
// instead of showing 已完成 over a conversation that seems to have been ignored.
function awaitingReply(){
 const c=S.chat,a=c?.agent;if(!a||c.stale||!c.record||!['idle','done'].includes(a.agent_status))return false;
 let user=null,reply=-1,last=-1;S.messages.forEach((m,i)=>{if(m.kind==='user'&&!/^\s*\//.test(m.text||'')){user=m;last=i;}else if(m.kind==='assistant')reply=i;});
 const sent=S.outbox.some(o=>o.key===draftKey()&&o.state==='sent'&&!/^\s*\//.test(o.text));
 if(!sent&&!(user&&last>reply))return false;
 const at=Math.max(c.sentAt||0,sent?Math.max(...S.outbox.filter(o=>o.key===draftKey()).map(o=>o.at)):0,toDate(user?.timestamp)?.getTime()||0);
 return Date.now()-at<REPLY_WAIT;}
function pollHot(){const c=S.chat,a=c?.agent;if(!a||c.stale)return false;if(a.agent_status==='working')return true;
 const rec=S.since.get(agentKey(a));return Date.now()-Math.max(c.sentAt||0,rec?.at||0)<POLL_HOT;}
function listHot(){return S.agents.some(a=>['working','blocked'].includes(a.agent_status)||Date.now()-(statusSince(a)||0)<POLL_HOT);}
let tick=0;
function pollBeat(){
 if(!S.active||S.demo||!S.device)return;tick++;const beat=tick%2===0,n=tick>>1;
 const busy=S.chat?.agent&&!S.chat.stale&&['working','blocked'].includes(S.chat.agent.agent_status);
 if(S.chat){const reply=awaitingReply();if(reply){if(!S.paused&&!S.polling&&S.chatMode!=='terminal')fetchHistory();updateChatMeta();}
  if(beat){if(!reply&&!S.paused&&!S.polling&&S.chatMode!=='terminal'&&historyDue(busy,n))fetchHistory();if((busy||S.chat.noTranscript&&S.chatMode==='terminal'&&(pollHot()||n%4===0))&&S.chatMode!=='commands')fetchTerminal(true);}
  if(beat||pollHot())refreshStatus();}
 else if(S.tab==='live'&&tick%(listHot()?2:6)===0)refreshStatus().then(()=>glanceRefresh());}
setInterval(pollBeat,POLL_BEAT);

async function boot(){render();try{const r=await rpc('devices');S.devices=r.devices;S.version=r.version;S.alerts=r.alerts!==false;settingsLoad().then(updateAutoCheck);linkBoot(r);if(r.connected&&!S.device){S.device=r.connected;setTab('live');resumeBoot(r);return;}render();resumeBoot(r);}catch(e){error(e);}}
// terminals.js is a later <script>: start once every script has run, or a fast native reply
// can reach code that is not defined yet.
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
