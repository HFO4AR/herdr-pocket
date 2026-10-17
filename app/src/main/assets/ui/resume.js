'use strict';
// 启动时自动重连: on launch, reconnect the computers that were connected when the app went away.
// The native side keeps only their ids (ResumeSet.kt): a connect adds one, an explicit 断开 / 全部断开
// or deleting a device removes it; the app being killed, swiped away or updated keeps them.
// The one that was on screen goes first, through the normal connect (cached list while connecting);
// the others follow one by one in the background. Only computers that can log in without asking are
// reconnected: saved password or key, every jump host too, every host key already pinned (checked
// again natively). Nothing is typed, trusted or installed here; such a computer gets a quiet row on
// its card instead, and a tap runs the normal connect with its sheets. A computer still connected
// through the keep-alive service is simply reattached (onboard.js linkBoot), never connected twice.
// Loaded after onboard.js; only declarations and wrappers at top level.
const RESUME={st:new Map(),order:[],tries:new Map(),running:false,offline:false};
// Quiet tries per computer and launch; another one only on a network change or coming back to the app.
const RESUME_TRIES=3;
// Failures where nothing was wrong with the login itself: worth a retry once the network moves.
const RESUME_NET=new Set(['','dns','refused','timeout','unreachable','tunnel','network','jump_forward']);
Object.assign(OB_FAIL,{resume_bridge:'桥接程序要更新',resume_trust:'要先核对指纹',resume_password:'要输入密码'});

// Phases: queued → connecting → (done) | waiting (network, retried) | tap (needs the user).
function resumeBusy(id){return RESUME.st.get(id)?.phase==='connecting';}
// A tap on 连接 takes over from the quiet reconnect; the normal flow (password, fingerprint, install) runs.
function resumeAllow(d){
 const s=RESUME.st.get(d?.id);if(!s)return true;
 if(s.phase==='connecting'){toast('正在自动连接 '+d.name+'，稍等');return false;}
 RESUME.st.delete(d.id);return true;}
// Turned off in 设置, or 全部断开: forget what is still waiting (one already connecting finishes).
function resumeStop(){[...RESUME.st].forEach(([id,s])=>{if(s.phase!=='connecting')RESUME.st.delete(id);});RESUME.order=[];if(S.tab==='devices'&&!S.chat)render();}

function resumeBoot(r){
 const p=r?.resume;if(!p?.enabled||S.demo||!Array.isArray(p.ids))return;
 const known=new Set(S.devices.map(d=>d.id));
 const items=p.ids.filter(x=>x&&known.has(x.id)&&!linkConnected(x.id));
 if(!items.length)return;
 // The one that was on screen first; the rest keep their connection order.
 items.sort((a,b)=>(b.id===p.active)-(a.id===p.active));
 RESUME.offline=p.online===false;
 for(const it of items){
  if(it.need){RESUME.st.set(it.id,{phase:'tap',need:it.need});continue;}
  RESUME.st.set(it.id,{phase:RESUME.offline?'waiting':'queued'});RESUME.order.push(it.id);}
 if(S.tab==='devices'&&!S.chat)render();
 if(!RESUME.offline)resumeRun();}

async function resumeRun(){
 if(RESUME.running)return;RESUME.running=true;
 try{for(;;){
  const id=RESUME.order.find(x=>RESUME.st.get(x)?.phase==='queued');if(!id)break;
  // A connect the user started finishes first.
  while(S.loading)await new Promise(r=>setTimeout(r,250));
  if(S.demo){resumeStop();break;}
  const d=S.devices.find(x=>x.id===id);
  if(!d||RESUME.st.get(id)?.phase!=='queued'||linkConnected(id)){if(RESUME.st.get(id)?.phase==='queued')RESUME.st.delete(id);continue;}
  RESUME.tries.set(id,(RESUME.tries.get(id)||0)+1);RESUME.st.set(id,{phase:'connecting'});
  if(!S.device)await resumeLead(d);else await resumeQuiet(d);}}
 finally{RESUME.running=false;}}

// Nothing on screen yet: the normal connect, with its cached list and progress, minus every sheet.
// A failure is told on the device card (its row), not in the page banner, and the page goes back to
// the devices list instead of staying on an emptied cached list.
async function resumeLead(d){
 await doConnect(d,'',undefined,{auto:true});
 if(S.device?.id===d.id&&!S.demo){RESUME.st.delete(d.id);return;}
 const f=S.connectFail?.device===d.id?S.connectFail:null,msg=f?S.connectError:'';
 if(f){S.connectError='';S.connectFail=null;}
 if(!S.device&&!S.loading&&!S.chat&&['live','history'].includes(S.tab))S.tab='devices';
 resumeFailed(d,f?f.code||'':'resume_off',msg,true);}

// Another computer is on screen: connect in the background; its view starts blank, like a switch.
async function resumeQuiet(d){
 if(S.tab==='devices'&&!S.chat)render();
 try{
  const r=await rpc('connect',{id:d.id,auto:true,background:true});
  if(r.devices)S.devices=r.devices;linkAdd(r.device);RESUME.st.delete(d.id);
  if(!S.device&&!S.demo&&!S.loading){
   // The one on screen went away meanwhile: show this one.
   viewTake(d.id);S.device=r.device;S.account=null;hostCheck(r.host);setTab(['devices','settings'].includes(S.tab)?S.tab:'live');return;}
  if(S.device?.id!==d.id&&!LINKS.views.has(d.id)){
   // hostCheck writes the on-screen computer's fields: read this one's into its parked view and
   // put the shown computer's back (else a tmux-only computer reconnecting quietly turned the
   // Herdr computer on screen into "没装 Herdr" until its next list refresh).
   const shown={hostIssue:S.hostIssue,herdr:S.herdr,hostTmux:S.hostTmux};Object.assign(S,{hostIssue:null,herdr:null,hostTmux:null});hostCheck(r.host);
   const v={device:r.device,hostIssue:S.hostIssue,herdr:S.herdr,hostTmux:S.hostTmux};Object.assign(S,shown);LINKS.views.set(d.id,v);}
 }catch(e){resumeFailed(d,e.code||'',e.message||String(e));}
 if(!S.chat&&['devices','live'].includes(S.tab))render();}

function resumeFailed(d,code,msg,repaint){
 if(code==='resume_off'){RESUME.st.delete(d.id);if(repaint||S.tab==='devices'&&!S.chat)render();return;}
 const again=RESUME_NET.has(code)&&(RESUME.tries.get(d.id)||0)<RESUME_TRIES;
 RESUME.st.set(d.id,{phase:again?'waiting':'tap',code,msg});
 if(repaint||S.tab==='devices'&&!S.chat)render();}

// The network came back or changed, or the app is in front again: one more quiet round for those waiting.
function resumeAgain(){
 let any=false;RESUME.st.forEach((s,id)=>{if(s.phase==='waiting'){RESUME.st.set(id,{phase:'queued'});any=true;}});
 if(!any)return;RESUME.offline=false;if(S.tab==='devices'&&!S.chat)render();resumeRun();}
{const base=netEvent;netEvent=function(e){if(e&&e.type==='online'){resumeAgain();return;}return base(e);};}
{const base=netForeground;netForeground=function(){base();resumeAgain();};}
{const base=disconnect;disconnect=function(...a){resumeStop();return base.apply(this,a);};}
if(typeof window!=='undefined')window.addEventListener('online',()=>resumeAgain());

// A quiet row on the device card: connecting, waiting for the network, or what a tap will do.
function resumeLine(card,d){
 const s=RESUME.st.get(d.id);if(!s||S.demo||linkConnected(d.id))return;
 if(s.phase==='connecting'||s.phase==='queued'){
  const row=el('div','resume-line');row.setAttribute('role','status');
  row.append(el('span','spinner mini'),el('span','grow',s.phase==='queued'?'上次连着 · 马上自动连接':'上次连着 · 正在自动连接…'));card.append(row);return;}
 if(s.phase==='waiting'){
  // The card's own 连接设备 button is right below; this row only says what will happen.
  const row=el('div','resume-line');row.setAttribute('role','status');if(s.msg)row.title=s.msg;
  row.append(icon('wifi'),el('span','grow',RESUME.offline||!s.code?'上次连着 · 等网络好了自动连接':(OB_FAIL[s.code]||'没连上')+' · 网络变了会自动再试'));card.append(row);return;}
 let name='alert',text,cta='点一下重新连接',tone='';
 if(s.need==='password'||s.code==='resume_password'){name='lock';text='上次连着 · 要输入密码';}
 else if(s.need==='trust'||s.code==='resume_trust'){name='shield';text='上次连着 · 要先核对指纹';}
 else if(s.code==='hostkey_changed'){text='电脑指纹变了，已停止自动重连';cta='点一下查看';tone=' danger';}
 else{text='自动重连没成功 · '+(OB_FAIL[s.code]||'连接未完成');tone=' danger';}
 const b=btn('','resume-line tap'+tone,()=>connectDevice(d));b.setAttribute('aria-label',text+'，'+cta);if(s.msg)b.title=s.msg;
 b.append(icon(name),el('span','grow',text),el('span','resume-cta',cta));card.append(b);}
