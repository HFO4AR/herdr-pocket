'use strict';
// Android pieces that are not a screen of their own.
//  · Share into Herdr Pocket (ShareIn.kt): text, pictures and files from another app become a
//    draft in the live agent you pick: text in the input, pictures and files in the trays. Nothing
//    is ever sent automatically. Before a connection exists the share waits behind a banner.
//  · Light haptics on send, an answer and long-press menus (the system touch-feedback setting applies).
// Remote strings (agent titles) and shared text are text nodes only.

// ─── Share ──────────────────────────────────────────────────────────────────
const SHARE={item:null,preparing:false,asked:false,loaded:false};
// Called by MainActivity: {preparing:true} first, then {text,images,files,failed,reason,extra}.
window.pocketShare=p=>{
 if(p?.preparing){SHARE.preparing=true;shareTick();return;}
 SHARE.preparing=false;
 const item={text:String(p?.text||''),images:Array.isArray(p?.images)?p.images:[],files:Array.isArray(p?.files)?p.files:[],at:Date.now()};
 const empty=!item.text.trim()&&!item.images.length&&!item.files.length;
 if(p?.failed)toast(empty?'分享的内容读不到'+(p.reason?'：'+p.reason:''):p.failed+' 个文件没加上'+(p.reason?'：'+p.reason:''));
 else if(p?.extra)toast('一条消息最多带 4 张图片和 4 个文件，多的没加');
 if(empty){if(!p?.failed)toast('没有可以发送的内容');shareTick();return;}
 // A newer share replaces one still waiting.
 if(SHARE.item)shareRelease(SHARE.item);
 SHARE.item=item;SHARE.asked=false;SHARE.loaded=false;shareTick();};
function shareRelease(it){
 if(it.images.length)rpc('dropImages',{ids:it.images.map(a=>a.id)}).catch(()=>{});
 if(it.files.length)rpc('dropFiles',{ids:it.files.map(f=>f.id)}).catch(()=>{});}
function shareCancel(){const it=SHARE.item;SHARE.item=null;if(it)shareRelease(it);closeSheet();shareTick();toast('已取消分享');}
function shareSummary(it){
 const parts=[];if(it.text.trim())parts.push(it.text.length>60?'一段文字':'文字');
 if(it.images.length)parts.push(it.images.length+' 张图片');if(it.files.length)parts.push(it.files.length+' 个文件');
 return parts.join('、');}
function shareConnected(){return !!S.device&&!S.demo&&!S.loading;}
// Where the share stands: what the banner says and what tapping it does.
function shareState(){
 if(SHARE.preparing&&!SHARE.item)return {busy:true,title:'正在读取分享的内容…'};
 const it=SHARE.item;if(!it)return null;const title='待发送：'+shareSummary(it);
 const connect=S.tab==='devices'&&!S.chat?null:['去连接',()=>setTab('devices')];
 if(S.demo)return {title:title,detail:'演示里不能发，先连接你的电脑',action:connect};
 if(S.loading)return {busy:true,title:title,detail:'连上之后选发给哪个 Agent'};
 if(!S.device)return {title:title,detail:'连上电脑后，选发给哪个 Agent',action:connect};
 if(S.liveLoading||(!S.agents.length&&!SHARE.loaded))return {busy:true,title:title,detail:'正在读取在线 Agent…'};
 if(!S.agents.length)return {title:title,detail:'这个会话里没有在线 Agent',action:['刷新',()=>{SHARE.loaded=false;setTab('live');}]};
 return {title:title,detail:'选一个 Agent，放进它的输入框',action:['选 Agent',sharePicker]};}
let shareBox=null;
function shareTick(){
 const st=shareState();
 if(st&&shareConnected()&&SHARE.item){
  // Connected but the live list was never read (another tab): read it once.
  if(!S.agents.length&&!S.liveLoading&&!SHARE.loaded){SHARE.loaded=true;if(!S.chat&&!(typeof T!=='undefined'&&T.view))setTab('live');else loadLive();}
  else if(S.agents.length&&!SHARE.asked&&!overlay.childElementCount){SHARE.asked=true;sharePicker();}}
 shareBanner(st);}
// A floating card above the bottom bar (or the composer), hidden while a sheet is open.
function shareBanner(st){
 if(!st){shareBox?.remove();shareBox=null;return;}
 if(!shareBox){shareBox=el('div','share-banner');shareBox.setAttribute('role','status');shareBox.setAttribute('aria-label','分享');}
 if(!shareBox.isConnected)document.body.append(shareBox);
 const sig=JSON.stringify([st.title,st.detail,!!st.busy,st.action?.[0]]);
 if(shareBox.dataset.sig!==sig){shareBox.dataset.sig=sig;shareBox.replaceChildren();
  const lead=st.busy?el('span','spinner'):icon('download');lead.classList.add('share-lead');
  const text=el('div','grow share-text');text.append(el('strong','',st.title));if(st.detail)text.append(el('small','',st.detail));
  shareBox.append(lead,text);
  if(st.action){const go=btn(st.action[0],'primary small share-go',st.action[1]);shareBox.append(go);}
  if(SHARE.item)shareBox.append(ib('x','取消分享',shareCancel));}
 const bar=document.querySelector('.bottom-nav')||document.getElementById('composer');
 shareBox.style.bottom=(bar?bar.offsetHeight:0)+10+'px';
 shareBox.classList.toggle('hidden',!!overlay.childElementCount);}
setInterval(()=>{if(SHARE.item||SHARE.preparing||shareBox)shareTick();},600);
// What was shared, then the live agents (waiting ones first), like 切换 Agent.
function sharePicker(){
 const it=SHARE.item;if(!it)return;SHARE.asked=true;
 const box=sheet('发给哪个 Agent');
 const peek=el('div','share-peek');
 if(it.text.trim()){const t=el('p','share-peek-text',it.text);peek.append(t);}
 if(it.images.length){const row=el('div','share-peek-imgs');it.images.forEach((a,i)=>{const img=el('img');img.src=a.thumb;img.alt='图片 '+(i+1);row.append(img);});peek.append(row);}
 if(it.files.length){const list=el('div','share-peek-files');it.files.forEach(f=>{const c=el('div','file-chip');c.append(fileBadge(f.name),fileText(f.name,fileSize(f.size)));list.append(c);});peek.append(list);}
 box.append(peek);
 box.append(el('div','section-label','在线 Agent'));
 if(!S.agents.length)box.append(el('p','fine','这个会话里还没有在线 Agent。'));
 const current=S.chat?.agent&&!S.chat.stale?agentKey(S.chat.agent):'';const order={blocked:0,working:1};
 sortAgents(S.agents).sort((x,y)=>(agentKey(y)===current)-(agentKey(x)===current)||(order[x.agent_status]??2)-(order[y.agent_status]??2)).forEach(a=>{
  const here=agentKey(a)===current;
  const b=btn('','menu-item agent-pick'+(here?' current':''),()=>shareApply(a));
  b.append(avatar(a.agent,stateTone(a)));const t=el('span','grow');
  t.append(el('span','menu-label',titleOf(a)),el('small','',(here?'当前 · ':'')+providerName(a.agent)+(projectOf(a)?' · '+projectOf(a):'')));
  b.append(t,el('span','badge '+stateTone(a),stateLabel(a)));box.append(b);});
 box.append(el('p','fine','只会放进输入框，你看过再发。'));
 const row=el('div','sheet-actions');row.append(btn('取消分享','secondary',shareCancel),btn('稍后再选','secondary',closeSheet));box.append(row);}
// Puts the share into that agent's draft: text after anything already typed, attachments up to the limits.
function shareApply(a){
 const it=SHARE.item;if(!it)return;SHARE.item=null;closeSheet();
 const key=S.session+'/'+a.identity;
 if(it.text.trim()){const cur=S.drafts.get(key)||'';S.drafts.set(key,cur.trim()?cur.replace(/\s+$/,'')+'\n\n'+it.text:it.text);}
 const pics=it.images.slice(0,Math.max(0,IMG_MAX-imgAttached(key).length));
 if(pics.length)imgSet(key,imgAttached(key).concat(pics));
 const have=fileAttached(key),docs=[];
 for(const f of it.files){if(have.length+docs.length<FILE_MAX&&!have.concat(docs).some(x=>x.name===f.name&&x.size===f.size))docs.push(f);}
 if(docs.length)fileSet(key,have.concat(docs));
 const left={images:it.images.filter(x=>!pics.includes(x)),files:it.files.filter(x=>!docs.includes(x))};
 shareRelease(left);
 haptic('tick');
 if(S.chat?.agent&&!S.chat.stale&&agentKey(S.chat.agent)===agentKey(a)){if(S.chatMode!=='conversation'){S.chatMode='conversation';S.epoch++;renderChat();}else renderComposer();}
 else{if(typeof T!=='undefined'&&T.view)leaveTerminal();openAgent(a);}
 shareTick();
 toast(left.images.length||left.files.length?'已放进输入框；附件满了，多的没加':'已放进输入框，看一眼再发');}

// ─── Haptics ────────────────────────────────────────────────────────────────
let hapticAt=0;
function haptic(kind){const now=Date.now();if(now-hapticAt<120)return;hapticAt=now;
 try{if(typeof PocketNative!=='undefined'&&typeof PocketNative.haptic==='function')PocketNative.haptic(kind);}catch(_){}}
document.addEventListener('click',e=>{const b=e.target.closest?.('button');if(!b||b.disabled)return;
 if(b.matches('.send,.qa-submit'))haptic('confirm');else if(b.matches('.qa-opt'))haptic('tick');},true);
// A sheet that opens while a finger is still held down is a long-press menu.
let holdAt=0,holding=false,menuAt=0;
document.addEventListener('pointerdown',()=>{holding=true;holdAt=Date.now();},true);
['pointerup','pointercancel'].forEach(t=>document.addEventListener(t,()=>{holding=false;},true));
document.addEventListener('contextmenu',()=>{menuAt=Date.now();},true);
new MutationObserver(()=>{if(!overlay.childElementCount)return;const now=Date.now();if((holding&&now-holdAt>=400)||now-menuAt<150)haptic('long');})
 .observe(document.getElementById('overlay'),{childList:true});

// Back from the system notification settings: show whether notifications are on now.
document.addEventListener('DOMContentLoaded',()=>{const fg=window.setForeground;if(typeof fg!=='function')return;
 window.setForeground=v=>{fg(v);if(v&&S.tab==='settings'&&!S.chat)settingsLoad().then(()=>{if(S.tab==='settings'&&!S.chat&&!overlay.childElementCount)paintSettings();});};},{once:true});
