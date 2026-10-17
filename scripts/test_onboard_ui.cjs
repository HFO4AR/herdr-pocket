// First run and connection lifecycle: guide, inline form validation, host-key trust (never
// automatic), changed keys, bridge install/update, friendly errors and the reconnect pill.
// Native is a scripted offline fixture; nothing reaches a real host.
const {chromium}=require('playwright');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 // fx.connect / fx.install / fx.reconnect: queues of {ok,data|error,code,info}; fx.calls logs every op.
 window.fx={calls:[],connect:[],install:[],reconnect:[],doctor:[]};let devices=[];
 const reply=(id,r)=>setTimeout(()=>nativeResult(id,r),0);
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);fx.calls.push({op,a});
  const queued=q=>q.length?q.shift():{ok:true,data:{}};
  if(op==='devices')return reply(id,{ok:true,data:{devices,version:'0.6.0'}});
  if(op==='saveDevice'){if(!a.host||!a.user||!(a.port>=1&&a.port<=65535))return reply(id,{ok:false,error:'填写主机、用户名和有效端口'});
   const d={id:a.id||'d1',name:a.name||a.host,host:a.host,port:a.port,user:a.user,remember:!!(a.remember&&a.password)};devices=[d];return reply(id,{ok:true,data:{devices,id:d.id}});}
  if(op==='connect'){const r=queued(fx.connect);if(r.ok&&!r.data.device)r.data={device:devices[0],devices,ready:true,...r.data};return reply(id,r);}
  if(op==='install')return reply(id,queued(fx.install));
  if(op==='reconnect')return reply(id,queued(fx.reconnect));
  if(op==='remote'){if(a.op==='doctor')return reply(id,queued(fx.doctor));if(a.op==='sessions')return reply(id,{ok:true,data:fx.noHerdr?{sessions:[],herdr:false,tmux:true}:{sessions:[]}});if(a.op==='tmux')return reply(id,{ok:true,data:{available:true,panes:[]}});if(a.op==='account')return reply(id,{ok:true,data:{ssh_user:'yuki',hostname:'box'}});
   throw Error('Forbidden remote op in onboarding test: '+a.op);}
  if(['protect','settings','disconnect','trustHost','forgetHost','cacheGet','cachePut','demo'].includes(op))return reply(id,{ok:true,data:op==='cacheGet'?{value:null}:{}});
  throw Error('Unexpected native op '+op);}};
});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
const calls=op=>page.evaluate(o=>fx.calls.filter(c=>c.op===o).map(c=>c.a),op);
const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||[...document.querySelectorAll('.sheet,.main')].some(n=>n.scrollWidth>n.clientWidth+1));

// ── First run guide ──
await page.getByRole('heading',{name:'连上你的电脑'}).waitFor();
await page.getByText('装好 Herdr 和 Python 3.9+',{exact:true}).waitFor();
assert.equal(await page.getByText('不在一起：Tailscale',{exact:true}).isVisible(),false,'address tips start folded');
await page.getByText('怎么填地址',{exact:true}).click();
await page.getByText('不在一起：Tailscale',{exact:true}).waitFor();
assert(await page.getByRole('button',{name:'体验聊天演示',exact:true}).isVisible());
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'guide fits 320 px');
await page.setViewportSize({width:390,height:844});
console.log('PASS: first-run guide with folded address tips, fits 320 px');

// ── Device form: inline validation, keyboard hints, paste splitting, password toggle ──
await page.getByRole('button',{name:'添加第一台设备'}).click();
await page.getByRole('dialog',{name:'添加设备'}).waitFor();await page.waitForTimeout(300);
const host=page.getByRole('textbox',{name:'主机地址',exact:true}),port=page.getByRole('textbox',{name:'端口',exact:true}),user=page.getByRole('textbox',{name:'SSH 用户名',exact:true});
assert.equal(await port.inputValue(),'22');
assert.equal(await port.getAttribute('inputmode'),'numeric');
assert.equal(await host.getAttribute('inputmode'),'url');
assert.equal(await host.getAttribute('autocapitalize'),'none');
await port.fill('0');
await page.getByRole('button',{name:'保存并连接',exact:true}).click();
await page.getByText('填电脑的地址：域名或 IP',{exact:true}).waitFor();
await page.getByText('1–65535',{exact:true}).waitFor();
await page.getByText('填登录电脑用的用户名',{exact:true}).waitFor();
assert.equal(await host.getAttribute('aria-invalid'),'true');
assert(await host.evaluate(n=>document.activeElement===n),'first invalid field is focused');
assert.equal((await calls('saveDevice')).length,0,'invalid form never reaches native');
await host.fill('x');assert.equal(await host.getAttribute('aria-invalid'),null,'typing clears the error');
await host.fill('ssh://yuki@box.lan:2222');await host.dispatchEvent('change');
assert.equal(await host.inputValue(),'box.lan');assert.equal(await port.inputValue(),'2222');assert.equal(await user.inputValue(),'yuki');
// Fields the paste filled in lose their old errors.
assert.equal(await port.getAttribute('aria-invalid'),null);assert.equal(await user.getAttribute('aria-invalid'),null);
assert.equal(await page.getByText('填登录电脑用的用户名',{exact:true}).count(),0);
const pass=page.getByLabel('登录密码',{exact:true});
await pass.fill('pw-1');assert.equal(await pass.getAttribute('type'),'password');
await page.getByRole('button',{name:'显示密码'}).click();assert.equal(await pass.getAttribute('type'),'text');
await page.getByRole('button',{name:'隐藏密码'}).click();assert.equal(await pass.getAttribute('type'),'password');
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'form fits 320 px');await page.setViewportSize({width:390,height:844});
console.log('PASS: inline validation, numeric/url keyboards, user@host:port split, show/hide password');

// ── Save and connect → first-use host key: nothing trusted until an explicit tap ──
const FP='SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU';
await page.evaluate(fp=>{fx.connect.push({ok:false,code:'hostkey_new',error:'第一次连这台电脑，先核对一下 SSH 指纹。',info:{host:'box.lan',port:2222,fingerprint:fp,type:'ssh-ed25519'}});},FP);
await page.getByRole('button',{name:'保存并连接',exact:true}).click();
await page.getByRole('dialog',{name:'核对电脑指纹'}).waitFor();
const firstConnect=(await calls('connect'))[0];assert.equal(firstConnect.password,'pw-1');assert.equal(firstConnect.remember,true);
await page.getByText(FP,{exact:true}).waitFor();
await page.getByText('在电脑上怎么看指纹',{exact:true}).click();
await page.getByText('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub',{exact:true}).waitFor();
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'trust sheet fits 320 px');await page.setViewportSize({width:390,height:844});
await page.getByRole('button',{name:'取消',exact:true}).click();
await page.getByText('已取消，没有信任这台电脑',{exact:true}).waitFor();
assert.equal((await calls('trustHost')).length,0,'cancel never pins');
assert.equal(await page.evaluate(()=>S.connectFail),null,'cancel forgets the typed password');
// Second try: trust it explicitly, then the bridge needs an update.
await page.evaluate(fp=>{fx.connect.push({ok:false,code:'hostkey_new',error:'第一次连这台电脑，先核对一下 SSH 指纹。',info:{host:'box.lan',port:2222,fingerprint:fp,type:'ssh-ed25519'}},{ok:true,data:{ready:false,upgrade:true}});},FP);
await page.evaluate(()=>connectDevice(S.devices[0]));
await page.getByRole('dialog',{name:'核对电脑指纹'}).waitFor();
// The banner keeps a way back to the sheet if it is dismissed.
await page.getByRole('button',{name:'关闭'}).click();
await page.getByText('等你核对指纹',{exact:true}).waitFor();
// First trust is a normal step: a calm info banner (role status), not the red error one.
assert.equal(await page.locator('.connection-status.info[role="status"]').count(),1,'first trust uses the info banner');
assert.equal(await page.locator('.connection-status.failed').count(),0,'first trust is not shown as an error');
assert(await page.locator('.connection-status.info').getByRole('button',{name:'核对指纹',exact:true}).evaluate(b=>b.classList.contains('primary')));
assert.equal(await page.locator('.device-card .primary').count(),0,'the banner holds the one filled button');
await page.getByRole('button',{name:'核对指纹',exact:true}).click();
await page.getByRole('button',{name:'信任并连接',exact:true}).click();
await page.getByRole('dialog',{name:'更新桥接程序'}).waitFor();
assert.deepEqual((await calls('trustHost')).map(a=>a.fingerprint),[FP],'pins exactly the shown fingerprint, once');
const connects=await calls('connect');assert.equal(connects.length,3);assert.equal(connects[2].password,connects[1].password,'retry after trusting reuses the same credentials');
console.log('PASS: host key shown with how-to-check, cancel pins nothing, explicit trust pins exactly that key');

// ── Bridge update → no Herdr: tmux only, no banner → Herdr installed, refresh brings it back ──
// (Changed in 0.6: a computer without Herdr is used for its tmux sessions; see test_tmuxonly_ui.cjs.)
await page.evaluate(()=>{fx.noHerdr=true;fx.install.push({ok:true,data:{protocol:1,host:{herdr:false,running:null,tmux:true}}});});
await page.getByRole('button',{name:'更新并进入',exact:true}).click();
await page.getByText('这台电脑没装 Herdr，只显示 tmux',{exact:true}).waitFor();
assert.equal(await page.evaluate(()=>S.tab),'live');
assert.equal(await page.locator('.connection-status').count(),0,'no banner for a missing Herdr');
assert.equal(await page.getByRole('button',{name:'历史',exact:true}).count(),0);
await page.evaluate(()=>{fx.noHerdr=false;});
await page.getByRole('button',{name:'刷新会话',exact:true}).click();
await page.getByText('暂时没有会话',{exact:true}).waitFor();
assert.equal(await page.getByRole('button',{name:'历史',exact:true}).count(),1);
// A Herdr that is installed but not running still gets its calm banner and recheck.
await page.evaluate(()=>{fx.doctor.push({ok:true,data:{herdr:true,running:0}});fx.doctor.push({ok:true,data:{herdr:true,running:1}});recheckHost();});
await page.locator('.connection-status strong').filter({hasText:'Herdr 没在运行'}).waitFor();
await page.getByRole('button',{name:'重新检查',exact:true}).click();
await page.getByText('Herdr 正常',{exact:true}).waitFor();
assert.equal(await page.locator('.connection-status').count(),0);
console.log('PASS: bridge update sheet, no Herdr = tmux only without a banner, recheck clears a stopped Herdr');

// ── Reconnect pill ──
await page.evaluate(()=>nativeEvent({type:'reconnecting',detail:'box'}));
await page.getByText('连接断了，正在重连…',{exact:true}).waitFor();
await page.evaluate(()=>nativeEvent({type:'reconnect_failed',detail:'连 box.lan:2222 超时了。'}));
await page.getByText('连不上电脑',{exact:true}).waitFor();
await page.evaluate(()=>render());assert(await page.getByText('连不上电脑',{exact:true}).isVisible(),'pill survives re-render');
await page.evaluate(()=>{fx.reconnect.push({ok:true,data:{}});});
await page.locator('#net-banner').getByRole('button',{name:'重试'}).click();
await page.getByText('已重新连上',{exact:true}).waitFor();
await page.waitForTimeout(2600);assert.equal(await page.locator('#net-banner').count(),0,'success pill fades away');
// Coming back from the background retries a failed reconnect once.
await page.evaluate(()=>{nativeEvent({type:'reconnect_failed',detail:'x'});fx.reconnect.push({ok:true,data:{}});window.setForeground(true);});
await page.getByText('已重新连上',{exact:true}).waitFor();
assert.equal((await calls('reconnect')).length,2);
await page.evaluate(()=>nativeEvent({type:'hostkey_changed',detail:'电脑的 SSH 指纹变了'}));
await page.getByRole('button',{name:'去设备页',exact:true}).waitFor();
await page.getByRole('button',{name:'去设备页',exact:true}).click();
await page.getByRole('heading',{name:'设备',exact:true}).waitFor();
assert.equal(await page.evaluate(()=>S.device),null);
console.log('PASS: reconnect pill: reconnecting, failed + retry, auto-hide, foreground retry, host-key stop');

// ── Changed key: refused, explained, forgetting needs a second confirmation ──
const OLD='SHA256:oldOLDoldOLDoldOLDoldOLDoldOLDoldOLDoldOL1';
await page.evaluate(([fp,old])=>{fx.connect.push({ok:false,code:'hostkey_changed',error:'电脑的 SSH 指纹和上次信任的不一样，已拒绝连接。',info:{host:'box.lan',port:2222,fingerprint:fp,previous:old,type:'ssh-ed25519'}},
 {ok:false,code:'hostkey_new',error:'第一次连这台电脑，先核对一下 SSH 指纹。',info:{host:'box.lan',port:2222,fingerprint:fp,type:'ssh-ed25519'}});connectDevice(S.devices[0]);},[FP,OLD]);
await page.getByRole('dialog',{name:'电脑指纹变了'}).waitFor();
assert.equal(await page.locator('.connection-status.failed[role="alert"]').count(),1,'a changed key stays red');
assert.equal(await page.locator('.connection-status.info').count(),0);
await page.getByText(OLD,{exact:true}).waitFor();await page.getByText(FP,{exact:true}).waitFor();
assert.equal((await calls('forgetHost')).length,0);
await page.getByRole('button',{name:'重新核对',exact:true}).click();
await page.getByRole('button',{name:'忘掉并重新核对',exact:true}).click();
await page.getByRole('dialog',{name:'核对电脑指纹'}).waitFor();
assert.equal((await calls('forgetHost')).length,1);
assert.equal((await calls('trustHost')).length,1,'forgetting does not trust the new key');
await page.getByRole('button',{name:'取消',exact:true}).click();
console.log('PASS: changed key shows old/new fingerprints; forget needs confirmation and leads back to explicit trust');

// ── Friendly failures ──
const fail=async(code,error)=>{await page.evaluate(([code,error])=>{fx.connect.push({ok:false,code,error});connectDevice(S.devices[0]);},[code,error]);};
await fail('timeout','连 box.lan:2222 超时了。这是局域网名字，手机要连在同一个 Wi-Fi 上。');
await page.getByText('连不上，超时了',{exact:true}).waitFor();
assert(await page.getByRole('button',{name:'改设置',exact:true}).isVisible());
const before=(await calls('connect')).length;
await page.evaluate(()=>{fx.connect.push({ok:false,code:'refused',error:'box.lan:2222 拒绝连接。电脑上的 SSH 服务开着吗？端口对不对？'});});
await page.getByRole('button',{name:'重试',exact:true}).click();
await page.getByText('端口没开',{exact:true}).waitFor();
assert.equal((await calls('connect')).length,before+1,'retry connects again');
await page.getByRole('button',{name:'改设置',exact:true}).click();
await page.getByRole('dialog',{name:'编辑设备'}).waitFor();
await page.getByRole('button',{name:'关闭'}).click();
await fail('auth','密码不对，或者 yuki 这个用户名不存在。');
await page.getByText('密码不对，再试一次',{exact:true}).waitFor();
await page.getByRole('button',{name:'取消',exact:true}).click();
await page.getByRole('button',{name:'重新输入密码',exact:true}).waitFor();
await fail('python_missing','电脑上没找到 python3。先装 Python 3.9 或更新的版本，再点重试。');
await page.getByText('电脑上还差 Python',{exact:true}).waitFor();
assert(await page.getByRole('button',{name:'重试',exact:true}).isVisible());
await page.getByRole('button',{name:'知道了'}).click();
assert.equal(await page.locator('.connection-status').count(),0,'banner can be dismissed');
console.log('PASS: timeout / auth / python errors get a title and the right next step');

// ── Screens for review (light + dark) ──
const out=process.env.ONBOARD_SHOTS;
if(out){fs.mkdirSync(out,{recursive:true});
 for(const theme of ['light','dark']){await page.evaluate(t=>{document.documentElement.dataset.theme=t;},theme);
  await fail('tunnel','连上了 box.lan:2222，但那头没有 SSH 回应。用 frp 的话，多半是电脑上的 SSH 没开，或者 frpc 转发的本地端口不对。');
  await page.getByText('转发通了，电脑没回应',{exact:true}).waitFor();await page.screenshot({path:out+'/'+theme+'-error.png'});
  await page.evaluate(fp=>{S.connectError='第一次连这台电脑，先核对一下 SSH 指纹。';S.connectFail={device:S.devices[0].id,d:S.devices[0],code:'hostkey_new',info:{host:'box.lan',port:2222,fingerprint:fp,type:'ssh-ed25519'}};render();},FP);await page.waitForTimeout(350);await page.screenshot({path:out+'/'+theme+'-firsttrust.png'});
  await page.evaluate(fp=>{trustSheet({d:S.devices[0],info:{host:'box.lan',port:2222,fingerprint:fp,type:'ssh-ed25519'}});},FP);await page.waitForTimeout(350);await page.screenshot({path:out+'/'+theme+'-trust.png'});
  await page.evaluate(()=>{closeSheet();deviceForm();});await page.getByRole('button',{name:'保存并连接'}).click();await page.waitForTimeout(350);await page.screenshot({path:out+'/'+theme+'-form.png'});
  await page.evaluate(()=>{closeSheet();S.connectError='';S.device=S.devices[0];S.hostIssue={title:'Herdr 没在运行',text:'在电脑上打开 Herdr（至少开一个会话），再点「重新检查」。'};setTab('devices');nativeEvent({type:'reconnect_failed',detail:'x'});});await page.waitForTimeout(350);await page.screenshot({path:out+'/'+theme+'-banners.png'});
  await page.evaluate(()=>{netBanner(null);S.device=null;S.hostIssue=null;S.devices=[];render();});await page.getByText('怎么填地址').click();await page.waitForTimeout(300);await page.screenshot({path:out+'/'+theme+'-guide.png'});
  await page.evaluate(()=>{S.devices=[{id:'d1',name:'box.lan',host:'box.lan',port:2222,user:'yuki',remember:true}];setupBridge({});});await page.waitForTimeout(350);await page.screenshot({path:out+'/'+theme+'-install.png'});await page.evaluate(()=>closeSheet());}
 console.log('shots in',out);}

assert.deepEqual(errors,[]);
await browser.close();
console.log('PASS: onboarding UI');
})().catch(e=>{console.error(e);process.exit(1);});
