// 会话 list previews (glance.js): one line per agent with the current step, the question that
// waits for you, or the first line of the last reply; refreshed with the status poll for changed
// agents only, cached for the next open; compact toolbar with counts left of 刷新 / 新建.
// Offline: native SSH is a strict fake and `remote` the recorded list fixture.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const {install}=require('./lists_fixture.cjs');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const errors=[];
const store=new Map();
async function fresh(width=390,height=844,opts={}){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,hasTouch:true,colorScheme:opts.dark?'dark':'light'});
 const page=await context.newPage();
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.exposeFunction('cacheStore',(op,k,v)=>{if(op==='put')store.set(k,v);return store.get(k)||null;});
 await page.addInitScript(()=>{window.nativeCalls=[];
  window.PocketNative={request(id,op,raw){nativeCalls.push(op);if(!['devices','demo','disconnect','protect','watchState','settings','cacheGet','cachePut'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);
   const a=JSON.parse(raw||'{}');const done=data=>setTimeout(()=>nativeResult(id,{ok:true,data}),0);
   if(op==='cacheGet'){cacheStore('get',a.device+'\n'+a.key).then(value=>done({value}));return;}
   if(op==='cachePut'){cacheStore('put',a.device+'\n'+a.key,a.value).then(()=>done({}));return;}
   done(op==='devices'?{devices:[]}:{});}};});
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 if(opts.dark)await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 await page.getByText('离线演示 · 示例数据，不连接电脑',{exact:true}).waitFor();
 if(opts.demo)return page;
 await install(page,opts);await page.evaluate(()=>setTab('live'));await page.locator('.agent-row').first().waitFor();
 return page;}
const calls=(page,op)=>page.evaluate(op=>fx.calls.filter(c=>c.op===op).map(c=>c.args),op);
const noInput=async page=>{for(const op of ['prompt','key','answer','closePane','exitAgent','paneRun','paneText','paneKey'])assert.equal((await calls(page,op)).length,0,op+' must not be called');};
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
const rowOf=(page,title)=>page.locator('.agent-row',{has:page.locator('.card-title',{hasText:title})});
// Pieces of the preview line joined with | (the lead and its target are separate spans).
const previewOf=(page,title)=>rowOf(page,title).locator('.glance').evaluate(n=>[...n.querySelectorAll('.gt')].map(x=>x.textContent).join('|'));

// 1. Previews: working → current step, blocked → what it waits on, idle → first line of the reply.
{const page=await fresh();
 await page.locator('.glance').first().waitFor();
 assert.equal(await previewOf(page,'修复 Gateway OTA 断点续传'),'运行|python3 scripts/firmware.py build --machine A1V3 --preset Debug');
 assert.equal(await rowOf(page,'修复 Gateway OTA 断点续传').locator('.glance-code').count(),1);
 assert.equal(await previewOf(page,'检查运动控制回零逻辑'),'问：|回零前要不要先抬 Z 轴 5 mm？');
 assert.equal(await previewOf(page,'加速度计零偏'),'想运行|rm -rf build/ .cache/');
 assert.ok(await rowOf(page,'加速度计零偏').locator('.glance.g-ask').count());
 assert.equal(await previewOf(page,'整理串口日志解析'),'串口日志解析整理好了：按帧切分，丢包和校验错误单独统计，测试都过了。');
 assert.equal(await previewOf(page,'主题与暗色模式'),'暗色模式');
 // No reply text: a short summary of the turn.
 assert.equal(await previewOf(page,'历史分页游标'),'改了 2 个文件 · 执行 6 步');
 // ch (remote) panes are not asked for and show no preview.
 const asked=(await calls(page,'glance'))[0].items;
 assert.ok(asked.length>=15&&asked.every(x=>x.record_id&&x.thread&&x.provider&&x.key.startsWith('default/')),'local items only');
 assert.ok(!asked.some(x=>['r3','r10','r17'].includes(x.record_id)),'ch panes are not read locally');
 assert.equal(await rowOf(page,'CAM 预处理参数对齐').locator('.glance').count(),0);
 // Two lines per row: title (one line) + meta/preview; ellipsis instead of wrapping.
 const tall=await page.$$eval('.agent-row.has-glance',rows=>rows.map(r=>r.querySelector('.grow').getBoundingClientRect().height));
 assert.ok(Math.max(...tall)<48,'rows stay two lines: '+Math.max(...tall));
 const one=await page.$eval('.agent-row.has-glance .glance .gt',n=>getComputedStyle(n).whiteSpace+'/'+getComputedStyle(n).textOverflow);
 assert.equal(one,'nowrap/ellipsis');
 // Nothing in a row reaches past the screen edge (long commands truncate inside their span).
 const wide=await page.evaluate(()=>[...document.querySelectorAll('.agent-row *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).map(n=>n.className));
 assert.deepEqual(wide,[]);
 // Idle times come from the transcript's last entry.
 assert.equal((await rowOf(page,'连接不稳定排查').locator('.row-time').textContent()).trim(),'31 分钟前');
 assert.ok(await overflow(page)<=0,'live overflows');
 await page.waitForTimeout(500);await page.screenshot({path:path.join(folder,'glance-live-390.png')});
 await noInput(page);
 await page.context().close();}

// 2. Toolbar: counts and freshness share the 刷新 / 新建 row; no separate status line.
{const page=await fresh();
 await page.getByText('22 个在线',{exact:true}).waitFor();
 const bar=await page.$eval('.list-actions',n=>{const r=n.getBoundingClientRect(),s=n.querySelector('.live-status').getBoundingClientRect(),b=n.querySelector('[aria-label="刷新会话"]').getBoundingClientRect();return {h:r.height,left:s.left-r.left,sameRow:Math.abs((s.top+s.bottom)/2-(b.top+b.bottom)/2)<4,before:s.right<=b.left};});
 assert.ok(bar.sameRow&&bar.before&&bar.left<12,'counts sit left of refresh: '+JSON.stringify(bar));
 assert.ok(bar.h<=48,'toolbar stays one row');
 assert.equal(await page.locator('main > .list-status').count(),0);
 await page.getByText('刚刚更新',{exact:true}).waitFor();
 await page.locator('.live-status .fact-new').getByText(/^\d+ 个有新进展$/).waitFor();
 await page.context().close();}

// 3. Poll: only busy agents or agents whose state changed are asked again, with their stamps;
// unchanged files answer "same" and the list repaints in place (scroll kept).
{const page=await fresh();
 await page.locator('.glance').first().waitFor();
 // The first fetch must be fully applied (slow CI machines), or this poll would still ask about everyone.
 await page.waitForFunction(()=>!GL.busy&&S.agents.every(a=>!glanceItem(a)||GL.map.has(agentKey(a))));
 await page.evaluate(()=>{document.querySelector('.main').scrollTop=300;});
 const before=(await calls(page,'glance')).length;
 await page.evaluate(()=>{const a=fx.agents[8];fx.agents=fx.agents.map((x,i)=>i===8?{...x,agent_status:'working'}:x);fx.looks[8]={activity:{kind:'tool',verb:'edit',text:'cursor.py',open:true},at:new Date().toISOString(),stamp:'s8b'};});
 await page.evaluate(()=>refreshStatus().then(()=>glanceRefresh()));
 await page.waitForFunction(n=>fx.calls.filter(c=>c.op==='glance').length>n,before);
 const poll=(await calls(page,'glance')).at(-1).items;
 const ids=poll.map(x=>x.record_id).sort();
 assert.deepEqual(ids,['r0','r1','r15','r20','r5','r8'],'busy + changed only: '+ids);
 assert.ok(poll.filter(x=>x.record_id!=='r8').every(x=>x.stamp),'known stamps are sent');
 await page.waitForFunction(()=>[...document.querySelectorAll('.agent-row')].some(r=>r.textContent.includes('历史分页游标')&&r.querySelector('.glance')?.textContent==='修改cursor.py'));
 await page.context().close();}

// 4. Cache: previews from the last visit show at once while the bridge is still asked.
{const page=await fresh();
 await page.locator('.glance').first().waitFor();await page.waitForTimeout(1500);
 await page.context().close();
 const again=await fresh(390,844,{glance:false});
 await again.locator('.glance').first().waitFor({timeout:3000});
 assert.equal(await previewOf(again,'整理串口日志解析'),'串口日志解析整理好了：按帧切分，丢包和校验错误单独统计，测试都过了。');
 await again.context().close();}

// 5. Old bridge without `glance`: asked once, then never again; the list still works.
{const page=await fresh(390,844,{});
 await page.evaluate(()=>{fx.noGlance=true;GL.map.clear();GL.at=0;});await page.evaluate(()=>glanceRefresh(true));
 // Requests already in flight (list polls run every 2.5 s now) may still land: count once the refusal is recorded and things are quiet.
 await page.waitForFunction(()=>GL.unsupported&&!GL.busy);await page.waitForTimeout(1500);
 const n=(await calls(page,'glance')).length;await page.evaluate(()=>glanceRefresh(true));await page.waitForTimeout(3000);
 assert.equal((await calls(page,'glance')).length,n);
 assert.equal(await page.locator('.agent-row').count(),22);
 await page.context().close();}

// 6. Demo shows previews too; dark theme and 320 px stay tidy.
{const page=await fresh(390,844,{demo:true});
 await page.locator('.glance').first().waitFor();
 assert.equal(await previewOf(page,'清理构建缓存'),'想运行|rm -rf dist .cache');
 await page.waitForTimeout(500);await page.screenshot({path:path.join(folder,'glance-demo-390.png')});
 await page.context().close();}
for(const [w,h,dark] of [[390,844,true],[320,640,false],[320,640,true]]){
 const page=await fresh(w,h,{dark});await page.locator('.glance').first().waitFor();
 assert.ok(await overflow(page)<=0,'overflow at '+w);
 const fits=await page.$eval('.list-actions',n=>[...n.children].every(c=>c.getBoundingClientRect().right<=n.getBoundingClientRect().right+0.5));
 assert.ok(fits,'toolbar fits at '+w);
 await page.waitForTimeout(500);await page.screenshot({path:path.join(folder,'glance-live-'+w+(dark?'-dark':'')+'.png')});
 await page.evaluate(()=>{const g=[...document.querySelectorAll('.group-label')].at(-1);document.querySelector('.main').scrollTop=g.offsetTop-8;});
 await page.waitForTimeout(150);await page.screenshot({path:path.join(folder,'glance-idle-'+w+(dark?'-dark':'')+'.png')});
 await page.context().close();}

// Several Herdr sessions: the session pill, counts, 刷新 and 新建 still share one row at 320.
{const page=await fresh(320,640,{sessions:[{name:'default',running:true},{name:'firmware-lab',running:true}]});
 await page.locator('.session-pill').waitFor();await page.waitForTimeout(400);
 const r=await page.$eval('.list-actions',n=>{const box=n.getBoundingClientRect();return {h:box.height,fits:[...n.children].every(c=>c.getBoundingClientRect().right<=box.right+0.5&&c.getBoundingClientRect().width>20)};});
 assert.ok(r.fits&&r.h<=48,'toolbar with sessions: '+JSON.stringify(r));
 assert.ok(await page.$eval('.live-status .fact-count',n=>n.scrollWidth<=n.clientWidth+1),'count is not cut');
 await page.locator('.list-actions').getByRole('button',{name:'新建会话'}).waitFor();
 await page.screenshot({path:path.join(folder,'glance-sessions-320.png')});
 await page.context().close();}

await browser.close();
assert.deepEqual(errors,[]);
console.log('glance ui ok');
})().catch(e=>{console.error(e);process.exit(1);});
