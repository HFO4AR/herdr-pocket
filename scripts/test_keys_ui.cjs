// SSH key login: login-method choice in the device form, the phone's key sheet, installing the
// public key over a password session (only after a confirmation that shows the exact line),
// switching to key login, key errors with next steps, and importing a key with a passphrase.
// Native is a scripted offline fixture; it only ever hands the page a PUBLIC key.
const {chromium}=require('playwright');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=process.env.SHOTS||'';if(shots)fs.mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 const PUB='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJI2y09d3qoZ0MJhxP4W1Z7HZ/2ABeQSjRpTnKCCv4qB herdr-pocket@Pixel-8';
 const PUB2='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM53Ro7r39h30agrHJcziffCODxt1o+qZirWP33aWg5J herdr-pocket@Pixel-8';
 window.fx={calls:[],connect:[],install:[],importRead:[],importConfirm:[],key:{exists:false},PUB,PUB2};let devices=[];
 const reply=(id,r)=>setTimeout(()=>nativeResult(id,r),0);
 const keyInfo=()=>fx.key;
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);fx.calls.push({op,a});
  const queued=(q,d={ok:true,data:{}})=>q.length?q.shift():d;
  if(op==='devices')return reply(id,{ok:true,data:{devices,version:'0.6.0'}});
  if(op==='saveDevice'){const auth=a.auth||'password';const d={id:a.id||'d'+(devices.length+1),name:a.name||a.host,host:a.host,port:a.port,user:a.user,auth,remember:auth==='password'&&!!(a.remember&&a.password)};
   devices=devices.filter(x=>x.id!==d.id).concat([d]);return reply(id,{ok:true,data:{devices,id:d.id}});}
  if(op==='connect'){const d=devices.find(x=>x.id===a.id);const r=queued(fx.connect);if(r.ok&&!r.data.device)r.data={device:d,devices,ready:true,...r.data};return reply(id,r);}
  if(op==='identity')return reply(id,{ok:true,data:keyInfo()});
  if(op==='identityCreate'){if(fx.key.exists&&!a.replace)return reply(id,{ok:false,error:'已经有密钥了'});
   fx.key={exists:true,type:'ssh-ed25519',publicKey:fx.key.exists?PUB2:PUB,fingerprint:'SHA256:'+(fx.key.exists?'new':'abc')+'Fingerprint0123456789abcdefghijklmnopqrs',comment:'herdr-pocket@Pixel-8',created:Date.UTC(2026,9,15),imported:false};return reply(id,{ok:true,data:fx.key});}
  if(op==='identityImport')return reply(id,queued(fx.importRead));
  if(op==='identityImportConfirm'){const r=queued(fx.importConfirm);if(r.ok)fx.key={...fx.key,exists:true,imported:true,publicKey:PUB2};return reply(id,r.ok?{ok:true,data:fx.key}:r);}
  if(op==='installKey')return reply(id,queued(fx.install));
  if(op==='useKey'){devices=devices.map(x=>x.id===a.id?{...x,auth:'key',remember:false}:x);return reply(id,{ok:true,data:{devices}});}
  if(op==='remote'){if(a.op==='sessions')return reply(id,{ok:true,data:{sessions:[]}});if(a.op==='account')return reply(id,{ok:true,data:{ssh_user:'yuki',hostname:'box'}});if(a.op==='doctor')return reply(id,{ok:true,data:{herdr:true,running:1}});
   return reply(id,{ok:true,data:{}});}
  if(['protect','settings','disconnect','trustHost','forgetHost','cacheGet','cachePut','demo','identityImportCancel','watchState','setAlerts'].includes(op))return reply(id,{ok:true,data:op==='cacheGet'?{value:null}:{}});
  throw Error('Unexpected native op '+op);}};
});
await page.goto(require('./ui_bundle.cjs').url(html));
const calls=op=>page.evaluate(o=>fx.calls.filter(c=>c.op===o).map(c=>c.a),op);
const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||[...document.querySelectorAll('.sheet,.main')].some(n=>n.scrollWidth>n.clientWidth+1));
const shot=async name=>{if(shots){await page.waitForTimeout(600);await page.screenshot({path:path.join(shots,name+'.png')});}};
const PUB=await page.evaluate(()=>fx.PUB),PUB2=await page.evaluate(()=>fx.PUB2);
const narrow=async label=>{await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,label+' fits 320 px');await page.setViewportSize({width:390,height:844});};

// ── Device form: password stays the default; choosing 密钥 makes the key and shows its public half ──
await page.getByRole('button',{name:'添加第一台设备'}).click();
await page.getByRole('dialog',{name:'添加设备'}).waitFor();
const pw=page.getByRole('radio',{name:'密码',exact:true}),kr=page.getByRole('radio',{name:'密钥',exact:true});
assert.equal(await pw.getAttribute('aria-checked'),'true','password is the default for new devices');
assert(await page.getByLabel('登录密码',{exact:true}).isVisible());
assert.equal((await calls('identity')).length,0,'nothing about keys is asked until 密钥 is chosen');
await page.getByRole('textbox',{name:'主机地址',exact:true}).fill('box.lan');
await page.getByRole('textbox',{name:'SSH 用户名',exact:true}).fill('yuki');
await kr.click();
await page.getByText(PUB,{exact:true}).waitFor();
assert.equal(await kr.getAttribute('aria-checked'),'true');
assert.equal(await page.getByLabel('登录密码',{exact:true}).isVisible(),false,'no password field for key login');
assert.equal((await calls('identityCreate')).length,1,'the key is made the first time 密钥 is chosen');
await shot('form-key');
await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot('form-key-dark');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
await narrow('key form');
await page.getByRole('button',{name:'复制安装命令'}).click();
await page.getByText('已复制',{exact:true}).waitFor();
await page.getByRole('button',{name:'保存并连接',exact:true}).click();
await page.waitForFunction(()=>S.device&&!S.loading);
await page.evaluate(()=>setTab('devices'));
await page.getByText('这台手机的密钥',{exact:true}).waitFor();
// Connected, it shows once: the card on top says how it logs in; no saved-list copy below.
assert.equal(await page.getByText('用这台手机的密钥登录',{exact:true}).count(),0,'the connected computer is not listed again');
assert.equal(await page.getByText('以后免密码登录',{exact:true}).count(),0,'no install callout for a key device');
await shot('devices-key');
const saved=(await calls('saveDevice'))[0];
assert.equal(saved.auth,'key');assert.equal(saved.password,'','no password is sent for a key device');assert.equal(saved.remember,false);
const c1=(await calls('connect'))[0];assert.equal(c1.password,'','key connect carries no password');
assert.equal(await page.getByRole('dialog',{name:/^连接 /}).count(),0,'no password prompt for key devices');
console.log('PASS: password is default; 密钥 creates the key, shows the public key and install command; key devices connect without a password');

// ── Key rejected: clear message and next steps ──
await page.evaluate(()=>disconnect(false).then(render));
await page.evaluate(()=>{fx.connect.push({ok:false,code:'key_rejected',error:'电脑没接受这台手机的密钥。先把公钥装到 yuki 的 ~/.ssh/authorized_keys；装过了的话，看看 ~/.ssh 是不是 700、authorized_keys 是不是 600，家目录不能让别人可写。'});connectDevice(S.devices[0]);});
await page.getByText('电脑没接受密钥',{exact:true}).waitFor();
await shot('key-rejected');
assert(await page.getByRole('button',{name:'改用密码',exact:true}).isVisible());
await page.getByRole('button',{name:'查看公钥',exact:true}).click();
await page.getByRole('dialog',{name:'登录密钥'}).waitFor();
await page.getByText(PUB,{exact:true}).waitFor();
await page.getByText(/^mkdir -p ~\/\.ssh && chmod 700/).waitFor();
await shot('keys-sheet');
await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot('keys-sheet-dark');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
await narrow('keys sheet');
await page.getByRole('button',{name:'关闭'}).first().click();
await page.getByRole('button',{name:'改用密码',exact:true}).click();
await page.getByRole('dialog',{name:'编辑设备'}).waitFor();
assert.equal(await page.getByRole('radio',{name:'密码',exact:true}).getAttribute('aria-checked'),'true','改用密码 opens the form on 密码');
await page.getByRole('button',{name:'取消',exact:true}).click();
await page.getByRole('button',{name:'知道了'}).click();
console.log('PASS: key rejected shows a clear title, the public key and a way back to passwords');

// ── Password-only computer: 改用密钥登录 ──
await page.evaluate(()=>{fx.connect.push({ok:false,code:'auth_method',error:'这台电脑没开密码登录（只允许密钥）。'});const d=S.devices[0];d.auth='password';d.remember=true;connectDevice(d);});
await page.getByText('这台电脑不让用密码登录',{exact:true}).waitFor();
await page.getByRole('button',{name:'改用密钥登录',exact:true}).click();
await page.getByRole('dialog',{name:'编辑设备'}).waitFor();
assert.equal(await page.getByRole('radio',{name:'密钥',exact:true}).getAttribute('aria-checked'),'true');
await page.getByText('改成密钥后，这台设备保存的密码会删掉。',{exact:true}).waitFor();
await page.getByRole('button',{name:'取消',exact:true}).click();
await page.getByRole('button',{name:'知道了'}).click();
console.log('PASS: password-only refusal offers key login and warns the saved password goes');

// ── Install the public key over a password session ──
await page.evaluate(()=>{fx.connect.push({ok:true,data:{}});const d=S.devices[0];d.auth='password';d.remember=true;doConnect(d,'pw');});
await page.waitForFunction(()=>S.device&&!S.loading);
await page.evaluate(()=>setTab('devices'));
await page.getByText('以后免密码登录',{exact:true}).waitFor();
await shot('callout');
await page.getByRole('button',{name:'装公钥',exact:true}).click();
await page.getByRole('dialog',{name:'把公钥装到电脑上'}).waitFor();
await page.getByText('要写入的一行',{exact:true}).waitFor();
await page.getByText(PUB,{exact:true}).waitFor();
await page.getByText('别的文件和已有的行一概不动',{exact:true}).waitFor();
await shot('install-confirm');
await narrow('install sheet');
await page.getByRole('button',{name:'取消',exact:true}).click();
assert.equal((await calls('installKey')).length,0,'nothing is written without the confirmation');
// Not accepted yet: explain, keep the password.
await page.evaluate(()=>fx.install.push({ok:true,data:{appended:true,verified:false,code:'key_rejected',problem:'电脑没接受这台手机的密钥。'}}));
await page.getByRole('button',{name:'装公钥',exact:true}).click();
await page.getByRole('button',{name:'确认写入',exact:true}).click();
await page.getByRole('dialog',{name:'公钥写好了，但还登不上'}).waitFor();
assert.deepEqual((await calls('installKey'))[0],{id:'d1',line:PUB},'writes exactly the line that was shown');
assert.equal((await calls('useKey')).length,0);
await page.getByRole('button',{name:'知道了',exact:true}).click();
// Accepted: offer to switch and drop the saved password.
await page.evaluate(()=>fx.install.push({ok:true,data:{appended:false,verified:true}}));
await page.getByRole('button',{name:'装公钥',exact:true}).click();
await page.getByRole('button',{name:'确认写入',exact:true}).click();
await page.getByRole('dialog',{name:'密钥能用了'}).waitFor();
await page.getByText(/本来就有这个公钥，没有重复写/).waitFor();
await shot('install-done');
await page.getByRole('button',{name:'用密钥，删掉密码',exact:true}).click();
await page.getByText('改成密钥登录了，保存的密码已删掉',{exact:true}).waitFor();
assert.deepEqual((await calls('useKey'))[0],{id:'d1'});
await page.getByText('这台手机的密钥',{exact:true}).waitFor();
assert.equal(await page.getByText('以后免密码登录',{exact:true}).count(),0,'callout gone once the key is used');
console.log('PASS: install sheet shows the exact line, cancel writes nothing, failed probe keeps the password, success switches to key');

// ── The keys row, regenerate needs confirmation ──
await page.evaluate(()=>disconnect(false).then(render));
await page.getByRole('button',{name:/登录密钥/}).click();
await page.getByRole('dialog',{name:'登录密钥'}).waitFor();
await page.getByRole('button',{name:'重新生成',exact:true}).click();
await page.getByRole('dialog',{name:'重新生成密钥？'}).waitFor();
await page.getByRole('button',{name:'取消',exact:true}).click();
assert.equal((await calls('identityCreate')).filter(a=>a.replace).length,0,'cancel keeps the key');
await page.getByRole('button',{name:/登录密钥/}).click();
await page.getByRole('button',{name:'重新生成',exact:true}).click();
await page.getByRole('dialog',{name:'重新生成密钥？'}).getByRole('button',{name:'重新生成',exact:true}).click();
await page.getByText(PUB2,{exact:true}).waitFor();
assert.equal((await calls('identityCreate')).filter(a=>a.replace).length,1);
console.log('PASS: keys row opens the key sheet; regenerating needs a confirmation');

// ── Import an existing key with a passphrase ──
await page.evaluate(()=>{fx.importRead.push({ok:true,data:{needPassphrase:true}});fx.importConfirm.push({ok:false,code:'passphrase',error:'私钥密码不对'},{ok:true});});
await page.getByRole('button',{name:'导入私钥',exact:true}).click();
await page.getByRole('button',{name:'选择私钥文件',exact:true}).click();
await page.getByRole('dialog',{name:'输入私钥密码'}).waitFor();
await shot('passphrase');
const pp=page.getByLabel('私钥密码',{exact:true});
await page.getByRole('button',{name:'导入',exact:true}).click();
await page.getByText('先输入密码',{exact:true}).waitFor();
await pp.fill('wrong');await page.getByRole('button',{name:'导入',exact:true}).click();
await page.getByText('私钥密码不对',{exact:true}).waitFor();
assert.equal(await pp.inputValue(),'','the passphrase is cleared after each try');
await pp.fill('right');await page.getByRole('button',{name:'导入',exact:true}).click();
await page.getByText('私钥导入好了',{exact:true}).waitFor();
await page.getByText(/^导入于 /).waitFor();
assert.deepEqual((await calls('identityImportConfirm')).map(a=>a.passphrase),['wrong','right']);
console.log('PASS: import asks for the passphrase, keeps wrong tries inline, stores on success');

assert.deepEqual(errors,[]);
await browser.close();
console.log('ALL KEY UI CHECKS PASSED');
})().catch(e=>{console.error(e);process.exit(1);});
