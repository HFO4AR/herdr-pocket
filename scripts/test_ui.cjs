// Bundled UI tests; native SSH is replaced with a strict offline device-store fixture.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..'), ui=path.join(root,'app/src/main/assets/ui');
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.exposeFunction('testLog',console.log);
await page.addInitScript(()=>{let devices=[];window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};if(op==='devices')data={devices};else if(op==='saveDevice'){if(!a.host||!a.user||a.port<1||a.port>65535){setTimeout(()=>nativeResult(id,{ok:false,error:'填写主机、用户名和有效端口'}),0);return;}const deviceId=a.id||'fixture';devices=[{...a,id:deviceId,remember:!!a.remember}];delete devices[0].password;data={devices,id:deviceId};}else if(op==='deleteDevice'){devices=[];data={devices};}else if(op==='connect'){window.fixtureConnect=a;devices=devices.map(d=>({...d,remember:!!a.remember}));data={device:devices[0],devices,ready:false};}else if(!['demo','disconnect','protect'].includes(op)){throw Error('Forbidden network call in offline UI test: '+op);}setTimeout(()=>nativeResult(id,{ok:true,data}),0);}};});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
await page.getByRole('button',{name:'添加第一台设备'}).click();
await page.getByRole('button',{name:'保存设备',exact:true}).click();
// Inline validation: nothing reaches native until the fields make sense.
await page.getByText('填电脑的地址：域名或 IP',{exact:true}).waitFor();
await page.getByRole('textbox',{name:'设备名称',exact:true}).fill('测试电脑');
await page.getByRole('textbox',{name:'主机地址',exact:true}).fill('fixture.invalid');
await page.getByRole('textbox',{name:'SSH 用户名',exact:true}).fill('fixture');
await page.getByLabel('登录密码',{exact:true}).fill('test-password');
await page.getByRole('button',{name:'保存设备',exact:true}).click();
await page.getByText('密码已加密保存',{exact:true}).waitFor();
await page.evaluate(()=>connectionPassword(S.devices[0]));
assert(await page.getByRole('checkbox',{name:'记住本次登录密码',exact:true}).isChecked());
// A toast never sits on an open sheet's fields and buttons: it goes above the sheet.
await page.evaluate(()=>toast('提示位置检查'));await page.waitForTimeout(350);
{const r=await page.evaluate(()=>{const t=document.getElementById('toast').getBoundingClientRect(),s=document.querySelector('#overlay .sheet').getBoundingClientRect();return {t:t.bottom,s:s.top};});assert(r.t<=r.s+1,'toast over the sheet: '+JSON.stringify(r));}
await page.getByLabel('本次登录密码',{exact:true}).fill('updated-fixture-password');
await page.getByRole('button',{name:'连接',exact:true}).click();
await page.getByRole('dialog',{name:'安装配套桥接程序',exact:true}).waitFor();
assert.equal(await page.evaluate(()=>window.fixtureConnect.remember),true);
assert.equal(await page.evaluate(()=>S.devices[0].remember),true);
await page.getByRole('button',{name:'先不装，断开',exact:true}).click();
await page.evaluate(()=>disconnect());

// Hold each asynchronous stage to prove loading does not turn into a false empty state.
await page.evaluate(()=>{
 window.originalRequest=PocketNative.request;
 PocketNative.request=(id,op,raw)=>{
  if(op==='connect'){window.pendingConnect=id;return;}
  if(op==='remote'){window.pendingRemote={id,args:JSON.parse(raw)};return;}
  originalRequest(id,op,raw);
 };
 void doConnect(S.devices[0]);
});
await page.getByText('正在建立 SSH 连接并验证身份…',{exact:true}).waitFor();
assert(await page.getByRole('button',{name:'正在连接…',exact:true}).isDisabled());
await page.evaluate(()=>nativeProgress(pendingConnect,'等待你核对并确认 SSH 主机指纹…'));
await page.getByText('等待你核对并确认 SSH 主机指纹…',{exact:true}).waitFor();
await page.waitForTimeout(4600);
assert(await page.getByText('等待你核对并确认 SSH 主机指纹…',{exact:true}).isVisible());
await page.evaluate(()=>nativeResult(pendingConnect,{ok:true,data:{device:S.devices[0],ready:true}}));
await page.getByText('SSH 已连接，正在读取会话',{exact:true}).waitFor();
assert.equal(await page.getByText('暂时没有会话',{exact:true}).count(),0);
await page.evaluate(()=>nativeResult(pendingRemote.id,{ok:true,data:{sessions:[{name:'fixture',running:true}]}}));
await page.getByText('正在识别 Agent 并关联历史记录…',{exact:true}).waitFor();
fs.mkdirSync(path.join(root,'ui-artifacts'),{recursive:true});
await page.screenshot({path:path.join(root,'ui-artifacts/connection-loading-browser.png')});
await page.evaluate(()=>nativeResult(pendingRemote.id,{ok:false,error:'fixture read timeout'}));
await page.getByText('会话读取失败',{exact:true}).waitFor();
assert.equal(await page.getByText('暂时没有会话',{exact:true}).count(),0);
await page.getByRole('button',{name:'重新读取',exact:true}).click();
await page.evaluate(()=>nativeResult(pendingRemote.id,{ok:true,data:{sessions:[]}}));
await page.getByText('暂时没有会话',{exact:true}).waitFor();
// Failed and empty pages carry their own action: no orphaned refresh icon above them.
assert.equal(await page.getByRole('button',{name:'刷新会话',exact:true}).count(),0);
await page.evaluate(async()=>{await disconnect();void doConnect(S.devices[0]);});
await page.evaluate(()=>nativeResult(pendingConnect,{ok:false,error:'fixture authentication error'}));
await page.getByText('连接未完成',{exact:true}).waitFor();
assert(await page.getByRole('button',{name:'重试',exact:true}).isVisible());
await page.evaluate(async()=>{closeSheet();PocketNative.request=originalRequest;await disconnect();});
console.log('PASS: persistent SSH stages, duplicate connect disabled, loading versus empty, persistent failure and retry');

await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
await page.getByRole('button',{name:/把移动端做成真正的聊天工具/}).click();
await page.getByText('历史记录、子 Agent 和执行的命令都要能看到。',{exact:true}).waitFor();
// Turns: progress notes and commands fold into 「工作过程」, the final reply stays visible.
assert.equal(await page.locator('.turn').count(),2);
assert.equal(await page.locator('.message.reply').count(),2);
await page.getByText('测试都通过了。',{exact:false}).waitFor();
assert.equal(await page.getByText('我先看一下历史读取和子 Agent 关联现在是怎么做的。',{exact:true}).count(),0,'progress notes start folded');
assert.match(await page.locator('details.work .work-stats').first().textContent(),/2 条进展 · 5 个操作/);
assert.match(await page.locator('details.work').nth(1).textContent(),/1 个失败/);
await page.locator('details.work summary').first().click();
await page.getByText('我先看一下历史读取和子 Agent 关联现在是怎么做的。',{exact:true}).waitFor();
await page.getByText('layout_check 完成',{exact:true}).waitFor();
assert(await page.getByRole('button',{name:'展开全文 · 14 行',exact:true}).isVisible(),'long prompt is clamped');
// Opening the first work block scrolls near the top, which already pulls in the earlier page by
// itself; tap 加载更早消息 if it is still there.
const earlier=page.getByRole('button',{name:'加载更早消息',exact:true});
if(await earlier.count())await earlier.click({timeout:3000}).catch(()=>{});
await page.getByText('先把连接设备和密码保存做好。',{exact:true}).waitFor();
await page.getByText('改好了：连接资料和密码会用本机密钥加密保存，卸载应用后一起清除。',{exact:true}).waitFor();
assert.equal(await page.locator('.turn').count(),3);
assert.equal(await page.locator('details.work[open]').count(),1,'open work block survives loading earlier pages');
// Turn inference for transcripts without phases, harness notices and a page that starts mid-turn.
assert.deepEqual(await page.evaluate(()=>{const m=(id,kind,text,extra={})=>({id:id+':0',kind,text,title:kind==='tool'?'Bash':'',call_id:extra.c||'',timestamp:new Date(1e12+id*1000).toISOString(),...extra});
 const msgs=[m(1,'tool','ls',{c:'a'}),m(2,'result','x',{c:'a'}),m(3,'assistant','前一轮的回复'),m(4,'user','真正的问题'),m(5,'assistant','我先看看'),m(6,'tool','pytest',{c:'b'}),
  m(7,'user','<task-notification>\n<status>failed</status>\n<summary>构建失败</summary>\n</task-notification>'),m(8,'result','Exit code 1',{c:'b'}),m(9,'assistant','修好了'),
  m(10,'user','<task-notification>\n<summary>后台完成</summary>\n</task-notification>'),m(11,'assistant','后台任务也好了'),m(12,'user','继续'),m(13,'assistant','正在跑'),m(14,'tool','npm test',{c:'c'})];
 const done=buildTurns(msgs,false),live=buildTurns(msgs,true);
 return [done.map(t=>[!!t.partial,t.prompt?.text||t.notice?.n.label||'',t.final?.m.text||'',t.stats.notes,t.stats.ops,t.stats.failed]),live.at(-1).final,userNotice('[Request interrupted by user for tool use]').label];}),
 [[[true,'','前一轮的回复',0,1,0],[false,'真正的问题','修好了',1,1,1],[false,'后台任务','后台任务也好了',0,0,0],[false,'继续','',1,1,0]],null,'已中断']);
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
await page.screenshot({path:path.join(folder,'chat-browser.png')});
await page.getByRole('button',{name:'命令',exact:true}).click();
await page.getByText('Ran 24 tests in 0.08s',{exact:false}).waitFor();
await page.screenshot({path:path.join(folder,'commands-browser.png')});
await page.getByRole('button',{name:'对话',exact:true}).click();
await page.getByRole('textbox',{name:'消息输入框',exact:true}).fill('kept draft');
await page.getByRole('button',{name:'发送消息',exact:true}).click();
await page.getByText('演示模式：未发送，草稿已保留',{exact:true}).waitFor();
await page.getByRole('button',{name:'切换 Agent',exact:true}).click();
await page.getByRole('button',{name:'布局检查 · 子 Agent，已结束，打开只读记录',exact:true}).click();
await page.getByText('子 Agent：布局检查完成。',{exact:true}).waitFor();
assert.equal(await page.getByRole('textbox',{name:'消息输入框',exact:true}).count(),0);
await page.screenshot({path:path.join(folder,'child-browser.png')});
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.getByRole('textbox',{name:'消息输入框',exact:true}).waitFor();
assert.equal(await page.getByRole('textbox',{name:'消息输入框',exact:true}).inputValue(),'kept draft');
await page.getByRole('button',{name:'切换 Agent',exact:true}).click();
await page.getByRole('button',{name:/检查接口与回归测试/}).click();
await page.getByText('这是 Claude 的独立会话。',{exact:true}).waitFor();
// A running turn has no reply yet: its newest progress is shown live and the work block says so.
await page.getByText('Claude · 最新进展',{exact:true}).waitFor();
await page.getByText('正在工作',{exact:true}).waitFor();
await page.locator('details.work summary').last().click();
await page.getByText('后台构建已完成',{exact:true}).waitFor();
console.log('PASS: turns fold progress and commands, keep replies prominent, survive pagination, live progress and harness notices');
assert.equal(await page.getByText('子 Agent：布局检查完成。',{exact:true}).count(),0);
for(const [width,height] of [[320,640],[844,390],[1024,768]]){
 await page.setViewportSize({width,height});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow');
 const box=await page.getByRole('button',{name:'发送消息',exact:true}).boundingBox();assert(box.y+box.height<=height,'composer clipped');
 await page.screenshot({path:path.join(folder,`layout-${width}.png`)});
}
await page.setViewportSize({width:390,height:844});
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.getByRole('button',{name:'历史',exact:true}).click();
await page.getByRole('button',{name:'子 Agent',exact:true}).click();
await page.getByRole('button',{name:/布局检查 · 子 Agent/}).waitFor();
await page.getByRole('button',{name:'会话',exact:true}).click();
await page.evaluate(()=>{delete demoAgents[0].agent_session;});
await page.getByRole('button',{name:/把移动端做成真正的聊天工具/}).click();
await page.getByRole('button',{name:'选择历史记录',exact:true}).click();
await page.getByRole('button',{name:/把移动端做成真正的聊天工具 · demo-roo/}).click();
await page.getByRole('button',{name:'关联当前 Agent',exact:true}).click();
await page.getByText('历史记录、子 Agent 和执行的命令都要能看到。',{exact:true}).waitFor();
assert.equal(await page.evaluate(()=>S.chat.agent.pane_id),'demo:1');
assert.equal(await page.evaluate(()=>S.chat.manual),true);
await page.evaluate(async()=>{
 S.bindings.clear();const originalRemote=remote;window.historyCalls=[];remote=(op,args={})=>{historyCalls.push({op,args});return originalRemote(op,args);};
 const context={session:'demo',target:'demo:1',identity:'demo-codex'};
 const record={...demoRecords[0],remote:context};
 S.bindings.set('demo/demo-codex',demoRecords[2]);
 await openAgent({...demoAgents[0],history_ref:{status:'matched',source:'ch-route',record_id:record.id,record,remote:context}});
});
await page.getByText('历史记录、子 Agent 和执行的命令都要能看到。',{exact:true}).waitFor();
assert.equal(await page.evaluate(()=>S.chat.manual),undefined);
assert.equal(await page.evaluate(()=>historyCalls.filter(x=>x.op==='history').at(-1).args.remote.target),'demo:1');
await page.getByRole('button',{name:'更多操作',exact:true}).click();
await page.getByRole('button',{name:'选择其他历史记录',exact:true}).click();
await page.getByRole('button',{name:/把移动端做成真正的聊天工具 · demo-roo/}).waitFor();
assert.equal(await page.evaluate(()=>historyCalls.filter(x=>x.op==='catalog').at(-1).args.remote.target),'demo:1');
await page.getByRole('button',{name:'关闭',exact:true}).click();
console.log('PASS: missing Herdr ID resolves explicit remote history and preserves remote picker context');

await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.getByRole('button',{name:'设备',exact:true}).click();
await page.getByText('workstation.local',{exact:true}).waitFor();
// The demo's device card offers the way out, not bridge updates, a disconnect warning or another demo.
assert(await page.getByRole('button',{name:'退出演示',exact:true}).isVisible());
for(const name of ['断开连接','更新桥接程序','体验聊天演示'])assert.equal(await page.getByRole('button',{name,exact:true}).count(),0,name);
await page.screenshot({path:path.join(folder,'account-browser.png')});
await page.getByRole('button',{name:'终端',exact:true}).click();
await page.getByRole('button',{name:/开发终端/}).click();
await page.getByRole('textbox',{name:'终端输入',exact:true}).fill('demo-no-execution');
await page.getByRole('button',{name:'执行',exact:true}).click();
await page.getByText('终端演示：未发送',{exact:true}).waitFor();
assert.equal(await page.getByRole('textbox',{name:'终端输入',exact:true}).inputValue(),'demo-no-execution');
await page.getByRole('button',{name:'返回终端列表',exact:true}).click();
await page.getByRole('button',{name:'打开 SSH 终端',exact:true}).click();
await page.locator('.xterm-screen').waitFor();
await page.getByRole('button',{name:'Ctrl+C',exact:true}).click();
await page.getByRole('button',{name:'返回终端列表',exact:true}).click();
await page.getByRole('button',{name:'返回 SSH 终端',exact:true}).click();
assert.equal(await page.evaluate(()=>T.shell.sequence),0,'demo must not send SSH bytes');
await page.screenshot({path:path.join(folder,'ssh-terminal-browser.png')});
for(const [width,height] of [[320,640],[844,390]]){await page.setViewportSize({width,height});const b=await page.getByRole('button',{name:'执行',exact:true}).boundingBox();assert(b.y+b.height<=height,'terminal composer clipped');assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
await page.getByRole('button',{name:'返回终端列表',exact:true}).click();
await page.getByRole('button',{name:'设备',exact:true}).click();
console.log('PASS: SSH renderer, persistent terminal view, Herdr pane selection, demo input isolation and responsive terminal');
assert.deepEqual(errors,[]);console.log('PASS: device form, chat, earlier history, commands/results, child switch, target isolation, drafts, narrow/landscape/tablet, SSH info');
assert.equal(await page.locator('.pane-enter').evaluate(n=>getComputedStyle(n).animationName),'arrive');
await page.emulateMedia({reducedMotion:'reduce'});
assert.equal(await page.locator('.pane-enter').evaluate(n=>getComputedStyle(n).animationName),'none');
console.log('PASS: animations and reduced-motion preference');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
