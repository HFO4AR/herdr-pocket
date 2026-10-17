// Jump hosts (跳板机) in the device form: add/validate/reorder/remove hops, the save payload, editing
// with saved hop passwords, the route on device cards, hop errors (never the device password prompt)
// and per-hop host-key sheets. Native is a scripted offline fixture; nothing reaches a real host.
const {chromium}=require('playwright');
const path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 window.fx={calls:[],connect:[]};
 // Like SecureProfiles: passwords stay "native"; the list only says remember per device and hop.
 const vault=[{id:'d1',name:'家里的电脑',host:'box.lan',port:22,user:'yuki',auth:'password',password:'pw'}];
 const shown=d=>{const o={...d,remember:!!d.password};delete o.password;if(d.jumps?.length)o.jumps=d.jumps.map(h=>{const x={...h,remember:!!h.password};delete x.password;return x;});else delete o.jumps;return o;};
 const list=()=>vault.map(shown);
 const reply=(id,r)=>setTimeout(()=>nativeResult(id,r),0);
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);fx.calls.push({op,a});
  if(op==='devices')return reply(id,{ok:true,data:{devices:list(),version:'0.6.0'}});
  if(op==='saveDevice'){const old=vault.find(x=>x.id===a.id);let p='';const keep={};
   (old?.jumps||[]).forEach(h=>{p+='>'+h.host+':'+h.port;keep[p+'|'+h.user]=h.password;});p='';
   const jumps=(a.jumps||[]).map(h=>{p+='>'+h.host+':'+h.port;return {...h,password:h.auth==='key'?'':h.password||keep[p+'|'+h.user]||''};});
   if(jumps.some(h=>h.auth==='password'&&!h.password))return reply(id,{ok:false,error:'跳板机还没填密码'});
   const d={id:a.id||'d'+(vault.length+1),name:a.name||a.host,host:a.host,port:a.port,user:a.user,auth:a.auth,password:a.remember?(a.password||old?.password||''):'',jumps};
   if(old)vault.splice(vault.indexOf(old),1,d);else vault.push(d);return reply(id,{ok:true,data:{devices:list(),id:d.id}});}
  if(op==='connect'){const r=fx.connect.length?fx.connect.shift():{ok:true,data:{}};if(r.ok)r.data={device:shown(vault.find(x=>x.id===a.id)),devices:list(),ready:true,...r.data};return reply(id,r);}
  if(op==='remote'){if(a.op==='sessions')return reply(id,{ok:true,data:{sessions:[]}});if(a.op==='account')return reply(id,{ok:true,data:{ssh_user:'yuki',hostname:'box'}});if(a.op==='doctor')return reply(id,{ok:true,data:{}});
   return reply(id,{ok:true,data:{}});}
  if(op==='identity')return reply(id,{ok:true,data:{exists:true,publicKey:'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFake herdr-pocket',fingerprint:'SHA256:fake',type:'ssh-ed25519'}});
  if(['protect','settings','disconnect','trustHost','forgetHost','cacheGet','cachePut','cacheDrop'].includes(op))return reply(id,{ok:true,data:op==='cacheGet'?{value:null}:{}});
  return reply(id,{ok:true,data:{}});}};
});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
const calls=op=>page.evaluate(o=>fx.calls.filter(c=>c.op===o).map(c=>c.a),op);
const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||[...document.querySelectorAll('.sheet,.main')].some(n=>n.scrollWidth>n.clientWidth+1));
const box=n=>page.getByRole('textbox',{name:'跳板机 '+n+' 地址',exact:true});
const hopUser=n=>page.getByRole('textbox',{name:'跳板机 '+n+' 用户名',exact:true});
const hopPass=n=>page.getByLabel('跳板机 '+n+' 密码',{exact:true});
const cards=()=>page.locator('.hop-card').count();
const tap=async(name)=>{await page.getByRole('button',{name,exact:true}).click();};

// ── A plain device is unchanged: no route line ──
await page.getByText('家里的电脑',{exact:true}).waitFor();
assert.equal(await page.locator('.hop-line').count(),0,'plain device shows no route');
console.log('PASS: devices without jump hosts look as before');

// ── New device: add hops, validation, paste split, key hop, max 3, reorder, remove ──
await tap('添加设备');
const form=page.getByRole('dialog',{name:'添加设备'});await form.waitFor();await page.waitForTimeout(200);
await form.getByRole('region',{name:'通过跳板机连接'}).waitFor();
assert.equal(await cards(),0,'no hop until asked');
await page.getByRole('textbox',{name:'主机地址',exact:true}).fill('10.20.0.5');
await page.getByRole('textbox',{name:'SSH 用户名',exact:true}).fill('dev');
await page.getByLabel('登录密码',{exact:true}).fill('dev-pw');
await tap('添加跳板机');
await box(1).waitFor();
await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='跳板机 1 地址');
await box(1).fill('ops@jump-a.example.test:2201');await box(1).dispatchEvent('change');
assert.equal(await box(1).inputValue(),'jump-a.example.test');
assert.equal(await page.getByRole('textbox',{name:'跳板机 1 端口',exact:true}).inputValue(),'2201');
assert.equal(await hopUser(1).inputValue(),'ops');
await tap('保存并连接');
await page.getByText('填跳板机的密码',{exact:true}).waitFor();
assert.equal(await hopPass(1).getAttribute('aria-invalid'),'true');
assert.equal((await calls('saveDevice')).length,0,'invalid hop never reaches native');
await hopPass(1).fill('jump-a-pw');
assert.equal(await hopPass(1).getAttribute('type'),'password','hop password masked');
await tap('再加一台跳板机');await box(2).waitFor();
await tap('保存设备');
await page.getByText('填跳板机的地址',{exact:true}).waitFor();
await page.getByText('填登录跳板机的用户名',{exact:true}).waitFor();
await box(2).fill('jump-b.example.test');await hopUser(2).fill('relay');
await page.getByRole('radiogroup',{name:'跳板机 2 登录方式'}).getByRole('radio',{name:'密钥'}).click();
assert.equal(await hopPass(2).isVisible(),false,'key hop hides its password');
await page.locator('.hop-card').nth(1).getByText('用这台手机的密钥登录跳板机',{exact:false}).waitFor();
await tap('再加一台跳板机');await box(3).waitFor();
const add=page.locator('.hop-add');
assert.equal(await add.isDisabled(),true,'at most 3 hops');assert.equal((await add.textContent()).trim(),'最多 3 台跳板机');
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'3 hops fit 320 px');await page.setViewportSize({width:390,height:844});
await tap('删除跳板机 3');
await page.waitForFunction(()=>document.querySelectorAll('.hop-card').length===2);
assert.equal(await add.isDisabled(),false);
// Reorder keeps what was typed, including the password, and the auth choice.
await tap('跳板机 2 往前挪');
await page.waitForFunction(()=>document.querySelector('[aria-label="跳板机 1 地址"]').value==='jump-b.example.test');
assert.equal(await box(2).inputValue(),'jump-a.example.test');
assert.equal(await hopPass(2).inputValue(),'jump-a-pw','typed password survives reorder');
assert.equal(await page.getByRole('radiogroup',{name:'跳板机 1 登录方式'}).getByRole('radio',{name:'密钥'}).getAttribute('aria-checked'),'true');
assert.equal((await page.locator('.hop-route').innerText()).replace(/\s+/g,' '),'手机 → jump-b.example.test → jump-a.example.test → 10.20.0.5');
await tap('跳板机 1 往后挪');
await page.waitForFunction(()=>document.querySelector('[aria-label="跳板机 1 地址"]').value==='jump-a.example.test');
console.log('PASS: add hops, inline errors, user@host:port split, key hop, max 3, remove, reorder keeps input');

// A stray tap on the dimmed page keeps the typed form (× still closes it).
await page.mouse.click(195,30);
await page.getByText('填的内容还没保存；不要了就点右上角 ×',{exact:true}).waitFor();
assert.equal(await page.getByRole('dialog',{name:'添加设备'}).count(),1,'backdrop tap keeps a typed form');
assert.equal(await hopPass(1).inputValue(),'jump-a-pw');
console.log('PASS: backdrop tap does not throw away a typed device form');

// ── Save: payload shape, passwords cleared from the page ──
await tap('保存设备');
await page.getByRole('dialog',{name:'添加设备'}).waitFor({state:'detached'});
const saved=(await calls('saveDevice')).at(-1);
assert.deepEqual(saved.jumps,[{host:'jump-a.example.test',port:2201,user:'ops',auth:'password',password:'jump-a-pw'},{host:'jump-b.example.test',port:22,user:'relay',auth:'key',password:''}]);
assert.equal(saved.host,'10.20.0.5');assert.equal(saved.password,'dev-pw');
assert.equal(await page.evaluate(()=>[...document.querySelectorAll('input')].some(n=>n.value==='jump-a-pw')),false,'no hop password left in the DOM');
const card=page.locator('.device-card',{hasText:'10.20.0.5'});
assert.equal((await card.locator('.hop-line').innerText()).trim(),'经 jump-a.example.test → jump-b.example.test');
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'card with route fits 320 px');await page.setViewportSize({width:390,height:844});
console.log('PASS: saveDevice gets ordered jumps {host,port,user,auth,password}; card shows the route');

// ── Edit: saved hop password kept without retyping; a changed hop needs it again ──
await card.getByRole('button',{name:/^编辑 /}).click();
await page.getByRole('dialog',{name:'编辑设备'}).waitFor();
assert.equal(await box(1).inputValue(),'jump-a.example.test');
assert.equal(await hopPass(1).getAttribute('placeholder'),'已保存；留空保留原密码');
assert.equal(await hopPass(1).inputValue(),'','saved hop password never shown');
await page.getByText('改了主机、端口、用户名或跳板机，要重新输入密码。',{exact:true}).waitFor();
await hopUser(1).fill('someone-else');
await tap('保存设备');
await page.getByText('改了地址、用户名或顺序，要重新输入密码',{exact:true}).waitFor();
await hopUser(1).fill('ops');
await tap('保存设备');
await page.getByRole('dialog',{name:'编辑设备'}).waitFor({state:'detached'});
assert.equal((await calls('saveDevice')).at(-1).jumps[0].password,'','kept password is not resent');
console.log('PASS: edit keeps saved hop passwords; changing a hop asks for its password again');

// ── Hop errors: named, 改跳板机, never the device password prompt ──
await page.evaluate(()=>fx.connect.push({ok:false,code:'auth',error:'第 1 跳（跳板机 jump-a.example.test）：密码不对，或者 ops 这个用户名不存在。',info:{hop:1,hops:3,jump:true,host:'jump-a.example.test',port:2201}}));
await card.getByRole('button',{name:'连接设备'}).click();
await page.getByText('跳板机：密码不对',{exact:true}).waitFor();
await page.waitForTimeout(300);
assert.equal(await page.getByRole('dialog').count(),0,'no device password prompt for a jump host');
assert.equal(await page.getByRole('button',{name:'重新输入密码'}).count(),0);
await tap('改跳板机');
await page.getByRole('dialog',{name:'编辑设备'}).waitFor();await box(1).waitFor();
await tap('取消');
await page.evaluate(()=>fx.connect.push({ok:false,code:'jump_forward',error:'跳板机 jump-b.example.test 连不到 10.20.0.5:22：……',info:{hop:3,hops:3,jump:false}}));
await page.locator('.device-card',{hasText:'10.20.0.5'}).getByRole('button',{name:'连接设备'}).click();
await page.getByText('跳板机转不过去',{exact:true}).waitFor();
await page.getByRole('button',{name:'改跳板机'}).waitFor();
console.log('PASS: hop failures are named, offer 改跳板机 and never the device password prompt');

// ── Host keys per hop: the jump host first, then the computer behind it ──
const FP1='SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU',FP2='SHA256:aaaaQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSbbb';
await page.evaluate(([a,b])=>{fx.connect.push({ok:false,code:'hostkey_new',error:'第一次连跳板机 jump-a.example.test，先核对一下 SSH 指纹。',info:{host:'jump-a.example.test',port:2201,fingerprint:a,type:'ssh-ed25519',hop:1,hops:3,jump:true}});
 fx.connect.push({ok:false,code:'hostkey_new',error:'第一次连这台电脑，先核对一下 SSH 指纹。',info:{host:'10.20.0.5',port:22,fingerprint:b,type:'ssh-ed25519',hop:3,hops:3,jump:false,via:'jump-b.example.test'}});},[FP1,FP2]);
await page.locator('.device-card',{hasText:'10.20.0.5'}).getByRole('button',{name:'连接设备'}).click();
await page.getByRole('dialog',{name:'核对跳板机指纹'}).waitFor();
await page.getByText('在跳板机上怎么看指纹',{exact:true}).waitFor();
await page.getByText('第一次连跳板机 jump-a.example.test:2201（第 1 跳）',{exact:false}).waitFor();
await page.getByText('跳板机给出的指纹',{exact:false}).waitFor();
// Behind the sheet: first trust of a hop is a calm info banner, not a red error.
assert.equal(await page.locator('.connection-status.info').filter({hasText:'跳板机：等你核对指纹'}).count(),1,'first trust of a jump host is info');
assert.equal(await page.locator('.connection-status.failed').count(),0);
await tap('信任并连接');
await page.getByRole('dialog',{name:'核对电脑指纹'}).waitFor();
await page.getByText('第一次连 10.20.0.5:22（经 jump-b.example.test）',{exact:false}).waitFor();
assert.deepEqual((await calls('trustHost')).map(c=>c.fingerprint),[FP1],'only the shown key trusted');
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'trust sheet fits 320 px');await page.setViewportSize({width:390,height:844});
await tap('信任并连接');
await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
assert.deepEqual((await calls('trustHost')).map(c=>c.fingerprint),[FP1,FP2]);
await page.evaluate(()=>fx.connect.push({ok:false,code:'hostkey_changed',error:'跳板机 jump-a.example.test 的 SSH 指纹和上次信任的不一样，已拒绝连接。',info:{host:'jump-a.example.test',port:2201,fingerprint:'SHA256:new',previous:'SHA256:old',type:'ssh-ed25519',hop:1,hops:3,jump:true}}));
await page.evaluate(()=>{const d=S.devices.find(x=>x.host==='10.20.0.5');return disconnect(false).then(()=>doConnect(d));});
await page.getByRole('dialog',{name:'跳板机指纹变了'}).waitFor();
assert.equal(await page.locator('.connection-status.failed').count(),1,'a changed jump host key stays red');
await page.locator('.connection-status.failed strong').getByText('跳板机指纹变了，已拒绝连接',{exact:true}).waitFor();
await page.getByText('跳板机 jump-a.example.test:2201（第 1 跳） 这次给出的指纹',{exact:false}).waitFor();
await tap('重新核对');await tap('忘掉并重新核对');
await page.waitForFunction(()=>fx.calls.some(c=>c.op==='forgetHost'));
await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));
console.log('PASS: each hop gets its own fingerprint sheet, trusted one at a time; a changed jump key is named and refused');

// ── Connected panel shows the route; removing every hop gives a plain device again ──
await page.waitForFunction(()=>typeof S!=='undefined'&&S.device&&S.device.jumps);
await page.evaluate(()=>setTab('devices'));
await page.locator('.account-card').getByText('jump-a.example.test → jump-b.example.test',{exact:true}).waitFor();
assert.equal(await page.locator('.device-card',{hasText:'10.20.0.5'}).count(),1,'the connected computer appears once (its card on top)');
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'connected card with a route fits 320 px');await page.setViewportSize({width:390,height:844});
await page.evaluate(()=>disconnect(false));
await page.evaluate(()=>setTab('devices'));
await page.locator('.device-card',{hasText:'10.20.0.5'}).getByRole('button',{name:/^编辑 /}).click();
await page.getByRole('dialog',{name:'编辑设备'}).waitFor();
await tap('删除跳板机 2');await page.waitForFunction(()=>document.querySelectorAll('.hop-card').length===1);
await tap('删除跳板机 1');await page.waitForFunction(()=>document.querySelectorAll('.hop-card').length===0);
assert.equal(await page.locator('.hop-route').isVisible(),false);
await tap('保存设备');
await page.getByRole('dialog',{name:'编辑设备'}).waitFor({state:'detached'});
assert.deepEqual((await calls('saveDevice')).at(-1).jumps,[]);
assert.equal(await page.locator('.device-card',{hasText:'10.20.0.5'}).locator('.hop-line').count(),0);
console.log('PASS: route in the connected panel; removing all hops saves jumps:[] and a plain card');

// ── Dark theme: the form with hops fits and uses tokens ──
await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
await page.locator('.device-card',{hasText:'10.20.0.5'}).getByRole('button',{name:/^编辑 /}).click();
await tap('添加跳板机');await box(1).waitFor();
const bg=await page.locator('.hop-card').evaluate(n=>getComputedStyle(n).backgroundColor);
assert.notEqual(bg,'rgb(255, 255, 255)','dark hop card is not white');
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'dark form fits 320 px');
await tap('取消');

// A key-login device: its first jump host defaults to the phone's key too; an untouched form closes on a backdrop tap.
await tap('添加设备');const form2=page.getByRole('dialog',{name:'添加设备'});await form2.waitFor();await page.waitForTimeout(200);
await form2.getByRole('radiogroup',{name:'登录方式',exact:true}).getByRole('radio',{name:'密钥'}).click();
await tap('添加跳板机');await box(1).waitFor();
assert.equal(await page.getByRole('radiogroup',{name:'跳板机 1 登录方式'}).getByRole('radio',{name:'密钥'}).getAttribute('aria-checked'),'true','hop follows the device login choice');
await tap('删除跳板机 1');await page.waitForFunction(()=>!document.querySelector('.hop-card'));
await form2.getByRole('radiogroup',{name:'登录方式',exact:true}).getByRole('radio',{name:'密码'}).click();
await page.mouse.click(160,20);
await form2.waitFor({state:'detached'});
console.log('PASS: hop login follows the device; an untouched form still closes on a backdrop tap');

assert.deepEqual(errors,[]);
console.log('PASS: dark theme hop card, no page errors');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
