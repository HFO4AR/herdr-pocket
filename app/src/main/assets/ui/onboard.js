'use strict';
// Devices, first run and the connection lifecycle: device form, password prompt, SSH host-key
// trust, bridge install/update, connection banners and the reconnect pill.
// Loaded before app.js: only declarations at top level (S and the helpers are defined later).
// Security: the fingerprint is pinned only by the native layer, only after an explicit tap on
// 「信任并连接」, and only if it is the exact key the last connect attempt saw. A changed key is
// always refused; forgetting it needs a second explicit confirmation and leads back here.

function obIcons(){if(paths.eye)return;Object.assign(paths,{
 eye:'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
 eyeOff:'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
 shield:'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',key:'M15 8a4 4 0 1 1-3.6 5.7L4 21H2v-3l1-1h2v-2h2l2.3-2.3A4 4 0 0 1 15 8zM16 7h.01',
 wifi:'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01'});}

// ─── Small form helpers ─────────────────────────────────────────────────────
let obSeq=0;
// A labelled input with an inline error line. Keyboard hints: o.mode (inputmode), o.enter (enterkeyhint).
function obField(box,title,o={}){
 obIcons();const label=el('label','ob-label',title);const input=el('input','field');input.type=o.type||'text';input.value=o.value??'';
 input.placeholder=o.placeholder||'';input.autocomplete='off';input.setAttribute('aria-label',title);input.setAttribute('autocapitalize','none');input.spellcheck=false;
 if(o.mode)input.inputMode=o.mode;if(o.enter)input.enterKeyHint=o.enter;
 let wrap=input;
 if(o.type==='password'){wrap=el('div','pw-wrap');const t=ib('eye','显示密码',()=>{const show=input.type==='password';input.type=show?'text':'password';t.setAttribute('aria-label',show?'隐藏密码':'显示密码');t.title=t.getAttribute('aria-label');t.replaceChildren(icon(show?'eyeOff':'eye'));});t.classList.add('pw-toggle');wrap.append(input,t);}
 const err=el('p','field-error');err.id='ob-err-'+(++obSeq);input.setAttribute('aria-describedby',err.id);
 label.append(wrap);if(o.hint)label.append(el('span','field-hint',o.hint));label.append(err);
 input.addEventListener('input',()=>obError(input,''));input.errorNode=err;box.append(label);return input;}
function obError(input,msg){input.errorNode.textContent=msg||'';input.classList.toggle('invalid',!!msg);if(msg)input.setAttribute('aria-invalid','true');else input.removeAttribute('aria-invalid');}
// Kept for other modules: plain labelled input without inline errors.
function field(box,title,value='',type='text',placeholder=''){return obField(box,title,{value,type,placeholder});}

// Validation mirrors SecureProfiles.save, with a reason per field.
function obValidate(v){const e={};
 if(!v.host)e.host='填电脑的地址：域名或 IP';
 else if(/\s/.test(v.host))e.host='地址里不能有空格';
 else if(/:\/\/|\//.test(v.host))e.host='只填域名或 IP，不要带 ssh:// 或路径';
 else if(v.host.includes('@'))e.host='用户名填到下面的「SSH 用户名」里';
 else if(v.host.length>253)e.host='地址太长了';
 if(!/^\d{1,5}$/.test(v.port)||+v.port<1||+v.port>65535)e.port='1–65535';
 if(!v.user)e.user='填登录电脑用的用户名';else if(/[\s@]/.test(v.user)||v.user.length>128)e.user='用户名里不能有空格或 @';
 return e;}
// Accepts what people paste from a terminal: "user@host", "host:port", "ssh://user@host:port".
function obSplitAddress(raw){const m=String(raw).trim().match(/^(?:ssh:\/\/)?(?:([^@\s/]+)@)?([^@\s/:\[\]]+)(?::(\d{1,5}))?\/?$/);
 if(!m||(!m[1]&&!m[3]))return null;return {user:m[1]||'',host:m[2],port:m[3]||''};}

// ─── Devices page ───────────────────────────────────────────────────────────
function devicesPage(main){
 obIcons();rpc('protect').catch(error);
 if(S.device)main.append(connectionCard());
 if(!S.devices.length){main.append(firstRunGuide());return;}
 const head=el('div','section-head');head.append(el('span','section-label','保存的设备'),ib('plus','添加设备',()=>deviceForm()));main.append(head);
 for(const d of S.devices)main.append(deviceCard(d));
 main.append(btn('体验聊天演示','secondary wide',startDemo));
 main.append(el('p','fine','设备资料和勾选保存的密码用 Android Keystore 加密，只存在这台手机上。'));}

function firstRunGuide(){
 const card=el('section','card ob-guide');const top=el('div','ob-guide-icon');top.append(icon('device'));
 card.append(top,el('h2','','连上你的电脑'),el('p','muted','Herdr Pocket 通过 SSH 连到运行 Herdr 的电脑，在手机上看 Agent 在做什么、回它的消息。'));
 const steps=el('ol','ob-steps');
 const step=(title,detail)=>{const li=el('li');const t=el('div');t.append(el('strong','',title),el('span','',detail));li.append(t);steps.append(li);return li;};
 step('电脑开着 SSH','能用用户名和密码登录。');
 step('装好 Herdr 和 Python 3.9+','App 会在电脑上放一个小的桥接程序，靠 Python 运行。');
 const net=step('手机能访问到电脑','不知道填什么地址？看下面。');
 const more=el('details','ob-net');const sum=el('summary','','怎么填地址');more.append(sum);
 [['同一个 Wi-Fi','填电脑的局域网 IP，比如 192.168.1.20，端口 22。'],['不在一起：Tailscale','两边都登录 Tailscale，填 100. 开头的地址或 xxx.ts.net。'],['不在一起：frp 等转发','填服务器地址和映射出来的端口（不是 22）。']]
  .forEach(([k,v])=>{const r=el('div','ob-net-row');r.append(el('strong','',k),el('span','',v));more.append(r);});
 net.querySelector('div').append(more);
 card.append(steps,btn('添加第一台设备','primary wide',()=>deviceForm()),btn('体验聊天演示','secondary wide',startDemo));
 const wrap=el('div');wrap.append(card,el('p','fine center','设备资料和密码用 Android Keystore 加密，只存在这台手机上。'));return wrap;}

function deviceCard(d){
 const current=S.device?.id===d.id&&!S.demo;const card=el('section','card device-card'+(current?' current':''));
 const row=el('div','row');row.append(avatar('',current?'ok':''));const text=el('div','grow');text.append(el('div','card-title',d.name),el('div','card-meta truncate',d.user+' @ '+d.host+':'+d.port));row.append(text,ib('edit','编辑 '+d.name,()=>deviceForm(d)));card.append(row);
 const line=el('div','device-line');line.append(icon('lock'),document.createTextNode(d.remember?'密码已加密保存':'连接时输入密码'));card.append(line);
 const actions=el('div','device-actions');const busy=S.loading&&S.connecting?.id===d.id;
 const connect=btn(busy?'正在连接…':current?'已连接':'连接设备',current?'secondary':'primary',()=>connectDevice(d));connect.disabled=S.loading;
 actions.append(connect,btn('删除','secondary danger',()=>confirmAction('删除设备？','会移除这台设备及其保存的密码。','删除',async()=>{try{S.devices=(await rpc('deleteDevice',{id:d.id})).devices;if(S.connectFail?.device===d.id)S.connectFail=null;render();}catch(e){error(e);}},true)));
 card.append(actions);return card;}

function connectionCard(){
 const card=el('section','card account-card');const top=el('div','row');top.append(avatar('','ok'));const t=el('div','grow');t.append(el('div','card-title',S.device.name),el('div','card-meta',S.demo?'离线演示':'SSH 已连接'));top.append(t);card.append(top);
 [['SSH 用户',S.account?.ssh_user||S.device.user],['主机地址',S.device.host],['端口',String(S.device.port)],['电脑主机名',S.account?.hostname||'读取中…'],['密码保存',S.device.remember?'已加密保存':'未保存']].forEach(([k,v])=>{const n=el('div','setting-row');n.append(el('span','',k),el('span','',v));card.append(n);});
 const actions=el('div','device-actions');actions.append(btn('更新桥接程序','secondary',()=>setupBridge({manual:true})),btn('断开连接','secondary danger',()=>confirmAction('断开当前设备？','电脑上的 Agent 会继续运行。','断开',()=>disconnect().catch(error),true)));card.append(actions);
 card.append(el('p','fine','只显示 SSH 连接信息，不读取 Codex / Claude 的登录资料。'));return card;}

// ─── Device form ────────────────────────────────────────────────────────────
function deviceForm(d={}){
 rpc('protect').catch(error);const editing=!!d.id;const box=sheet(editing?'编辑设备':'添加设备');box.classList.add('ob-form');
 const name=obField(box,'设备名称',{value:d.name||'',placeholder:'例如：家里的电脑',enter:'next'});
 const grid=el('div','form-grid');box.append(grid);
 const host=obField(grid,'主机地址',{value:d.host||'',placeholder:'域名或 IP',mode:'url',enter:'next'});
 const port=obField(grid,'端口',{value:String(d.port||22),mode:'numeric',enter:'next'});port.maxLength=5;
 const user=obField(box,'SSH 用户名',{value:d.user||'',placeholder:'登录电脑用的用户名',enter:'next'});
 const pass=obField(box,'登录密码',{type:'password',placeholder:d.remember?'已保存；留空保留原密码':'SSH 密码',enter:'done'});
 const check=el('label','check');const remember=el('input');remember.type='checkbox';remember.checked=d.remember!==false;check.append(remember,document.createTextNode('记住密码 · 本机加密保存'));box.append(check);
 if(editing)box.append(el('p','fine','改了主机、端口或用户名，要重新输入密码。'));
 // Pasted "user@host:port" is split into the three fields.
 const split=()=>{const s=obSplitAddress(host.value);if(!s)return;host.value=s.host;if(s.port)port.value=s.port;if(s.user&&!user.value.trim())user.value=s.user;if(s.user&&user.value.trim()!==s.user)return;toast('已拆成地址'+(s.user?'、用户名':'')+(s.port?'和端口':''));};
 host.addEventListener('change',split);host.addEventListener('paste',()=>setTimeout(split,0));
 const values=()=>({id:d.id||'',name:name.value.trim(),host:host.value.trim(),port:port.value.trim(),user:user.value.trim()});
 const check1=()=>{split();const v=values();const e=obValidate(v);obError(host,e.host);obError(port,e.port);obError(user,e.user);
  const first=[['host',host],['port',port],['user',user]].find(([k])=>e[k]);if(first){first[1].focus();return null;}return v;};
 const save=async(andConnect)=>{const v=check1();if(!v)return;buttons.forEach(b=>b.disabled=true);
  const typed=pass.value;
  try{const r=await rpc('saveDevice',{...v,port:Number(v.port),password:typed,remember:remember.checked});pass.value='';S.devices=r.devices;closeSheet();
   const saved=r.devices.find(x=>x.id===(r.id||d.id));render();
   if(andConnect&&saved){if(typed)doConnect(saved,typed,remember.checked);else connectDevice(saved);}else toast('设备已保存');}
  catch(e){toast(e.message||String(e));}finally{buttons.forEach(b=>b.disabled=false);}};
 [name,host,port,user].forEach((n,i,all)=>n.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();(all[i+1]||pass).focus();}}));
 pass.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();save(!editing);}});
 const actions=el('div','sheet-actions');let buttons;
 if(editing)buttons=[btn('取消','secondary',closeSheet),btn('保存设备','primary',()=>save(false))];
 else buttons=[btn('保存设备','secondary',()=>save(false)),btn('保存并连接','primary',()=>save(true))];
 actions.append(...buttons);box.append(actions);
 if(!editing)setTimeout(()=>(d.host?pass:host).focus(),60);}

// ─── Password prompt ────────────────────────────────────────────────────────
function connectionPassword(d,problem=''){
 const box=sheet('连接 '+d.name);box.append(el('p','muted ob-sub',d.user+' @ '+d.host+':'+d.port));
 const pass=obField(box,'本次登录密码',{type:'password',enter:'go'});if(problem)obError(pass,problem);
 const label=el('label','check');const remember=el('input');remember.type='checkbox';remember.checked=true;remember.setAttribute('aria-label','记住本次登录密码');label.append(remember,document.createTextNode('记住密码 · 登录成功后加密保存'));box.append(label);
 const actions=el('div','sheet-actions');
 const go=()=>{if(!pass.value){obError(pass,'先输入密码');pass.focus();return;}const value=pass.value,save=remember.checked;pass.value='';closeSheet();doConnect(d,value,save);};
 pass.onkeydown=e=>{if(e.key==='Enter')go();};actions.append(btn('取消','secondary',closeSheet),btn('连接','primary',go));box.append(actions);setTimeout(()=>pass.focus(),50);}

// ─── Connecting ─────────────────────────────────────────────────────────────
function connectDevice(d){if(S.loading){toast('正在连接，请稍候');return;}if(S.device?.id===d.id&&!S.demo){setTab('live');return;}if(!d.remember)connectionPassword(d);else doConnect(d);}
// Titles and next steps for the error codes the native layer sends (ConnectErrors.kt).
const OB_FAIL={auth:'密码不对',auth_method:'这台电脑不让用密码登录',dns:'找不到这台电脑',refused:'端口没开',timeout:'连不上，超时了',unreachable:'手机到不了这台电脑',
 tunnel:'转发通了，电脑没回应',algorithm:'SSH 握手失败',network:'网络出错了',python_missing:'电脑上还差 Python',python_old:'电脑上的 Python 太旧',
 install_failed:'桥接程序没装上',hostkey_new:'等你核对指纹',hostkey_changed:'电脑指纹变了，已拒绝'};
async function doConnect(d,password='',remember){
 if(S.loading)return;
 if(S.device&&!S.demo&&S.device.id!==d.id){confirmAction('切换设备？','当前 SSH 连接会断开；未发送的草稿只在本次运行中保留。','切换',async()=>{await disconnect(false);doConnect(d,password,remember);});return;}
 S.loading=true;S.connecting=d;S.connectError='';S.connectFail=null;S.hostIssue=null;S.connectStage='正在建立 SSH 连接并验证身份…';netBanner(null);render();cacheConnecting(d);
 try{if(S.demo){S.demo=false;S.device=null;}
  const r=await rpc('connect',{id:d.id,password,...(remember===undefined?{}:{remember})},stage=>{S.connectStage=stage;render();});
  S.loading=false;clearTerminals();S.device=r.device;if(r.devices)S.devices=r.devices;S.account=null;S.records=[];S.statusSupported=true;hostCheck(r.host);
  if(r.ready){if(!cacheResume())setTab('live');}else{render();setupBridge({upgrade:!!r.upgrade,fromConnect:true});}
 }catch(e){S.loading=false;S.device=null;S.connectError=e.message||String(e);S.connectFail={device:d.id,d,code:e.code||'',info:e.info||null,password,remember};cacheAbandon();
  // The password is only kept (in memory) while a host-key decision is pending.
  if(!/^hostkey/.test(e.code||''))S.connectFail.password='';
  render();
  if(e.code==='hostkey_new')trustSheet(S.connectFail);
  else if(e.code==='hostkey_changed')changedSheet(S.connectFail);
  else if(e.code==='auth'||(!e.code&&/auth fail|authentication/i.test(S.connectError)))connectionPassword(d,'密码不对，再试一次');}
 finally{S.loading=false;}}
function retryConnect(){const f=S.connectFail;if(!f)return;if(S.device&&!S.demo)setupBridge({fromConnect:true});else if(f.code==='hostkey_new')trustSheet(f);else if(f.code==='hostkey_changed')changedSheet(f);else connectDevice(S.devices.find(x=>x.id===f.d.id)||f.d);}

// ─── SSH host key ───────────────────────────────────────────────────────────
function obKeyFile(type){const t=String(type||'');return t.includes('ed25519')?'ed25519':t.startsWith('ecdsa')?'ecdsa':t.includes('rsa')?'rsa':'ed25519';}
function obKeyName(type){const t=obKeyFile(type);return t==='ed25519'?'ED25519':t==='ecdsa'?'ECDSA':'RSA';}
function fingerprintBox(label,fp,type){const b=el('div','ob-fp');const head=el('div','ob-fp-head');head.append(el('span','',label+(type?' · '+obKeyName(type):'')),ib('copy','复制指纹',()=>copyText(fp)));b.append(head,el('code','ob-fp-value',fp));return b;}
function howToCheck(box,type){const d=el('details','ob-how');d.append(el('summary','','在电脑上怎么看指纹'));const cmd='ssh-keygen -lf /etc/ssh/ssh_host_'+obKeyFile(type)+'_key.pub';
 const row=el('div','ob-cmd');row.append(el('code','',cmd),ib('copy','复制命令',()=>copyText(cmd)));d.append(el('p','muted','在电脑的终端里运行，输出里的 SHA256:… 应该和上面一字不差：'),row);box.append(d);}
function trustSheet(f){
 const i=f.info||{};const box=sheet('核对电脑指纹');box.classList.add('ob-trust');
 const lead=el('div','ob-lead');lead.append(icon('shield'),el('p','','第一次连 '+(i.host||f.d.host)+':'+(i.port||f.d.port)+'。确认下面的指纹和电脑上的一致，再信任它。以后指纹变了，App 会拒绝连接。'));box.append(lead);
 box.append(fingerprintBox('电脑给出的指纹',i.fingerprint||'',i.type));howToCheck(box,i.type);
 const actions=el('div','sheet-actions');const ok=btn('信任并连接','primary',async()=>{ok.disabled=true;
  try{await rpc('trustHost',{id:f.d.id,fingerprint:i.fingerprint});closeSheet();S.connectFail=null;S.connectError='';const d=S.devices.find(x=>x.id===f.d.id)||f.d;doConnect(d,f.password,f.remember);}
  catch(e){ok.disabled=false;closeSheet();toast(e.message||String(e));}});
 actions.append(btn('取消','secondary',()=>{closeSheet();obCancelTrust();}),ok);box.append(actions);}
function obCancelTrust(){if(S.connectFail)S.connectFail.password='';S.connectFail=null;S.connectError='';render();toast('已取消，没有信任这台电脑');}
function changedSheet(f){
 const i=f.info||{};const box=sheet('电脑指纹变了');box.classList.add('ob-trust');
 const lead=el('div','ob-lead danger');lead.append(icon('alert'),el('p','',(i.host||f.d.host)+':'+(i.port||f.d.port)+' 这次给出的指纹和你之前信任的不一样，已拒绝连接。重装系统、换了电脑或改了 SSH 配置都会这样；也可能有人在中间冒充。没确认之前别连。'));box.append(lead);
 if(i.previous)box.append(fingerprintBox('之前信任的',i.previous,''));
 box.append(fingerprintBox('现在收到的',i.fingerprint||'',i.type));howToCheck(box,i.type);
 const actions=el('div','sheet-actions');
 actions.append(btn('先不连','secondary',()=>{closeSheet();obCancelTrust();}),btn('重新核对','secondary danger',()=>confirmAction('忘掉旧指纹？','只有确定电脑那边确实换了密钥才这样做。之后会重新连接，你要再核对一次新指纹。','忘掉并重新核对',async()=>{
  try{await rpc('forgetHost',{id:f.d.id});const d=S.devices.find(x=>x.id===f.d.id)||f.d;S.connectFail=null;S.connectError='';doConnect(d,f.password,f.remember);}catch(e){error(e);}},true)));
 box.append(actions);}

// ─── Bridge install / update ────────────────────────────────────────────────
function setupBridge(o={}){
 const upgrade=!!o.upgrade&&!o.manual;const box=sheet(o.manual?'重新安装桥接程序':upgrade?'更新桥接程序':'安装配套桥接程序');
 box.append(el('p','muted',upgrade?'App 更新了，电脑上的桥接程序也要换成配套的新版本。旧版本留着不动。':o.manual?'把 App 自带的桥接程序重新传到电脑上，并校验内容。':'Herdr Pocket 要在电脑上放一个小程序，用来读取会话和转发你发的消息。'));
 const list=el('ul','ob-facts');
 ['装在 ~/.herdr-pocket，只有当前 SSH 用户能读写','只读 Codex / Claude 的会话记录，不碰登录资料','开源，用 Python 3.9+ 运行，传完会校验内容']
  .forEach(t=>{const li=el('li');li.append(icon('check'),el('span','',t));list.append(li);});box.append(list);
 const actions=el('div','sheet-actions');
 actions.append(btn(o.fromConnect?'先不装，断开':'取消','secondary',()=>{closeSheet();if(o.fromConnect&&S.device&&!S.demo){disconnect(false).then(render).catch(error);toast('没装桥接程序，已断开');}}),
  btn(upgrade?'更新并进入':o.manual?'重新安装':'安装并进入','primary',()=>{closeSheet();installBridge();}));
 box.append(actions);}
async function installBridge(){
 if(S.loading)return;S.loading=true;S.connecting=S.device;S.connectError='';S.connectFail=null;S.connectStage='正在把桥接程序传到电脑上并校验…';render();
 try{const r=await rpc('install');S.loading=false;S.statusSupported=true;hostCheck(r?.host);setTab('live');}
 catch(e){S.loading=false;S.connectError=e.message||String(e);S.connectFail={device:S.device?.id,d:S.device,code:e.code||'install_failed',info:null};render();}}

// ─── Herdr on the computer ──────────────────────────────────────────────────
// `doctor` (bridge) says whether Herdr is installed and running; problems show as a calm banner.
function hostCheck(h){if(!h){S.hostIssue=null;return;}
 if(h.herdr===false)S.hostIssue={title:'电脑上没找到 Herdr',text:'这个 SSH 用户的 PATH 和 ~/.local/bin 里都没有 herdr。装好后点「重新检查」。'};
 else if(h.error)S.hostIssue={title:'Herdr 读不到',text:h.error};
 else if(h.running===0)S.hostIssue={title:'Herdr 没在运行',text:'在电脑上打开 Herdr（至少开一个会话），再点「重新检查」。'};
 else S.hostIssue=null;}
async function recheckHost(b){if(b)b.disabled=true;try{hostCheck(await remote('doctor'));if(!S.hostIssue){toast('Herdr 正常');if(S.tab==='live')loadLive();}else toast(S.hostIssue.title);}catch(e){error(e);}finally{if(b)b.disabled=false;if(!S.chat)render();}}

// ─── Banners ────────────────────────────────────────────────────────────────
// Under the top bar of list pages: connecting progress, a failed connect, or a host problem.
function connectionBanner(root){
 const f=S.connectFail;
 if(S.loading){const box=el('div','connection-status');box.setAttribute('role','status');box.append(el('span','spinner'));const t=el('div','grow');t.append(el('strong','','正在连接 '+(S.connecting?.name||S.device?.name||'')),el('div','',S.connectStage));box.append(t);root.append(box);return;}
 if(S.connectError){const box=el('div','connection-status failed');box.setAttribute('role','alert');box.append(icon('alert'));const t=el('div','grow');
  t.append(el('strong','',OB_FAIL[f?.code]||'连接未完成'),el('div','',S.connectError));
  const acts=el('div','ob-banner-actions');const d=f?.d;
  if(f?.code==='auth'&&d)acts.append(btn('重新输入密码','secondary small',()=>connectionPassword(d,'')));
  else if(f?.code==='hostkey_new')acts.append(btn('核对指纹','secondary small',()=>trustSheet(f)));
  else if(f?.code==='hostkey_changed')acts.append(btn('查看详情','secondary small',()=>changedSheet(f)));
  else if(f||S.connecting)acts.append(btn('重试','secondary small',()=>f?retryConnect():connectDevice(S.connecting)));
  if(d&&!S.device&&['auth_method','dns','refused','timeout','unreachable','tunnel'].includes(f.code))acts.append(btn('改设置','secondary small',()=>deviceForm(S.devices.find(x=>x.id===d.id)||d)));
  t.append(acts);box.append(t,ib('close','知道了',()=>{S.connectError='';S.connectFail=null;render();}));root.append(box);return;}
 if(S.hostIssue&&S.device&&!S.demo){const box=el('div','connection-status warn');box.setAttribute('role','status');box.append(icon('alert'));const t=el('div','grow');t.append(el('strong','',S.hostIssue.title),el('div','',S.hostIssue.text));
  const acts=el('div','ob-banner-actions');const b=btn('重新检查','secondary small',()=>recheckHost(b));acts.append(b);t.append(acts);box.append(t,ib('close','知道了',()=>{S.hostIssue=null;render();}));root.append(box);}}

// A floating pill for silent reconnects; it lives outside #app so re-renders keep it.
// state: null | 'reconnecting' | 'failed' | 'hostkey' | 'ok'
let obNetTimer;
function netBanner(state,detail=''){
 S.net=state;clearTimeout(obNetTimer);let n=document.getElementById('net-banner');
 if(!state){n?.remove();return;}
 if(!n){n=el('div','net-banner');n.id='net-banner';n.setAttribute('role','status');n.setAttribute('aria-live','polite');document.body.append(n);}
 n.className='net-banner '+state;n.replaceChildren();
 if(state==='reconnecting'){n.append(el('span','spinner'),el('span','grow','连接断了，正在重连…'));}
 else if(state==='ok'){n.append(icon('check'),el('span','grow','已重新连上'));obNetTimer=setTimeout(()=>netBanner(null),2200);}
 else{n.append(icon('alert'));const t=el('span','grow',state==='hostkey'?'电脑指纹变了，已停止自动重连':'连不上电脑');t.title=detail;n.append(t);
  if(state==='hostkey')n.append(btn('去设备页','net-action',()=>{netBanner(null);if(typeof T!=='undefined')leaveTerminal();disconnect().catch(error);}));
  else n.append(btn('重试','net-action',()=>netRetry()));}}
async function netRetry(){if(!S.device||S.demo||S.net==='reconnecting'){netBanner(null);return;}netBanner('reconnecting');
 try{await rpc('reconnect');netBanner('ok');refreshStatus();if(S.chat?.record&&!S.paused)fetchHistory();else if(S.tab==='live'&&!S.chat&&S.liveError)loadLive();}
 catch(e){if(S.net==='reconnecting')netBanner(e.code==='hostkey_changed'?'hostkey':'failed',e.message);}}
// Native connection events (PocketCore.reconnect).
function netEvent(e){
 if(e.type==='reconnecting'){S.reconnecting=true;netBanner('reconnecting');}
 else if(e.type==='reconnected'){S.reconnecting=false;netBanner('ok');if(typeof T!=='undefined'&&T.shell&&!T.shell.ended){T.shell.ended=true;terminalStatus(T.shell,'连接中断过，这个 SSH 终端已结束；返回列表重新打开');}}
 else if(e.type==='reconnect_failed'){S.reconnecting=false;netBanner('failed',e.detail);}
 else if(e.type==='hostkey_changed'){S.reconnecting=false;netBanner('hostkey',e.detail);}}
// Back from the background: a failed reconnect gets one quiet retry.
function netForeground(){if(S.net==='failed')netRetry();}

// ─── Disconnect ─────────────────────────────────────────────────────────────
async function disconnect(show=true){await rpc('disconnect');clearTerminals();netBanner(null);Object.assign(S,{device:null,loading:false,connecting:null,connectError:'',connectFail:null,hostIssue:null,liveLoading:false,liveError:'',demo:false,records:[],agents:[],account:null,chat:null,outbox:[],activity:'',fromCache:false});S.drafts.clear();S.bindings.clear();queueClear();S.epoch++;if(show)setTab('devices');}
