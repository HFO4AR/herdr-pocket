// 帮助与反馈: help opens from 设置 and from an error banner, the table of contents jumps inside
// the sheet, and the diagnostic summary never carries names, hosts, users, paths, message text,
// keys or fingerprints. Native is an offline fixture with recognizable private values.
const {chromium}=require('playwright');
const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2,
 userAgent:'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36'});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
// Values that must never show up in the diagnostic summary.
const SECRET=['小林的工作站','secret-host.example.net','yukitest','secret-box','/home/yukitest','secretproj','SHA256:Zm9vYmFyc2VjcmV0','把密钥文件删掉再说','ssh-ed25519','10.9.8.7'];
await page.addInitScript(()=>{
 window.fx={calls:[],connect:[]};
 const device={id:'d1',name:'小林的工作站',host:'secret-host.example.net',port:2222,user:'yukitest',remember:true,auth:'password'};
 const agents=[
  {pane_id:'w1:p1',identity:'id1',agent:'claude',agent_status:'working',title:'把密钥文件删掉再说',cwd:'/home/yukitest/projects/secretproj',history_ref:{status:'matched',record:{id:'r1',title:'把密钥文件删掉再说',provider:'claude',thread:'t1'}}},
  {pane_id:'w1:p2',identity:'id2',agent:'codex',agent_status:'blocked',title:'secret-box 上的任务',cwd:'/home/yukitest/secretproj',history_ref:{status:'unavailable'}},
  {pane_id:'w1:p3',identity:'id3',agent:'claude',agent_status:'idle',terminal_title:'secretproj: ch',cwd:'/home/yukitest',history_ref:{status:'matched',remote:{route:'x'},record:{id:'r3',title:'远端',provider:'claude',thread:'t3',remote:{route:'x'}}}}];
 const reply=(id,r)=>setTimeout(()=>nativeResult(id,r),0);
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);fx.calls.push({op,a});
  if(op==='devices')return reply(id,{ok:true,data:{devices:[device],version:'0.6.0'}});
  if(op==='settings')return reply(id,{ok:true,data:{theme:'system',dark:false,textZoom:100,secureScreen:false,autoUpdate:false,alerts:true,notifications:true,version:'0.6.0',versionCode:140,update:null}});
  if(op==='connect'){const r=fx.connect.shift()||{ok:true,data:{device,devices:[device],ready:true,host:{herdr:true,running:1}}};return reply(id,r);}
  if(op==='cacheInfo')return reply(id,{ok:true,data:{bytes:0,entries:0}});
  if(op==='remote'){
   if(a.op==='hello')return reply(id,{ok:true,data:{version:'0.5.0',protocol:1,python:'3.12'}});
   if(a.op==='doctor')return reply(id,{ok:true,data:{python:'3.12.3',herdr:true,running:2}});
   if(a.op==='sessions')return reply(id,{ok:true,data:{sessions:[{name:'main',running:true}]}});
   if(a.op==='agents'||a.op==='status')return reply(id,{ok:true,data:{agents}});
   if(a.op==='account')return reply(id,{ok:true,data:{ssh_user:'yukitest',hostname:'secret-box'}});
   if(a.op==='catalog')return reply(id,{ok:false,error:'读取 /home/yukitest/.claude 失败 secret-box',code:'remote_error'});
   if(a.op==='hidden')return reply(id,{ok:true,data:{ids:[]}});
   if(a.op==='glance')return reply(id,{ok:true,data:{items:{}}});
   throw Error('Forbidden remote op in help test: '+a.op);}
  if(op==='openUrl')return reply(id,{ok:true,data:{}});
  if(['protect','disconnect','cacheGet','cachePut','watchState'].includes(op))return reply(id,{ok:true,data:op==='cacheGet'?{value:null}:{}});
  throw Error('Unexpected native op '+op);}};
 // Clipboard: keep what was copied so the test can read it back.
 window.copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async t=>{copied.push(t);}}});
});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||[...document.querySelectorAll('.sheet,.main')].some(n=>n.scrollWidth>n.clientWidth+1));
const dialog=name=>page.getByRole('dialog',{name});

// ── A failed connect: the banner offers 「怎么回事」, which opens help at the right answer ──
await page.evaluate(()=>fx.connect.push({ok:false,error:'连不上 secret-host.example.net:2222（10.9.8.7）',code:'timeout'}));
await page.getByRole('button',{name:'连接设备',exact:true}).click();
await page.getByText('连不上，超时了',{exact:true}).waitFor();
await page.getByRole('button',{name:'怎么回事',exact:true}).click();
await dialog('帮助').waitFor();
await page.waitForFunction(()=>document.getElementById('help-faq-connect')?.open===true);
await page.waitForTimeout(500);
{const d=await page.evaluate(()=>{const s=document.querySelector('.help-sheet'),n=document.getElementById('help-faq-connect');return [n.getBoundingClientRect().top-s.getBoundingClientRect().top,s.scrollTop,s.scrollHeight,s.clientHeight];});assert(d[0]>=-2&&d[0]<120,'banner link lands on 连不上: '+d);}
await page.getByText('「端口没开」：电脑上 SSH 服务没启动，或端口填错了。',{exact:true}).waitFor();
await page.getByRole('button',{name:'关闭',exact:true}).click();
console.log('PASS: error banner 「怎么回事」 opens help at the matching answer');

// ── Connect for real, then 设置 → 帮助与反馈 ──
await page.getByRole('button',{name:'重试',exact:true}).click();
await page.getByRole('heading',{name:'会话',exact:true}).waitFor();
await page.getByRole('button',{name:'历史',exact:true}).click();
await page.waitForFunction(()=>fx.calls.some(c=>c.a?.op==='catalog'));
await page.getByRole('button',{name:'设置',exact:true}).click();
await page.getByText('帮助与反馈',{exact:true}).waitFor();
await page.getByRole('button',{name:'使用帮助'}).click();
await dialog('帮助').waitFor();
const toc=page.getByRole('navigation',{name:'目录'});
for(const t of ['开始使用','和 Agent 对话','远程会话（ch）','新建和关闭会话','后台提醒','密钥登录','更新','隐私与安全','常见问题','反馈问题'])await toc.getByRole('button',{name:t,exact:true}).waitFor();
await page.getByRole('heading',{name:'安装桥接程序',exact:true}).waitFor();
// TOC jump: the 隐私与安全 heading comes to the top of the sheet, the sheet (not the page) scrolls.
const before=await page.evaluate(()=>document.querySelector('.help-sheet').scrollTop),pageBefore=await page.evaluate(()=>document.scrollingElement.scrollTop);
await toc.getByRole('button',{name:'隐私与安全',exact:true}).click();
await page.waitForTimeout(800);
const pos=await page.evaluate(()=>{const s=document.querySelector('.help-sheet'),h=document.getElementById('help-privacy');const head=s.querySelector('.sheet-head');return {top:s.scrollTop,delta:h.getBoundingClientRect().top-head.getBoundingClientRect().bottom,page:document.scrollingElement.scrollTop};});
assert(pos.top>before+300,'sheet scrolled');assert(pos.delta>=0&&pos.delta<40,'section right below the sticky head: '+pos.delta);assert.equal(pos.page,pageBefore,'the page behind stays put');
await toc.getByRole('button',{name:'常见问题',exact:true}).click().catch(async()=>{await page.evaluate(()=>document.querySelector('.help-sheet').scrollTo(0,0));await toc.getByRole('button',{name:'常见问题',exact:true}).click();});
await page.waitForTimeout(800);
const faq=page.locator('#help-faq-oem');assert.equal(await faq.evaluate(n=>n.open),false,'FAQ starts folded');
await faq.locator('summary').click();await page.getByText('在最近任务里把 App 锁住。',{exact:true}).waitFor();
assert.equal(await page.evaluate(()=>document.querySelector('.help-sheet').innerHTML.includes('<script')),false);
console.log('PASS: help opens from 设置, TOC jumps inside the sheet, FAQ folds');

// ── 320 px and dark ──
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'help fits 320 px');
await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
const bg=await page.evaluate(()=>getComputedStyle(document.querySelector('.help-faq')).backgroundColor);
assert.notEqual(bg,'rgb(255, 255, 255)','FAQ cards follow the dark theme');
await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
await page.setViewportSize({width:390,height:844});
console.log('PASS: help fits 320 px and follows the dark theme');

// ── 反馈问题: diagnostics without private data ──
await page.evaluate(()=>document.querySelector('.help-sheet').scrollTo(0,0));
await toc.getByRole('button',{name:'反馈问题',exact:true}).click();await page.waitForTimeout(600);
await page.getByRole('button',{name:'生成诊断信息'}).click();
await dialog('反馈问题').waitFor();
await page.waitForFunction(()=>!/正在收集/.test(document.querySelector('.help-diag').textContent));
const diag=await page.locator('.help-diag').textContent();
for(const s of SECRET)assert(!diag.includes(s),'diagnostics leak '+s+':\n'+diag);
for(const s of ['App：0.6.0 (140)','Android：14','桥接程序：0.5.0 · 协议 1 · Python 3.12','Herdr：已安装 · 运行中的会话 2','在线 Agent：3（Codex 1，Claude 2，ch 远端 1；执行中 1，等确认 1）','历史未关联：1','connect:timeout','catalog:remote_error','保存的设备 1'])
 assert(diag.includes(s),'diagnostics miss '+s+':\n'+diag);
await page.getByRole('button',{name:'复制并打开 GitHub'}).click();
await page.waitForFunction(()=>fx.calls.some(c=>c.op==='openUrl'));
assert.deepEqual(await page.evaluate(()=>fx.calls.filter(c=>c.op==='openUrl').map(c=>c.a.url)),['https://github.com/HFO4AR/herdr-pocket/issues/new']);
assert.equal(await page.evaluate(()=>copied.at(-1)),diag,'what is copied is exactly what was shown');
// Nothing beyond the read-only hello/doctor was asked of the computer for the summary.
const remoteOps=await page.evaluate(()=>[...new Set(fx.calls.filter(c=>c.op==='remote').map(c=>c.a.op))]);
assert(remoteOps.every(o=>['hello','doctor','sessions','agents','status','account','catalog','glance','hidden'].includes(o)),remoteOps.join());
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'feedback fits 320 px');
console.log('PASS: diagnostics hold versions, states, counts and error codes only; copy + issue page');

assert.deepEqual(errors,[]);
await browser.close();console.log('help UI checks passed');
})().catch(e=>{console.error(e);process.exit(1);});
