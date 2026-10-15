'use strict';
// SSH key login: the phone's key (SshIdentity.kt), the login-method choice in the device form,
// installing the public key over the current password session, and importing an existing key.
// Loaded before onboard.js and app.js: only declarations at top level.
// Security: the page only ever sees the PUBLIC key. The private key is generated, imported (file
// read natively) and decrypted by the native layer only. Writing to authorized_keys happens only
// after the confirmation sheet showing the exact line, and native re-checks it is still that line.

// Cached public info ({exists, publicKey, fingerprint, type, created, imported}); null until asked.
let KEY=null;
async function keyInfo(create){
 KEY=await rpc('identity');
 if(!KEY.exists&&create)KEY=await rpc('identityCreate',{});
 return KEY;}
// One-line install command; the comment is restricted natively to [A-Za-z0-9._@-], so single quotes are safe.
function keyCommand(line){return "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '"+line+"' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys";}
function keyName(type){return typeof obKeyName==='function'?obKeyName(type):'SSH';}
function keyDate(ms){if(!ms)return '';const d=new Date(ms);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}

// The public key with copy buttons: the key itself and the one-line command for the computer.
function keyPublicBox(k,compact){
 const b=el('div','key-pub'+(compact?' compact':''));const head=el('div','ob-fp-head');
 head.append(el('span','','公钥 · '+keyName(k.type)),ib('copy','复制公钥',()=>copyText(k.publicKey)));
 const value=el('code','key-pub-value',k.publicKey);
 b.append(head,value,el('div','key-fp',k.fingerprint));
 return b;}
function keyCommandBox(k){
 const wrap=el('div','key-cmd-wrap');wrap.append(el('p','muted','或者在电脑的终端里运行这一行，把公钥加上：'));
 const cmd=keyCommand(k.publicKey);const row=el('div','ob-cmd');row.append(el('code','',cmd),ib('copy','复制命令',()=>copyText(cmd)));wrap.append(row);return wrap;}

// ─── The phone's key ───────────────────────────────────────────────────────
async function keysSheet(){
 obIcons();rpc('protect').catch(error);
 const box=sheet('登录密钥');box.classList.add('key-sheet');const body=el('div','key-body');body.append(el('div','key-loading spinner'));box.append(body);
 let k;try{k=await keyInfo(false);}catch(e){closeSheet();error(e);return;}
 if(!box.isConnected)return;
 body.replaceChildren();
 if(!k.exists){
  const lead=el('div','ob-lead');lead.append(icon('key'),el('p','','用密钥代替密码登录电脑：手机生成一把 Ed25519 密钥，私钥加密存在手机里，不显示也不会传出去；把公钥加到电脑上就能免密码登录。'));
  body.append(lead);
  const actions=el('div','sheet-actions');const make=btn('生成密钥','primary',async()=>{make.disabled=true;try{await rpc('identityCreate',{});toast('密钥生成好了');keysSheet();}catch(e){make.disabled=false;error(e);}});
  actions.append(btn('导入已有私钥','secondary',()=>keyImport(false)),make);body.append(actions);return;}
 const lead=el('div','ob-lead');lead.append(icon('shield'),el('p','','私钥加密存在这台手机里，不会显示，也不会传出去。把下面的公钥加到电脑上，就能用它登录。'));body.append(lead);
 body.append(keyPublicBox(k));
 body.append(el('p','fine key-meta',(k.imported?'导入于 ':'生成于 ')+keyDate(k.created)+(k.comment?' · '+k.comment:'')));
 body.append(el('p','fine key-easy','最省事：先用密码连上电脑，再在设备页点「装公钥」，App 帮你加好并试登一次。'));
 body.append(keyCommandBox(k));
 const actions=el('div','sheet-actions');
 actions.append(btn('导入私钥','secondary',()=>keyImport(true)),btn('重新生成','secondary danger',()=>confirmAction('重新生成密钥？','旧公钥会作废：加过旧公钥的电脑都要换成新公钥，用密钥登录的设备在装好之前会连不上。','重新生成',async()=>{try{await rpc('identityCreate',{replace:true});toast('已生成新密钥');keysSheet();}catch(e){error(e);}},true)));
 body.append(actions);}

// Import an existing private key file: picked and read natively, passphrase asked here if needed.
function keyImport(replacing){
 const go=async()=>{
  try{const r=await rpc('identityImport');if(r.cancelled)return;
   if(r.needPassphrase)keyPassphrase();else{await rpc('identityImportConfirm',{});toast('私钥导入好了');keysSheet();}}
  catch(e){error(e);}};
 if(replacing)confirmAction('换成导入的私钥？','现在这把密钥会被替换；加过它的公钥的电脑要换成新导入的公钥。','选择私钥文件',go,true);else go();}
function keyPassphrase(problem=''){
 const box=sheet('输入私钥密码');box.append(el('p','muted ob-sub','这个私钥有密码保护。密码只用来解开它，不会保存；解开后私钥用手机的 Keystore 加密保存。'));
 const pass=obField(box,'私钥密码',{type:'password',enter:'go'});if(problem)obError(pass,problem);
 const actions=el('div','sheet-actions');
 const ok=btn('导入','primary',async()=>{if(!pass.value){obError(pass,'先输入密码');pass.focus();return;}const value=pass.value;pass.value='';ok.disabled=true;
  try{await rpc('identityImportConfirm',{passphrase:value});toast('私钥导入好了');keysSheet();}
  catch(e){ok.disabled=false;if(e.code==='passphrase'){obError(pass,e.message);pass.focus();}else{closeSheet();error(e);}}});
 pass.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();ok.click();}});
 actions.append(btn('取消','secondary',()=>{rpc('identityImportCancel').catch(()=>{});closeSheet();}),ok);box.append(actions);setTimeout(()=>pass.focus(),50);}

// ─── Device form: login method ─────────────────────────────────────────────
// Adds 「登录方式 密码/密钥」 above the password field. Returns {get(), key()}.
// passwordParts are the nodes shown only for password login; keyPanel replaces them for key login.
function keyAuthChoice(box,before,d,passwordParts,onChange){
 obIcons();let auth=d.auth==='key'?'key':'password';
 const row=el('div','key-auth');const label=el('span','ob-label key-auth-label','登录方式');
 const g=el('div','seg key-seg');g.setAttribute('role','radiogroup');g.setAttribute('aria-label','登录方式');
 const opts=[['password','密码'],['key','密钥']].map(([v,t])=>{const b=btn(t,'seg-opt',()=>set(v));b.setAttribute('role','radio');g.append(b);return [v,b];});
 row.append(label,g);box.insertBefore(row,before);
 const panel=el('div','key-panel');box.insertBefore(panel,before);
 const dropNote=el('p','fine key-drop','改成密钥后，这台设备保存的密码会删掉。');
 const fill=async()=>{panel.replaceChildren(el('div','key-loading spinner'));
  try{const k=await keyInfo(true);if(auth!=='key')return;panel.replaceChildren();
   const head=el('div','key-panel-head');head.append(icon('key'),el('div','grow','用这台手机的密钥登录。电脑要先有它的公钥（~/.ssh/authorized_keys）。'));
   panel.append(head,keyPublicBox(k,true));
   const acts=el('div','key-panel-actions');const cmd=keyCommand(k.publicKey);
   acts.append(btn('复制安装命令','secondary small',()=>copyText(cmd),'copy'),btn('密钥详情','secondary small',()=>keysSheet(),'key'));panel.append(acts);
   panel.append(el('p','fine','电脑现在能用密码登录？先选「密码」连上，再在设备页点「装公钥」，App 帮你装好。'));
   if(d.id&&d.remember)panel.append(dropNote);}
  catch(e){panel.replaceChildren(el('p','field-error',e.message||String(e)));}};
 function set(v){auth=v;for(const [k,b] of opts){b.classList.toggle('on',k===v);b.setAttribute('aria-checked',String(k===v));}
  passwordParts.forEach(n=>n.classList.toggle('hidden',v==='key'));panel.classList.toggle('hidden',v!=='key');
  if(v==='key')fill();onChange&&onChange(v);}
 set(auth);
 return {get:()=>auth};}

// ─── Install the public key over the current password session ──────────────
async function installKeySheet(){
 if(!S.device||S.demo)return;const d=S.device;obIcons();rpc('protect').catch(error);
 let k;try{k=await keyInfo(true);}catch(e){error(e);return;}
 const box=sheet('把公钥装到电脑上');box.classList.add('key-sheet');
 const lead=el('div','ob-lead');lead.append(icon('key'),el('p','','用现在的 SSH 连接，在 '+d.user+'@'+d.host+' 上只做这几件事：'));box.append(lead);
 const list=el('ul','ob-facts');
 ['~/.ssh 不存在就新建，权限 700','在 ~/.ssh/authorized_keys 末尾加下面这一行；已经有了就不写','新建的文件权限 600；已有的只去掉别人的写权限','别的文件和已有的行一概不动']
  .forEach(t=>{const li=el('li');li.append(icon('check'),el('span','',t));list.append(li);});box.append(list);
 const line=el('div','key-pub');const head=el('div','ob-fp-head');head.append(el('span','','要写入的一行'),ib('copy','复制这一行',()=>copyText(k.publicKey)));
 line.append(head,el('code','key-pub-value',k.publicKey));box.append(line);
 const actions=el('div','sheet-actions');
 const ok=btn('确认写入','primary',async()=>{ok.disabled=true;ok.textContent='正在写入…';
  try{const r=await rpc('installKey',{id:d.id,line:k.publicKey});keyInstalled(d,r,k);}
  catch(e){closeSheet();error(e);}});
 actions.append(btn('取消','secondary',closeSheet),ok);box.append(actions);}
function keyInstalled(d,r,k){
 if(!r.verified){
  const box=sheet('公钥写好了，但还登不上');const lead=el('div','ob-lead danger');lead.append(icon('alert'),el('p','',(r.appended?'已经加到 ~/.ssh/authorized_keys。':'电脑上本来就有这个公钥，没有重复写。')+'用密钥试登录没成功：'+(r.problem||'')));box.append(lead);
  box.append(el('p','fine','继续用密码登录不受影响。常见原因：家目录或 ~/.ssh 让别人可写；sshd 关了 PubkeyAuthentication；或者 AuthorizedKeysFile 指向别的文件。'));
  const actions=el('div','sheet-actions');actions.append(btn('知道了','primary',closeSheet));box.append(actions);return;}
 const box=sheet('密钥能用了');const lead=el('div','ob-lead key-ok');lead.append(icon('check'),el('p','',(r.appended?'公钥已加到 '+d.user+'@'+d.host+' 的 ~/.ssh/authorized_keys，':'电脑上本来就有这个公钥，没有重复写，')+'刚才用密钥试登录了一次，成功。'));box.append(lead);
 const text=d.remember?'以后连这台电脑用密钥，不用再输密码。保存的密码会从手机上删掉。':'以后连这台电脑用密钥，不用再输密码。';box.append(el('p','muted key-next',text));
 const actions=el('div','sheet-actions');
 const use=btn(d.remember?'用密钥，删掉密码':'以后用密钥登录','primary',async()=>{use.disabled=true;
  try{const r2=await rpc('useKey',{id:d.id});S.devices=r2.devices;S.device={...S.device,auth:'key',remember:false};closeSheet();render();toast(d.remember?'改成密钥登录了，保存的密码已删掉':'改成密钥登录了');}
  catch(e){use.disabled=false;error(e);}});
 actions.append(btn('先保留密码','secondary',closeSheet),use);box.append(actions);}

// A short callout on the connection card while the device still logs in with a password.
function keyCallout(){
 obIcons();const c=el('div','key-callout');const t=el('div','grow');
 t.append(el('strong','','以后免密码登录'),el('span','','把这台手机的公钥装到电脑上，改用密钥连接。'));
 c.append(icon('key'),t,btn('装公钥','secondary small',()=>installKeySheet()));return c;}
// The 「登录密钥」 row on the devices page.
function keyRow(){
 obIcons();const card=el('section','card list-card key-row');
 const b=btn('','card-button',()=>keysSheet());const t=el('span','grow');t.append(el('span','card-title','登录密钥'),el('span','card-meta','用这台手机的密钥代替密码登录电脑'));
 const i=el('span','key-row-icon');i.append(icon('key'));b.append(i,t,icon('chevron'));card.append(b);return card;}
