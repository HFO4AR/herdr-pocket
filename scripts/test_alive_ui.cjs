// 设置 → 连接 → 后台保持连接: on by default, duration choices, notes; 断开 from the notification;
// connection counts in the 反馈问题 diagnostics. Offline: the native side is a strict fixture.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 window.nx={calls:[],prefs:{theme:'system',dark:false,textZoom:100,secureScreen:false,autoUpdate:false,seenUpdate:'',alerts:true,notifications:true,
  keepAlive:true,keepAliveMinutes:60,version:'0.6.0',versionCode:140,update:null,
  conn:{logins:3,connects:1,reconnects:1,quietSwaps:0,keyProbes:1,reused:4,verified:2,verifyFailed:1,kept:6,slept:1,notificationDisconnects:0}}};
 const reply=(id,data,err)=>setTimeout(()=>nativeResult(id,err?{ok:false,error:err}:{ok:true,data}),0);
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);nx.calls.push({op,a});
  if(op==='devices')return reply(id,{devices:[],version:nx.prefs.version,alerts:true});
  if(op==='settings')return reply(id,nx.prefs);
  if(op==='setSetting'){if(a.key==='keepAliveMinutes'&&![15,60,240,0].includes(a.value))return reply(id,null,'不支持的时长');nx.prefs={...nx.prefs,[a.key]:a.value};return reply(id,nx.prefs);}
  if(op==='cacheInfo')return reply(id,{bytes:0,entries:0});
  if(['openUrl','disconnect','protect'].includes(op))return reply(id,{});
  throw Error('Forbidden native call in offline UI test: '+op);}};});
await page.goto(require('./ui_bundle.cjs').url(html));
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const setCalls=()=>page.evaluate(()=>nx.calls.filter(c=>c.op==='setSetting').map(c=>[c.a.key,c.a.value]));

await page.getByRole('button',{name:'设置',exact:true}).click();
await page.getByRole('heading',{name:'设置',exact:true}).waitFor();
const keep=page.getByRole('checkbox',{name:'后台保持连接',exact:true});
assert.equal(await keep.isChecked(),true,'on by default');
const group=page.getByRole('radiogroup',{name:'保持多久'});
for(const t of ['15 分钟','1 小时','4 小时','一直保持'])await group.getByRole('radio',{name:t,exact:true}).waitFor();
assert.equal(await group.getByRole('radio',{name:'1 小时',exact:true}).getAttribute('aria-checked'),'true','1 hour by default');
await page.getByText('到时间自动断开省电',{exact:false}).waitFor();
await page.getByText('通知栏有一条安静的常驻通知',{exact:false}).waitFor();
// The 连接 group comes before 提醒与隐私.
const labels=await page.locator('.section-label').allTextContents();
assert(labels.indexOf('连接')>=0&&labels.indexOf('连接')<labels.indexOf('提醒与隐私'),labels.join());
await page.locator('.set-card').filter({hasText:'后台保持连接'}).screenshot({path:path.join(folder,'alive-light.png')});
console.log('PASS: 后台保持连接 is on by default with 1 小时 selected and explained');

await group.getByRole('radio',{name:'4 小时',exact:true}).click();
await page.getByText('后台保持 4 小时，到时自动断开',{exact:true}).waitFor();
await page.getByRole('radiogroup',{name:'保持多久'}).getByRole('radio',{name:'一直保持',exact:true}).click();
await page.getByText('一直保持会多耗一点电',{exact:false}).waitFor();
assert.equal(await page.getByRole('radiogroup',{name:'保持多久'}).getByRole('radio',{name:'一直保持',exact:true}).getAttribute('aria-checked'),'true');
assert.deepEqual((await setCalls()).slice(-2),[['keepAliveMinutes',240],['keepAliveMinutes',0]]);
console.log('PASS: duration choices are saved natively (4 小时, 一直保持)');

// Notifications blocked: keeping still works, the note says so.
await page.evaluate(()=>{nx.prefs.notifications=false;});
await page.evaluate(()=>settingsLoad().then(()=>paintSettings()));
await page.getByText('系统通知关着也照样保持',{exact:false}).waitFor();

// Dark theme and the narrowest phone: no horizontal overflow, segment fits.
await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
await page.setViewportSize({width:320,height:640});
await page.waitForTimeout(150);
const over=await page.evaluate(()=>{const g=document.querySelector('[aria-label="保持多久"]');const r=g.getBoundingClientRect();return {doc:document.documentElement.scrollWidth,right:r.right,width:innerWidth,min:Math.min(...[...g.querySelectorAll('.seg-opt')].map(b=>b.getBoundingClientRect().height))};});
assert(over.doc<=over.width&&over.right<=over.width,'overflow at 320px '+JSON.stringify(over));
assert(over.min>=36,'segment too small '+JSON.stringify(over));
await page.locator('.set-card').filter({hasText:'后台保持连接'}).screenshot({path:path.join(folder,'alive-dark-320.png')});
await page.setViewportSize({width:390,height:844});
await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
console.log('PASS: fits 320 px in dark theme; note when system notifications are off');

// Off: the duration row goes away; the choice is remembered natively.
await page.locator('label.switch-row').filter({hasText:'后台保持连接'}).click();
await page.waitForFunction(()=>nx.prefs.keepAlive===false);
await page.getByText('切到后台后不再保持连接',{exact:true}).waitFor();
assert.equal(await page.getByRole('radiogroup',{name:'保持多久'}).count(),0);
await page.locator('label.switch-row').filter({hasText:'后台保持连接'}).click();
await page.waitForFunction(()=>nx.prefs.keepAlive===true);
await page.getByRole('radiogroup',{name:'保持多久'}).waitFor();
assert.deepEqual((await setCalls()).slice(-2),[['keepAlive',false],['keepAlive',true]]);
console.log('PASS: switching off hides the duration; back on restores it');

// Diagnostics: counts only.
await page.getByRole('button',{name:'反馈问题'}).click();
await page.waitForFunction(()=>{const d=document.querySelector('.help-diag');return d&&!/正在收集/.test(d.textContent);});
const diag=await page.locator('.help-diag').textContent();
assert(diag.includes('SSH 登录：3 次（手动连接 1，断线重连 1，静默换新 0，密钥测试 1）'),diag);
assert(diag.includes('回到前台：4 次直接复用，2 次检查后复用，1 次检查失败；后台保持 6 次，到时断开 1 次，通知里断开 0 次'),diag);
assert(diag.includes('后台保持连接 一直'),diag);
await page.keyboard.press('Escape');
console.log('PASS: diagnostics show SSH login and reuse counts');

// 断开 on the notification: the page drops the device and shows the devices page.
await page.evaluate(()=>{closeSheet();S.device={id:'d1',name:'工作站',auth:'password'};});
await page.evaluate(()=>nativeEvent({type:'disconnected',detail:''}));
await page.getByText('已断开和电脑的连接',{exact:true}).waitFor();
assert.equal(await page.evaluate(()=>S.device),null);
assert.equal(await page.evaluate(()=>S.tab),'devices');
assert(await page.evaluate(()=>nx.calls.some(c=>c.op==='disconnect')));
console.log('PASS: 断开 from the notification returns to the devices page');

assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
