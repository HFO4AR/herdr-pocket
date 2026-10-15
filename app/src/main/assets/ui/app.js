'use strict';
// Herdr Pocket UI. Plain DOM, no innerHTML: every remote string is inserted as text.
// terminals.js shares the helpers and state declared here (S, el, btn, ib, sheet, remote…).

// ─── Icons & DOM helpers ────────────────────────────────────────────────────
const paths={chat:'M4 4h16v12H8l-4 4V4z',history:'M3 12a9 9 0 1 0 3-6M3 3v6h6M12 7v5l3 2',device:'M4 4h16v12H4zM8 20h8M12 16v4',account:'M20 21v-2a7 7 0 0 0-14 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8',plus:'M12 5v14M5 12h14',back:'M15 5l-7 7 7 7',close:'M6 6l12 12M18 6L6 18',search:'M21 21l-5-5M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16',chevron:'M9 5l7 7-7 7',down:'M6 9l6 6 6-6',send:'M12 19V5M5 12l7-7 7 7',more:'M5 12h.01M12 12h.01M19 12h.01',terminal:'M4 6l6 6-6 6M12 18h8',branch:'M6 3v12a4 4 0 0 0 8 0V9M10 9l4-4 4 4',refresh:'M20 7a8 8 0 1 0 1 7M20 3v5h-5',lock:'M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4',check:'M4 12l5 5L20 6',edit:'M16 3l5 5-12 12H4v-5z',folder:'M3 6h7l2 2h9v12H3z',pause:'M8 5v14M16 5v14',file:'M6 2h8l5 5v15H6zM14 2v5h5',pen:'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',globe:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',tool:'M14 7a4 4 0 0 0 5 5l-8 8-4-4 8-8z',x:'M7 7l10 10M17 7L7 17',copy:'M9 9h11v11H9zM5 15V4h11',alert:'M12 3l10 18H2zM12 10v5M12 18h.01',stop:'M6 6h12v12H6z',plug:'M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4'};
function icon(name){const n=document.createElementNS('http://www.w3.org/2000/svg','svg');n.setAttribute('viewBox','0 0 24 24');n.setAttribute('aria-hidden','true');const p=document.createElementNS(n.namespaceURI,'path');p.setAttribute('d',paths[name]||paths.chat);n.append(p);return n;}
function el(tag,cls,text){const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;}
function btn(text,cls,fn,name){const n=el('button',cls);n.type='button';if(name)n.append(icon(name));if(text)n.append(document.createTextNode(text));n.onclick=fn;return n;}
function ib(name,label,fn){const n=btn('','icon-btn',fn,name);n.setAttribute('aria-label',label);n.title=label;return n;}
function uuid(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const r=Math.random()*16|0;return(c==='x'?r:(r&3|8)).toString(16);});}

// ─── Native bridge ──────────────────────────────────────────────────────────
let seq=0;const pending=new Map();
function rpc(op,args={},progress){return new Promise((resolve,reject)=>{const id='r'+(++seq);pending.set(id,{resolve,reject,progress});try{PocketNative.request(id,op,JSON.stringify(args));}catch(e){pending.delete(id);reject(e);}});}
window.nativeResult=(id,r)=>{const p=pending.get(id);if(!p)return;pending.delete(id);r.ok?p.resolve(r.data):p.reject(new Error(r.error));};
window.nativeProgress=(id,stage)=>{pending.get(id)?.progress?.(stage);};
// Connection events pushed by the native layer (silent reconnects).
window.nativeEvent=e=>{
 if(e.type==='reconnecting'){S.reconnecting=true;toast('连接断了，正在重新连接…');}
 else if(e.type==='reconnected'){S.reconnecting=false;toast('已重新连接');if(typeof T!=='undefined'&&T.shell&&!T.shell.ended){T.shell.ended=true;terminalStatus(T.shell,'连接中断过，这个 SSH 终端已结束；返回列表重新打开');}}
 else if(e.type==='reconnect_failed'){S.reconnecting=false;}};
window.openFromNotification=pane=>{S.pendingPane=pane;if(!S.device)return;const a=S.agents.find(x=>x.pane_id===pane);if(a){openPending();return;}setTab('live');};
function openPending(){const pane=S.pendingPane;if(!pane||!S.device)return;S.pendingPane=null;const a=S.agents.find(x=>x.pane_id===pane);if(!a){toast('那个 Agent 已经不在这个会话里了');return;}if(typeof T!=='undefined')leaveTerminal();closeSheet();openAgent(a);}
// The background watcher only notifies about changes after what the UI already showed.
function syncWatch(){if(S.demo||!S.device||!S.session)return;const states={};S.agents.forEach(a=>{states[a.pane_id+'/'+a.identity]=a.agent_status||'';});rpc('watchState',{session:S.session,states}).catch(()=>{});}
// Reassignable on purpose: offline tests wrap it to observe requests.
let remote=(op,args={})=>S.demo?demoRequest(op,args):rpc('remote',{op,...args});

// ─── State ──────────────────────────────────────────────────────────────────
const S={tab:'devices',devices:[],device:null,demo:false,version:'',agents:[],session:'',sessions:[],records:[],next:null,total:0,
 chat:null,chatMode:'conversation',messages:[],children:[],before:0,more:false,drafts:new Map(),bindings:new Map(),outbox:[],
 epoch:0,active:true,polling:false,paused:false,loading:false,connecting:null,connectStage:'',connectError:'',liveLoading:false,liveError:'',
 chatStack:[],search:'',filter:'all',account:null,activity:'',statusBusy:false,statusSupported:true};
const app=document.getElementById('app'),overlay=document.getElementById('overlay');

// ─── Feedback ───────────────────────────────────────────────────────────────
let toastTimer;
function toast(text){const n=document.getElementById('toast');n.textContent=text;n.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>n.classList.remove('show'),4200);}
function error(e){toast(e.message||String(e));}
async function copyText(text){try{await navigator.clipboard.writeText(text);}catch(_){const t=el('textarea');t.value=text;document.body.append(t);t.select();document.execCommand('copy');t.remove();}toast('已复制');}
function sheet(title){overlay.replaceChildren();const back=el('div','sheet-backdrop');const body=el('section','sheet');body.setAttribute('role','dialog');body.setAttribute('aria-modal','true');body.setAttribute('aria-label',title);body.append(el('div','sheet-grip'));const head=el('div','sheet-head');head.append(el('h2','',title),ib('close','关闭',closeSheet));body.append(head);back.append(body);back.onclick=e=>{if(e.target===back)closeSheet();};overlay.append(back);return body;}
function closeSheet(){overlay.replaceChildren();}
function confirmAction(title,text,label,action,danger){const box=sheet(title);box.append(el('p','muted',text));const row=el('div','sheet-actions');row.append(btn('取消','secondary',closeSheet),btn(label,'primary'+(danger?' danger-fill':''),()=>{closeSheet();action();}));box.append(row);}
function menuItem(box,label,fn,name,detail){const b=btn('','menu-item',()=>{closeSheet();fn();},name);const t=el('span','grow');t.append(el('span','menu-label',label));if(detail)t.append(el('small','',detail));b.append(t);box.append(b);return b;}

// ─── Formatting ─────────────────────────────────────────────────────────────
const STATUS={working:['执行中','work'],blocked:['等你确认','alert'],idle:['空闲','ok'],done:['已完成','ok']};
function stateLabel(a){return (STATUS[a?.agent_status]||['状态未知','muted'])[0];}
function stateTone(a){return (STATUS[a?.agent_status]||['','muted'])[1];}
function providerName(p){return p==='claude'?'Claude':p==='codex'?'Codex':'Agent';}
// Prefer names that tell agents apart: Herdr's agent title, a meaningful terminal
// title (not the generic "<dir>: ch" / "<dir>: claude"), then the first prompt.
function cleanTitle(t){return String(t||'').replace(/^[\s✳✻✽✶⠀-⣿·•*]+/,'').replace(/\s*\|\s*[^|]+$/,'').trim();}
function genericTitle(t,a){return !t||/^[^:]{1,60}:\s*(ch|claude|codex|bash|zsh|sh|ssh)$/i.test(t)||t===a.agent||/^(claude|codex)( code)?$/i.test(t);}
function titleOf(a){for(const raw of [a.title,a.terminal_title_stripped,a.terminal_title]){const t=cleanTitle(raw);if(!genericTitle(t,a))return t;}
 const first=cleanTitle(a.history_ref?.record?.title);if(first&&!/^This session is being continued/.test(first))return first.slice(0,60);
 return providerName(a.agent)+(projectOf(a)?' · '+projectOf(a):'');}
function projectOf(a){const p=a.foreground_cwd||a.cwd||'';return p.split('/').filter(Boolean).pop()||'';}
function toDate(v){if(!v)return null;const d=new Date(typeof v==='number'?v*1000:v);return isNaN(d)?null:d;}
function time(v){const d=toDate(v);return d?d.toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'';}
function clock(v){const d=toDate(v);return d?d.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):'';}
function dayLabel(v){const d=toDate(v);if(!d)return '';const today=new Date();today.setHours(0,0,0,0);const diff=Math.round((today-new Date(d).setHours(0,0,0,0))/864e5);return diff===0?'今天':diff===1?'昨天':diff<7&&diff>0?['周日','周一','周二','周三','周四','周五','周六'][d.getDay()]:d.toLocaleDateString('zh-CN',{month:'long',day:'numeric'});}
function relative(v){const d=toDate(v);if(!d)return '';const s=(Date.now()-d)/1000;if(s<60)return '刚刚';if(s<3600)return Math.floor(s/60)+' 分钟前';if(s<86400&&dayLabel(v)==='今天')return clock(v);return dayLabel(v)==='昨天'?'昨天 '+clock(v):time(v);}
function avatar(kind,status){const n=el('div','avatar '+(kind||''),kind==='claude'?'Cl':kind==='codex'?'Cx':'');if(!kind)n.append(icon('device'));if(status)n.append(el('span','status-dot '+status));return n;}
function draftKey(){return S.chat?.agent?S.session+'/'+S.chat.agent.identity:S.chat?.record?.id||'';}

// ─── App shell & navigation ─────────────────────────────────────────────────
const TABS=[['live','chat','会话'],['history','history','历史'],['terminals','terminal','终端'],['devices','device','设备']];
function setTab(tab){leaveTerminal();S.chat=null;S.chatStack=[];S.tab=tab;S.epoch++;S.liveLoading=false;render();if(tab==='terminals'&&S.device)loadPanes();if(tab==='live'&&S.device)loadLive();if(tab==='history'&&S.device)loadCatalog();if(tab==='devices'&&S.device&&!S.account)loadAccount();}
function shell(){app.replaceChildren();const root=el('div','shell');app.append(root);if(S.demo)root.append(el('div','demo-banner','离线演示 · 示例数据，不连接电脑'));return root;}
function header(root){
 const bar=el('header','topbar');const title=(TABS.find(t=>t[0]===S.tab)||[])[2]||'Herdr Pocket';bar.append(el('h1','',title));
 const chip=btn('','device-chip',()=>setTab('devices'));chip.setAttribute('aria-label','当前设备');chip.append(el('span',S.loading?'spinner':S.device?'dot':'dot offline'),el('span','truncate',S.loading?'连接中':S.device?S.device.name:'未连接'));bar.append(chip);root.append(bar);
 if(S.loading||S.connectError){const box=el('div','connection-status'+(S.connectError?' failed':''));box.setAttribute('role','status');if(S.loading)box.append(el('span','spinner'));else box.append(icon('alert'));const text=el('div','grow');text.append(el('strong','',S.connectError?'连接未完成':'正在连接 '+(S.connecting?.name||S.device?.name||'')),el('div','',S.connectError||S.connectStage));box.append(text);if(S.connectError&&S.connecting)box.append(btn('重试','secondary small',()=>S.device?setupBridge():connectDevice(S.connecting)));root.append(box);}
}
function pageHead(main,kicker,title,subtitle,action){const h=el('div','page-head');const t=el('p','grow',subtitle||'');h.append(t);if(action)h.append(action);main.append(h);}
function loadingCard(main,title,detail){const box=el('div','loading-card');box.setAttribute('role','status');box.setAttribute('aria-live','polite');box.append(el('span','spinner'));const text=el('div');text.append(el('h2','',title),el('p','muted',detail));box.append(text);main.append(box);}
function skeleton(main,rows=4){for(let i=0;i<rows;i++){const r=el('div','skeleton-row');r.append(el('div','sk-avatar'),el('div','sk-lines'));main.append(r);}}
function empty(main,title,desc,action){const n=el('div','empty');const a=el('div','empty-icon');a.append(icon('chat'));n.append(a,el('h2','',title),el('p','',desc));if(action)n.append(action);main.append(n);}
function render(){
 if(S.chat){renderChat();return;}if(typeof T!=='undefined'&&T.view){renderTerminal();return;}
 const root=shell();header(root);const main=el('main','main pane-enter');root.append(main);
 if(S.tab==='live')livePage(main);else if(S.tab==='history')historyPage(main);else if(S.tab==='terminals')terminalsPage(main);else devicesPage(main);
 const nav=el('nav','bottom-nav');nav.setAttribute('aria-label','主导航');
 const waiting=S.agents.filter(a=>a.agent_status==='blocked').length;
 TABS.forEach(([tab,i,label])=>{const n=btn(label,'nav-item'+(S.tab===tab?' active':''),()=>setTab(tab),i);n.setAttribute('aria-current',S.tab===tab?'page':'false');if(tab==='live'&&waiting){const badge=el('span','nav-badge',String(waiting));badge.setAttribute('aria-hidden','true');n.append(badge);n.title=waiting+' 个 Agent 等你确认';}nav.append(n);});
 root.append(nav);}
function requireDevice(main){if(S.device)return true;if(S.loading){loadingCard(main,'连接正在进行','连接成功后会自动读取会话，请稍候。');return false;}empty(main,'先连接你的电脑','连接后，在线会话、历史记录和终端会出现在这里。',btn('选择设备','primary',()=>setTab('devices')));return false;}
function searchBox(placeholder,change,value=''){const box=el('div','search');const input=el('input');input.type='search';input.placeholder=placeholder;input.value=value;input.setAttribute('aria-label',placeholder);input.oninput=()=>change(input.value);box.append(icon('search'),input);return box;}

// ─── Devices & connection ───────────────────────────────────────────────────
function devicesPage(main){
 rpc('protect').catch(error);
 if(S.device)main.append(connectionCard());
 const head=el('div','section-head');head.append(el('span','section-label','保存的设备'),ib('plus','添加设备',()=>deviceForm()));main.append(head);
 if(!S.devices.length){const n=el('div','card intro');n.append(el('h2','','添加运行 Herdr 的电脑'),el('p','muted','填 SSH 地址即可，局域网、Tailscale、Sakura Frp 的 TCP 入口都可以。'));const b=btn('添加第一台设备','primary',()=>deviceForm());n.append(b);main.append(n);}
 for(const d of S.devices){const current=S.device?.id===d.id&&!S.demo;const card=el('section','card device-card'+(current?' current':''));const row=el('div','row');row.append(avatar('',current?'ok':''));const text=el('div','grow');text.append(el('div','card-title',d.name),el('div','card-meta truncate',d.user+' @ '+d.host+':'+d.port));row.append(text,ib('edit','编辑 '+d.name,()=>deviceForm(d)));card.append(row);
  const line=el('div','device-line');line.append(icon('lock'),document.createTextNode(d.remember?'密码已加密保存':'连接时输入密码'));card.append(line);
  const actions=el('div','device-actions');const busy=S.loading&&S.connecting?.id===d.id;const connect=btn(busy?'正在连接…':current?'已连接':'连接设备',current?'secondary':'primary',()=>connectDevice(d));connect.disabled=S.loading;actions.append(connect,btn('删除','secondary danger',()=>confirmAction('删除设备？','会移除这台设备及其保存的密码。','删除',async()=>{try{S.devices=(await rpc('deleteDevice',{id:d.id})).devices;render();}catch(e){error(e);}},true)));card.append(actions);main.append(card);}
 const demo=btn('体验聊天演示','secondary wide',startDemo);main.append(demo);
 main.append(el('p','fine','设备资料和勾选保存的密码用 Android Keystore 加密，只存在这台手机上。'));}
function connectionCard(){
 const card=el('section','card account-card');const top=el('div','row');top.append(avatar('', 'ok'));const t=el('div','grow');t.append(el('div','card-title',S.device.name),el('div','card-meta',S.demo?'离线演示':'SSH 已连接'));top.append(t);card.append(top);
 [['SSH 用户',S.account?.ssh_user||S.device.user],['主机地址',S.device.host],['端口',String(S.device.port)],['电脑主机名',S.account?.hostname||'读取中…'],['密码保存',S.device.remember?'已加密保存':'未保存'],['应用版本',S.version||'—']].forEach(([k,v])=>{const n=el('div','setting-row');n.append(el('span','',k),el('span','',v));card.append(n);});
 if(!S.demo){const toggle=el('label','switch-row');const box=el('input');box.type='checkbox';box.checked=S.alerts!==false;box.setAttribute('aria-label','后台提醒');box.onchange=async()=>{try{S.alerts=(await rpc('setAlerts',{enabled:box.checked})).alerts;toast(S.alerts?'切到后台时会继续关注 Agent':'已关闭后台提醒');}catch(e){box.checked=!box.checked;error(e);}};const t=el('span','grow');t.append(el('strong','','后台提醒'),el('small','','切到后台后，Agent 完成或等你确认时发通知'));toggle.append(t,box,el('span','switch'));card.append(toggle);}
 const actions=el('div','device-actions');actions.append(btn('更新桥接程序','secondary',setupBridge),btn('断开连接','secondary danger',()=>confirmAction('断开当前设备？','电脑上的 Agent 会继续运行。','断开',()=>disconnect().catch(error),true)));card.append(actions);
 card.append(el('p','fine','只显示 SSH 连接信息，不读取 Codex / Claude 的登录资料。'));return card;}
function field(box,title,value='',type='text',placeholder=''){const label=el('label','',title);const input=el('input','field');input.type=type;input.value=value;input.placeholder=placeholder;input.autocomplete='off';input.setAttribute('aria-label',title);label.append(input);box.append(label);return input;}
function deviceForm(d={}){rpc('protect').catch(error);const box=sheet(d.id?'编辑设备':'添加设备');const name=field(box,'设备名称',d.name||'','','例如：家里的电脑');const grid=el('div','form-grid');box.append(grid);const host=field(grid,'主机地址',d.host||'','text','域名或 IP');const port=field(grid,'端口',d.port||22,'number');const user=field(box,'SSH 用户名',d.user||'');const pass=field(box,'登录密码','','password',d.remember?'已保存；留空保留原密码':'输入 SSH 密码');const check=el('label','check');const remember=el('input');remember.type='checkbox';remember.checked=d.remember!==false;check.append(remember,document.createTextNode('记住密码 · 本机加密保存'));box.append(check);box.append(el('p','fine','更换主机或用户名后，需要重新输入密码。'));const actions=el('div','sheet-actions');const save=btn('保存设备','primary',async()=>{save.disabled=true;try{const r=await rpc('saveDevice',{id:d.id||'',name:name.value,host:host.value,port:Number(port.value),user:user.value,password:pass.value,remember:remember.checked});pass.value='';S.devices=r.devices;closeSheet();render();toast('设备已保存');}catch(e){error(e);}finally{save.disabled=false;}});actions.append(btn('取消','secondary',closeSheet),save);box.append(actions);}
function connectionPassword(d){const box=sheet('连接 '+d.name);const pass=field(box,'本次登录密码','','password');const label=el('label','check');const remember=el('input');remember.type='checkbox';remember.checked=true;remember.setAttribute('aria-label','记住本次登录密码');label.append(remember,document.createTextNode('记住密码 · 登录成功后加密保存'));box.append(label,el('p','fine','勾选后，下次点这台设备就能直接连接。'));const actions=el('div','sheet-actions');const go=()=>{if(!pass.value){toast('请输入登录密码');return;}const value=pass.value,save=remember.checked;pass.value='';closeSheet();doConnect(d,value,save);};pass.onkeydown=e=>{if(e.key==='Enter')go();};actions.append(btn('连接','primary',go));box.append(actions);setTimeout(()=>pass.focus(),50);}
function connectDevice(d){if(S.loading){toast('正在连接，请稍候');return;}if(S.device?.id===d.id&&!S.demo){setTab('live');return;}if(!d.remember)connectionPassword(d);else doConnect(d);}
async function doConnect(d,password='',remember){
 if(S.loading)return;
 if(S.device&&!S.demo&&S.device.id!==d.id){confirmAction('切换设备？','当前 SSH 连接会断开；未发送的草稿只在本次运行中保留。','切换',async()=>{await disconnect(false);doConnect(d,password,remember);});return;}
 S.loading=true;S.connecting=d;S.connectError='';S.connectStage='正在建立 SSH 连接并验证身份…';render();
 try{if(S.demo){S.demo=false;S.device=null;}
  const r=await rpc('connect',{id:d.id,password,...(remember===undefined?{}:{remember})},stage=>{S.connectStage=stage;render();});
  S.loading=false;clearTerminals();S.device=r.device;if(r.devices)S.devices=r.devices;S.account=null;S.records=[];S.statusSupported=true;
  if(r.ready)setTab('live');else{render();setupBridge();}
 }catch(e){S.loading=false;S.device=null;S.connectError=e.message||String(e);render();if(/auth fail|authentication/i.test(e.message))connectionPassword(d);}
 finally{S.loading=false;}}
function setupBridge(){confirmAction('安装配套桥接程序','把随 App 分发的开源程序安装到当前 SSH 用户的 ~/.herdr-pocket。历史功能只读 ~/.codex/sessions 和 ~/.claude/projects，不读服务商登录资料。需要 Python 3.9+。','安装并进入',async()=>{if(S.loading)return;S.loading=true;S.connectError='';S.connectStage='SSH 已连接，正在安装与校验桥接程序…';render();try{await rpc('install');S.loading=false;S.statusSupported=true;setTab('live');}catch(e){S.loading=false;S.connectError=e.message;render();}});}
async function disconnect(show=true){await rpc('disconnect');clearTerminals();Object.assign(S,{device:null,loading:false,connecting:null,connectError:'',liveLoading:false,liveError:'',demo:false,records:[],agents:[],account:null,chat:null,outbox:[],activity:''});S.drafts.clear();S.bindings.clear();S.epoch++;if(show)setTab('devices');}
async function startDemo(){if(S.loading){toast('正在连接，请稍候');return;}S.connectError='';if(S.device&&!S.demo){confirmAction('断开并体验演示？','演示不连接任何电脑，也不会给 Agent 发消息。','进入演示',async()=>{await disconnect(false);startDemo();});return;}try{await rpc('demo');S.demo=true;S.device={id:'demo',name:'演示工作站',user:'demo',host:'workstation.local',port:22};S.account={ssh_user:'demo',hostname:'workstation'};S.session='demo';S.sessions=['demo'];S.agents=demoAgents;S.records=demoRecords;S.tab='live';S.chat=null;render();}catch(e){error(e);}}
async function loadAccount(){const epoch=S.epoch;try{const a=await remote('account');if(epoch!==S.epoch)return;S.account=a;if(S.tab==='devices'&&!S.chat)render();}catch(e){if(epoch===S.epoch)error(e);}}

// ─── Live agents ────────────────────────────────────────────────────────────
function agentRow(a){
 const n=btn('','card-button agent-row tone-'+stateTone(a),()=>openAgent(a));
 const text=el('div','grow');text.append(el('div','card-title',titleOf(a)));
 const meta=el('div','card-meta');meta.append(el('span','',providerName(a.agent)));const project=projectOf(a);if(project)meta.append(el('span','sep',project));
 const ref=a.history_ref;if(ref&&ref.status!=='matched'&&ref.status!=='pending')meta.append(el('span','sep warn','历史未关联'));
 text.append(meta);n.append(avatar(a.agent,stateTone(a)),text,el('span','badge '+stateTone(a),stateLabel(a)));return n;}
function livePage(main){
 const actions=el('div','row');if(S.sessions.length>1)actions.append(btn(S.session||'选择会话','pill',chooseSession,'folder'));actions.append(ib('refresh','刷新会话',loadLive));
 pageHead(main,'','会话',S.device?(S.agents.length?S.agents.length+' 个 Agent 在线':''):'',actions);
 if(!requireDevice(main))return;
 if(S.liveLoading&&!S.agents.length){loadingCard(main,'SSH 已连接，正在读取会话',S.liveLoading==='sessions'?'正在获取 Herdr 工作区…':'正在识别 Agent 并关联历史记录…');skeleton(main,3);return;}
 if(S.liveError){empty(main,'会话读取失败',S.liveError,btn('重新读取','primary',loadLive));return;}
 if(S.agents.length>6)main.append(searchBox('搜索 Agent 或项目',q=>{S.search=q;draw();},S.search));
 const list=el('div','agent-list');main.append(list);
 function draw(){list.replaceChildren();const q=S.search.toLowerCase();const matches=S.agents.filter(a=>(titleOf(a)+' '+a.agent+' '+projectOf(a)).toLowerCase().includes(q));
  if(!matches.length){empty(list,'暂时没有会话',S.search?'没有匹配的 Agent。':'在电脑的 Herdr 里启动 Codex 或 Claude，再刷新。');return;}
  const groups=[['等你确认',a=>a.agent_status==='blocked'],['执行中',a=>a.agent_status==='working'],['空闲',a=>!['blocked','working'].includes(a.agent_status)]];
  for(const [label,test] of groups){const items=matches.filter(test);if(!items.length)continue;list.append(el('div','section-label',label+' · '+items.length));const g=el('div','card list-card');items.forEach(a=>g.append(agentRow(a)));list.append(g);}}
 draw();
 if(S.liveLoading)main.append(el('p','fine center','正在刷新…'));}
function chooseSession(){const box=sheet('切换 Herdr 会话');S.sessions.forEach(name=>menuItem(box,name,()=>{S.session=name;loadLive();},name===S.session?'check':'folder'));}
async function loadLive(){
 if(!S.device)return;const epoch=++S.epoch;S.liveLoading=S.agents.length?'agents':'sessions';S.liveError='';if(S.tab==='live'&&!S.chat)render();
 try{const r=await remote('sessions');if(epoch!==S.epoch)return;S.sessions=r.sessions.filter(x=>x.running).map(x=>x.name);if(!S.sessions.includes(S.session))S.session=S.sessions[0]||'';if(!S.session){S.agents=[];return;}
  S.liveLoading='agents';if(S.tab==='live'&&!S.chat&&!S.agents.length)render();
  const a=await remote('agents',{session:S.session});if(epoch!==S.epoch)return;S.agents=a.agents;syncWatch();if(S.pendingPane){S.liveLoading=false;openPending();return;}}
 catch(e){if(epoch===S.epoch)S.liveError=e.message||String(e);}
 finally{if(epoch===S.epoch){S.liveLoading=false;if(S.tab==='live'&&!S.chat)render();}}}
// Lightweight status refresh: Herdr state only, keeps resolved history refs.
async function refreshStatus(){
 if(!S.device||S.demo||S.statusBusy||!S.session||!S.statusSupported||S.liveLoading)return;S.statusBusy=true;
 try{const r=await remote('status',{session:S.session});const known=new Map(S.agents.map(a=>[a.pane_id,a]));let changed=false;
  const next=r.agents.map(a=>{const old=known.get(a.pane_id);if(!old||old.identity!==a.identity){changed=true;return a;}if(old.agent_status!==a.agent_status||titleOf(old)!==titleOf(a))changed=true;return {...old,...a,history_ref:old.history_ref};});
  if(next.length!==S.agents.length)changed=true;
  const fresh=next.filter(a=>!known.has(a.pane_id)||known.get(a.pane_id).identity!==a.identity);
  S.agents=next;if(changed)syncWatch();
  if(S.chat?.agent){const cur=next.find(a=>a.pane_id===S.chat.agent.pane_id);if(!cur||cur.identity!==S.chat.agent.identity){if(!S.chat.stale){S.chat.stale=true;toast('这个窗格的 Agent 已变化，已停止发送');renderChat();}}else if(cur.agent_status!==S.chat.agent.agent_status){const was=S.chat.agent.agent_status;S.chat.agent={...S.chat.agent,agent_status:cur.agent_status};onAgentStatus(was,cur.agent_status);}}
  if(fresh.length&&S.tab==='live'&&!S.chat){loadLive();return;}
  if(changed&&!S.chat&&!(typeof T!=='undefined'&&T.view)&&!overlay.childElementCount)render();}
 catch(e){if(/Unknown operation|不支持的操作/.test(e.message))S.statusSupported=false;}
 finally{S.statusBusy=false;}}

// ─── Chat ───────────────────────────────────────────────────────────────────
function resetChat(chat){S.chat=chat;S.messages=[];S.children=[];S.more=false;S.before=0;S.historyNote='';S.terminalText='';S.activity='';S.chatMode='conversation';S.paused=false;}
async function openAgent(a){
 S.chatStack=[];resetChat({agent:a,record:null,title:titleOf(a),provider:a.agent});const epoch=++S.epoch;renderChat();
 const ref=a.history_ref;
 if(ref?.record){S.bindings.delete(S.session+'/'+a.identity);S.chat.record=ref.record;await fetchHistory(false,true);return;}
 const remembered=S.bindings.get(S.session+'/'+a.identity);if(remembered){S.chat.record=remembered;S.chat.manual=true;await fetchHistory(false,true);return;}
 const id=ref?.thread||(a.agent_session?.kind!=='path'?a.agent_session?.value:null);
 if(id&&ref?.status!=='pending'){try{const r=await remote('catalog',{thread:id});if(epoch!==S.epoch)return;const rec=r.records.find(x=>x.provider===a.agent&&(!ref?.record_id||x.id===ref.record_id));if(rec){S.chat.record=rec;await fetchHistory(false,true);return;}}catch(e){if(epoch===S.epoch)error(e);}}
 if(epoch===S.epoch){S.chat.historyIssue=historyIssueText(ref);renderChat();if(a.agent_status==='working'||a.agent_status==='blocked')fetchTerminal(true);}}
// Bridge reasons are specific; fall back to generic copy only for older bridges.
function historyIssueText(ref){const reason=ref?.reason;switch(ref?.status){case 'remote_error':return '远端历史读取失败：'+(reason||'连接不可用');case 'pending':return (reason||'会话刚开始，历史文件还没写出')+'。稍后会自动出现。';case 'remote_candidates':case 'ambiguous':case 'unavailable':return (reason||'没有能唯一确认的会话标识')+(ref?.candidates?.length?'，下面列出了候选。':'。');case 'remote_missing':return reason||'远端这个工作目录下还没有历史记录。';case 'remote':return '这个窗格通过 SSH 连到别的电脑，历史在那台电脑上；终端输出仍可查看。';case 'missing':return reason||'会话标识已知，但没找到对应的历史文件。';default:return reason||'没有能确认的会话标识，可以手动选择历史，或查看终端输出。';}}
function openRecord(r,push=false){
 if(push&&S.chat)S.chatStack.push({...S.chat,mode:S.chatMode,savedMessages:S.messages,savedChildren:S.children,savedBefore:S.before,savedMore:S.more,savedScroll:document.getElementById('chat-scroll')?.scrollTop||0});else S.chatStack=[];
 resetChat({record:r,agent:null,title:r.title,provider:r.provider});S.epoch++;renderChat();fetchHistory(false,true);}
async function fetchHistory(older=false,initial=false){
 if(!S.chat?.record||(S.polling&&S.fetchEpoch===S.epoch))return;S.polling=true;const epoch=S.epoch;S.fetchEpoch=epoch;const record=S.chat.record;
 if(initial){S.chat.historyLoading=true;renderTimeline();}
 const args={record_id:record.id};if(record.remote)args.remote=record.remote;if(older)args.before=S.before;
 const scroll=document.getElementById('chat-scroll');const oldHeight=scroll?.scrollHeight||0,oldTop=scroll?.scrollTop||0;
 try{const r=await remote('history',args);if(epoch!==S.epoch)return;const hadError=!!S.chat.historyError;S.chat.historyError=null;S.chat.historyLoading=false;const prior=S.messages.length+':'+(S.messages.at(-1)?.id||'')+':'+(S.messages.at(-1)?.text.length||0);
  if(older){const seen=new Set(S.messages.map(x=>x.id));S.messages=r.messages.filter(m=>!seen.has(m.id)).concat(S.messages);}
  else if(initial)S.messages=r.messages;
  else{const map=new Map(S.messages.map(x=>[x.id,x]));r.messages.forEach(m=>map.set(m.id,m));S.messages=[...map.values()].sort((a,b)=>Number(a.id.split(':')[0])-Number(b.id.split(':')[0])||Number(a.id.split(':')[1])-Number(b.id.split(':')[1]));}
  S.children=r.children||[];if(initial||older){S.before=r.before;S.more=r.has_more;}
  S.historyNote=r.bounded?'本页到了读取窗口边界，可以继续加载更早记录。':'';
  settleOutbox();
  const now=S.messages.length+':'+(S.messages.at(-1)?.id||'')+':'+(S.messages.at(-1)?.text.length||0);
  if(prior!==now||initial||older||hadError){const nearBottom=!scroll||oldHeight-oldTop-scroll.clientHeight<120;renderTimeline();const n=document.getElementById('chat-scroll');if(older&&n)n.scrollTop=oldTop+n.scrollHeight-oldHeight;else if((initial||nearBottom)&&n)n.scrollTop=n.scrollHeight;else if(!initial)showJump(true);}
  updateChatMeta();}
 catch(e){if(epoch===S.epoch){S.paused=true;S.chat.historyLoading=false;S.chat.historyError='历史读取失败：'+e.message;renderTimeline();}}
 finally{if(S.fetchEpoch===epoch)S.polling=false;}}
function chatSubtitle(){const c=S.chat;if(!c)return '';if(c.stale)return '窗格已变化 · 只读';if(c.agent){const parts=[stateLabel(c.agent)];const p=projectOf(c.agent);if(p)parts.push(p);if(c.manual)parts.push('手动关联');if(S.children.length)parts.push(S.children.length+' 个子 Agent');return parts.join(' · ');}return (c.record?.parent?'子 Agent · ':'')+'历史只读'+(S.children.length?' · '+S.children.length+' 个子 Agent':'');}
function updateChatMeta(){const n=document.getElementById('chat-meta');if(n)n.textContent=chatSubtitle();const d=document.getElementById('chat-dot');if(d)d.className='status-dot '+(S.chat?.agent&&!S.chat.stale?stateTone(S.chat.agent):'muted');}
function renderChat(){
 const root=shell();root.classList.add('chat-shell');const head=el('header','chat-head');head.append(ib('back','返回列表',pocketBack));
 const av=avatar(S.chat.provider);const dot=el('span','status-dot '+(S.chat.agent&&!S.chat.stale?stateTone(S.chat.agent):'muted'));dot.id='chat-dot';av.append(dot);head.append(av);
 const name=el('div','grow');name.append(el('h2','',S.chat.title||'对话'));const sub=el('small','',chatSubtitle());sub.id='chat-meta';name.append(sub);head.append(name);
 head.append(ib('branch','切换 Agent',agentSwitcher),ib('more','更多操作',chatMenu));root.append(head);
 const tabs=el('div','chat-tabs');[['conversation','对话'],['commands','命令'],['terminal','终端']].forEach(([mode,title])=>{const b=btn(title,S.chatMode===mode?'active':'',()=>{if(S.chatMode===mode)return;S.chatMode=mode;S.epoch++;renderChat();if(mode==='terminal')fetchTerminal();else if(S.chat.record&&!S.messages.length)fetchHistory(false,true);});b.setAttribute('aria-pressed',String(S.chatMode===mode));tabs.append(b);});root.append(tabs);
 const wrap=el('div','chat-body-wrap');const body=el('main','chat-body');body.id='chat-scroll';body.onscroll=()=>{if(body.scrollHeight-body.scrollTop-body.clientHeight<80)showJump(false);};wrap.append(body);
 const jump=btn('','jump-btn hidden',()=>{body.scrollTop=body.scrollHeight;showJump(false);},'down');jump.id='jump';jump.setAttribute('aria-label','回到最新');wrap.append(jump);root.append(wrap);
 renderTimeline();
 const footer=el('footer','composer-wrap');footer.id='composer';root.append(footer);renderComposer();
 const n=document.getElementById('chat-scroll');if(n)n.scrollTop=n.scrollHeight;}
function showJump(v){document.getElementById('jump')?.classList.toggle('hidden',!v);}

// Composer, live activity and confirmation panel.
function renderComposer(){
 const footer=document.getElementById('composer');if(!footer||!S.chat)return;footer.replaceChildren();const a=S.chat.agent;
 if(!a||S.chat.stale){footer.append(el('div','readonly',S.chat.stale?'这个窗格的 Agent 已变化，回到列表重新打开':S.chat.record?.parent?'子 Agent 的历史记录 · 只读，不会向父会话发送':'历史只读 · 在「会话」里打开在线 Agent 才能继续对话'));return;}
 if(a.agent_status==='blocked'){const panel=el('section','confirm-panel');const h=el('div','confirm-head');h.append(icon('alert'),el('strong','grow','Agent 在等你确认'),btn('刷新','link-btn',()=>fetchTerminal(true)));panel.append(h);
  const pre=el('pre','confirm-screen',S.terminalText?tail(S.terminalText,12):'正在读取终端画面…');pre.id='confirm-screen';panel.append(pre);
  const keys=el('div','confirm-keys');[['↑','up'],['↓','down'],['Enter 确认','enter'],['Esc','esc'],['Ctrl+C','ctrl+c']].forEach(([t,k])=>keys.append(btn(t,k==='enter'?'primary small':'secondary small',()=>sendKey(k,t))));panel.append(keys);footer.append(panel);}
 else if(a.agent_status==='working'){const strip=el('div','activity');strip.append(el('span','pulse'));const t=el('div','grow');t.append(el('strong','',providerName(a.agent)+' 正在工作'));const line=el('span','activity-line',S.activity||'');line.id='activity-line';t.append(line);strip.append(t,btn('中断','secondary small',()=>confirmAction('中断 Agent？','向 '+titleOf(a)+' 发送 Ctrl+C，会打断它正在执行的操作。','发送 Ctrl+C',()=>sendKey('ctrl+c','Ctrl+C'),true)));footer.append(strip);}
 const compose=el('div','composer');const input=el('textarea');input.rows=1;input.placeholder=a.agent_status==='working'?'Agent 执行中，可以先写好…':'说点什么，继续这段对话…';input.setAttribute('aria-label','消息输入框');const key=draftKey();input.value=S.drafts.get(key)||'';
 const grow=()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,140)+'px';};
 const send=btn('','send',()=>sendMessage(input),'send');send.setAttribute('aria-label','发送消息');
 input.oninput=()=>{S.drafts.set(key,input.value);grow();};compose.append(input,send);footer.append(compose);requestAnimationFrame(grow);}
async function sendKey(key,label){const a=S.chat?.agent;if(!a)return;try{await remote('key',{session:S.session,target:a.pane_id,identity:a.identity,key,id:uuid()});toast(S.demo?'演示：未发送按键':'已发送 '+label);setTimeout(()=>{refreshStatus();fetchTerminal(true);},700);}catch(e){toast('按键未确认：'+e.message+'。不会自动重发。');}}
async function sendMessage(input){
 const text=input.value;const a=S.chat?.agent;if(!text.trim()||!a)return;
 if(['working','blocked'].includes(a.agent_status)&&!S.demo){toast(a.agent_status==='working'?'Agent 还在执行，等它停下再发（草稿已保留）':'Agent 在等你确认，先处理上面的提示');return;}
 const epoch=S.epoch,key=draftKey();const button=document.querySelector('.send');button.disabled=true;
 const item={key,text,at:Date.now(),state:'sending'};
 if(!S.demo){S.outbox.push(item);renderTimeline();scrollBottom();}
 try{await remote('prompt',{session:S.session,target:a.pane_id,identity:a.identity,text,id:uuid()});
  if(S.demo){toast('演示模式：未发送，草稿已保留');return;}
  item.state='sent';if(S.drafts.get(key)===text)S.drafts.delete(key);if(epoch===S.epoch&&input.value===text){input.value='';input.style.height='auto';}
  if(S.chat?.agent){S.chat.agent={...S.chat.agent,agent_status:'working'};renderComposer();updateChatMeta();}
  renderTimeline();scrollBottom();if(epoch===S.epoch)setTimeout(()=>fetchHistory(),900);}
 catch(e){item.state='failed';renderTimeline();toast('发送未确认：'+e.message+'。草稿已保留，不会自动重发。');}
 finally{button.disabled=false;}}
function scrollBottom(){const n=document.getElementById('chat-scroll');if(n)n.scrollTop=n.scrollHeight;}
// A pending bubble disappears once the transcript shows the same user text.
function settleOutbox(){if(!S.outbox.length)return;const recent=S.messages.filter(m=>m.kind==='user').slice(-8).map(m=>m.text.trim());S.outbox=S.outbox.filter(o=>!(o.state==='sent'&&recent.includes(o.text.trim()))&&Date.now()-o.at<180000);}
function onAgentStatus(was,now){renderComposer();updateChatMeta();if(now==='blocked'){fetchTerminal(true);if(!S.active)return;toast('Agent 在等你确认');}if(was==='working'&&now!=='working'){S.activity='';fetchHistory();}}
async function fetchTerminal(quiet=false){
 if(!S.chat?.agent){if(!quiet)toast('这条历史没有在线终端');return;}const epoch=S.epoch;
 try{const r=await remote('read',{session:S.session,target:S.chat.agent.pane_id,identity:S.chat.agent.identity});if(epoch!==S.epoch)return;S.terminalText=r.text;
  const lines=r.text.split('\n').map(x=>x.trim()).filter(x=>x&&!/^[─━═\-_│|>›❯▌\s]+$/.test(x));S.activity=lines.at(-1)||'';
  const n=document.getElementById('terminal-output');if(n)n.textContent=r.text;const c=document.getElementById('confirm-screen');if(c)c.textContent=tail(r.text,12);const l=document.getElementById('activity-line');if(l)l.textContent=S.activity;
  if(!S.chat.record&&S.chatMode==='conversation')renderTimeline();}
 catch(e){if(epoch===S.epoch&&!quiet)error(e);}}

// ─── Sheets ─────────────────────────────────────────────────────────────────
function agentSwitcher(){
 const box=sheet('切换 Agent');
 if(S.chat?.record?.parent)menuItem(box,'返回父会话',async()=>{try{const r=await remote('catalog',{thread:S.chat.record.parent,...(S.chat.record.remote?{remote:S.chat.record.remote}:{})});if(r.records.length)openRecord(r.records[0],true);else toast('没找到父会话记录');}catch(e){error(e);}},'back');
 if(S.children.length){box.append(el('div','section-label','这段对话的子 Agent'));S.children.forEach(r=>{const b=btn('','menu-item',()=>{closeSheet();openRecord(r,true);},'branch');b.append(el('span','grow menu-label',(r.role||r.title)+' · '+r.thread.slice(0,8)));box.append(b);});}
 else box.append(el('p','fine','这段对话里还没有子 Agent。'));
 box.append(el('div','section-label','在线 Agent'));
 S.agents.forEach(a=>{const b=btn('','menu-item',()=>{closeSheet();openAgent(a);});b.append(avatar(a.agent,stateTone(a)));const t=el('span','grow');t.append(el('span','menu-label',titleOf(a)),el('small','',providerName(a.agent)+(projectOf(a)?' · '+projectOf(a):'')));b.append(t,el('span','badge '+stateTone(a),stateLabel(a)));box.append(b);});}
function chatMenu(){
 const box=sheet('对话操作');
 menuItem(box,'刷新对话',()=>{S.paused=false;fetchHistory(false,true);},'refresh');
 menuItem(box,S.paused?'恢复自动更新':'暂停自动更新',()=>{S.paused=!S.paused;toast(S.paused?'自动更新已暂停':'自动更新已恢复');},S.paused?'refresh':'pause');
 menuItem(box,'选择其他历史记录',pickHistory,'history');
 if(S.chat.agent){menuItem(box,'终端按键',keyMenu,'terminal','↑ ↓ Enter Esc Ctrl+C');menuItem(box,'查看终端',()=>{S.chatMode='terminal';S.epoch++;renderChat();fetchTerminal();},'terminal');}}
function keyMenu(){const box=sheet('终端按键');box.append(el('p','fine','先看一眼终端：Enter 可能会批准当前操作。'));[['↑ 上','up'],['↓ 下','down'],['Enter 确认','enter'],['Esc 返回','esc'],['Ctrl+C 中断','ctrl+c']].forEach(([t,key])=>{const b=btn(t,'menu-item',()=>{closeSheet();sendKey(key,t);});box.append(b);});}
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
let searchTimer;
function historyPage(main){
 pageHead(main,'','历史',S.device&&S.total?S.total+' 条记录':'',ib('refresh','刷新历史',()=>loadCatalog(S.catalogQuery||'')));if(!requireDevice(main))return;
 main.append(searchBox('搜索项目、标题或会话 ID',q=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadCatalog(q),400);},S.catalogQuery||''));
 const filters=el('div','tabs');[['all','全部'],['codex','Codex'],['claude','Claude'],['child','子 Agent']].forEach(([id,t])=>filters.append(btn(t,'pill'+(S.filter===id?' active':''),()=>{S.filter=id;renderHistoryList();filters.querySelectorAll('button').forEach(n=>n.classList.toggle('active',n.textContent===t));})));main.append(filters);
 const list=el('div');list.id='history-list';main.append(list);renderHistoryList();}
function renderHistoryList(){
 const list=document.getElementById('history-list');if(!list)return;list.replaceChildren();
 const records=S.records.filter(r=>S.filter==='all'||(S.filter==='child'?r.parent:r.provider===S.filter));
 if(!records.length){if(S.catalogLoading)skeleton(list,5);else empty(list,'没有匹配的记录','只显示当前 SSH 用户的 Codex / Claude 本地历史。');return;}
 let day='',group=null;
 for(const r of records){const d=dayLabel(r.modified);if(d!==day||!group){day=d;list.append(el('div','section-label',d||'更早'));group=el('div','card list-card');list.append(group);}
  const b=btn('','card-button history-row',()=>openRecord(r));const text=el('div','grow');text.append(el('div','card-title',r.title));const meta=el('div','card-meta');meta.append(el('span','',providerName(r.provider)),el('span','sep',clock(r.modified)));const project=(r.cwd||'').split('/').filter(Boolean).pop();if(project)meta.append(el('span','sep',project));if(r.parent)meta.append(el('span','badge muted','子 Agent'));text.append(meta);b.append(avatar(r.provider),text,icon('chevron'));group.append(b);}
 if(S.next!==null&&S.next!==undefined)list.append(btn('加载更多历史','secondary wide',()=>loadCatalog(S.catalogQuery||'',true)));}
async function loadCatalog(query='',more=false){
 if(!S.device)return;const epoch=++S.epoch;S.catalogLoading=true;if(!more&&!S.records.length)renderHistoryList();
 try{const r=await remote('catalog',{offset:more?S.next||0:0,query});if(epoch!==S.epoch)return;S.records=more?S.records.concat(r.records):r.records;S.total=r.total;S.next=r.next;S.catalogQuery=query;}
 catch(e){if(epoch===S.epoch)error(e);}
 finally{if(epoch===S.epoch){S.catalogLoading=false;if(S.tab==='history'&&!S.chat){if(more||query)renderHistoryList();else render();}}}}

// ─── Back & lifecycle ───────────────────────────────────────────────────────
function pocketBack(){
 if(overlay.childElementCount){closeSheet();return;}
 if(T.view){leaveTerminal();render();return;}
 if(S.chatStack.length){const prev=S.chatStack.pop();S.chat=prev;S.chatMode=prev.mode||'conversation';S.messages=prev.savedMessages||[];S.children=prev.savedChildren||[];S.before=prev.savedBefore||0;S.more=!!prev.savedMore;S.epoch++;renderChat();document.getElementById('chat-scroll').scrollTop=prev.savedScroll||0;if(prev.record&&!S.messages.length)fetchHistory(false,true);return;}
 if(S.chat){S.chat=null;S.epoch++;render();return;}
 if(S.tab!=='live'&&S.device)setTab('live');else if(S.tab!=='devices')setTab('devices');else toast('设备和保存的密码都在，可以直接关闭应用');}
window.pocketBack=pocketBack;
window.setForeground=v=>{S.active=v;if(v){refreshStatus();if(S.chat?.record&&!S.paused)fetchHistory();}};
// Busy agents refresh faster; nothing polls in the background or in demo mode.
let tick=0;
setInterval(()=>{
 if(!S.active||S.demo||!S.device)return;tick++;
 const busy=S.chat?.agent&&!S.chat.stale&&['working','blocked'].includes(S.chat.agent.agent_status);
 if(S.chat){if(!S.paused&&!S.polling&&S.chatMode!=='terminal'&&(busy||tick%3===0))fetchHistory();if(busy&&S.chatMode!=='commands')fetchTerminal(true);if(tick%2===0)refreshStatus();}
 else if(S.tab==='live'&&tick%3===0)refreshStatus();
},2500);

async function boot(){render();try{const r=await rpc('devices');S.devices=r.devices;S.version=r.version;S.alerts=r.alerts!==false;if(r.connected&&!S.device){S.device=r.connected;setTab('live');return;}render();}catch(e){error(e);}}
boot();
