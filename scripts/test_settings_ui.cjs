// 设置: theme, text size, screen protection, alerts, cache and the update flow. Offline: the native
// side is a strict fixture that records every call; nothing reaches GitHub or a device.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 window.nx={calls:[],prefs:{theme:'system',dark:false,textZoom:100,secureScreen:false,autoUpdate:true,seenUpdate:'',alerts:true,version:'0.6.0-dev.40',versionCode:140,update:null},
  latest:{available:true,checkedAt:Date.now(),current:140,latest:{tag:'preview-41',name:'Herdr Pocket preview-41',code:141,prerelease:true,published:new Date(Date.now()-3600e3).toISOString(),size:9_400_000,page:'https://github.com/HFO4AR/herdr-pocket/releases/tag/preview-41'}},
  cache:{bytes:2_500_000,entries:7},holdDownload:null};
 const reply=(id,data,err)=>setTimeout(()=>nativeResult(id,err?{ok:false,error:err}:{ok:true,data}),0);
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);nx.calls.push({op,a});
  if(op==='devices')return reply(id,{devices:[],version:nx.prefs.version,alerts:true});
  if(op==='settings')return reply(id,nx.prefs);
  if(op==='setSetting'){nx.prefs={...nx.prefs,[a.key]:a.value};if(a.key==='theme')nx.prefs.dark=a.value==='dark';return reply(id,nx.prefs);}
  if(op==='setAlerts'){nx.prefs.alerts=a.enabled;return reply(id,{alerts:a.enabled});}
  if(op==='checkUpdate'){nx.prefs.update=nx.latest;return reply(id,nx.latest);}
  if(op==='downloadUpdate'){nx.holdDownload=id;return;}
  if(op==='installUpdate')return reply(id,{needPermission:nx.calls.filter(c=>c.op==='installUpdate').length===1});
  if(op==='cacheInfo')return reply(id,nx.cache);
  if(op==='cacheClear'){nx.cache={bytes:0,entries:0};return reply(id,{});}
  if(op==='openUrl')return reply(id,{});
  if(['demo','disconnect','protect'].includes(op))return reply(id,{});
  throw Error('Forbidden native call in offline UI test: '+op);}};});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});

// Launch: automatic update check (cached natively) puts a dot on the 设置 tab and toasts once.
await page.getByText('有新版本 preview-41',{exact:false}).waitFor();
const tab=page.getByRole('button',{name:'设置',exact:true});
await tab.locator('.nav-dot').waitFor();
assert.deepEqual(await page.evaluate(()=>nx.calls.filter(c=>c.op==='checkUpdate').map(c=>c.a)),[{force:false}]);
assert.equal(await page.evaluate(()=>nx.prefs.seenUpdate),'preview-41','toast once per version');
console.log('PASS: automatic update check marks the settings tab');

await tab.click();
await page.getByRole('heading',{name:'设置',exact:true}).waitFor();
await page.locator('.update-banner').getByText('新版本 preview-41').waitFor();
await page.getByText('0.6.0-dev.40',{exact:true}).waitFor();
await page.getByText('2.4 MB · 7 项',{exact:true}).waitFor();
await page.screenshot({path:path.join(folder,'settings-light.png'),fullPage:true});

// Theme: native resolves it; the page switches at once.
await page.getByRole('radio',{name:'深色',exact:true}).click();
await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(21, 21, 20)');
await page.screenshot({path:path.join(folder,'settings-dark.png'),fullPage:true});
await page.getByRole('radio',{name:'跟随系统',exact:true}).click();
await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');
await page.getByRole('radio',{name:'大',exact:true}).click();
assert.deepEqual(await page.evaluate(()=>nx.calls.filter(c=>c.op==='setSetting').map(c=>[c.a.key,c.a.value]).slice(-3)),[['theme','dark'],['theme','system'],['textZoom',115]]);
console.log('PASS: theme and text size apply immediately');

// 保持多久: on phones one clean full-width control under its label, four equal segments in one row;
// on a tablet it sits beside its label again.
const keepGeo=()=>page.evaluate(()=>{const g=document.querySelector('[role=radiogroup][aria-label="保持多久"]'),row=g.closest('.set-row'),label=row.querySelector('.set-label');
 const gr=g.getBoundingClientRect(),rr=row.getBoundingClientRect(),lr=label.getBoundingClientRect(),opts=[...g.children].map(b=>b.getBoundingClientRect());
 return {full:Math.abs(gr.width-rr.width)<1.5,below:gr.top>=lr.bottom-1,oneRow:new Set(opts.map(o=>Math.round(o.top))).size===1,
  equal:Math.max(...opts.map(o=>o.width))-Math.min(...opts.map(o=>o.width))<1.5,inRow:gr.right<=rr.right+0.5,tall:Math.min(...opts.map(o=>o.height))>=36,scroll:document.scrollingElement.scrollWidth<=innerWidth};});
for(const [w,h] of [[390,844],[320,640]]){await page.setViewportSize({width:w,height:h});await page.waitForTimeout(150);
 const g=await keepGeo();assert.deepEqual(g,{full:true,below:true,oneRow:true,equal:true,inRow:true,tall:true,scroll:true},'保持多久 at '+w);
 await page.locator('.set-card').filter({hasText:'后台保持连接'}).screenshot({path:path.join(folder,'settings-keep-'+w+'.png')});}
await page.setViewportSize({width:1024,height:768});await page.waitForTimeout(300);
{const g=await keepGeo();assert(!g.full&&!g.below&&g.oneRow&&g.inRow&&g.scroll,'保持多久 sits beside its label on a tablet: '+JSON.stringify(g));}
await page.locator('.set-card').filter({hasText:'后台保持连接'}).screenshot({path:path.join(folder,'settings-keep-1024.png')});
await page.setViewportSize({width:390,height:844});
console.log('PASS: 保持多久 is a full-width segmented control on phones, inline on tablets');

// Screen protection is off by default (screenshots allowed) and can be turned on.
const secure=page.getByRole('checkbox',{name:'防截图',exact:true});
assert.equal(await secure.isChecked(),false);
await page.locator('label.switch-row').filter({hasText:'防截图'}).click();
await page.waitForFunction(()=>nx.prefs.secureScreen===true);
await page.getByText('已禁止截图',{exact:true}).waitFor();
await page.locator('label.switch-row').filter({hasText:'后台提醒'}).click();
await page.waitForFunction(()=>nx.prefs.alerts===false);
console.log('PASS: screenshots allowed by default, protection and alerts toggles');

// Cache: confirm, clear, size updates.
await page.getByRole('button',{name:'清除缓存',exact:true}).click();
await page.getByRole('dialog',{name:'清除缓存？'}).getByRole('button',{name:'清除',exact:true}).click();
await page.getByText('0 B · 0 项',{exact:true}).waitFor();
console.log('PASS: clear cache');

// Manual check, then download with progress, then the system-installer handoff.
await page.getByRole('button',{name:'检查更新',exact:true}).click();
await page.waitForFunction(()=>nx.calls.filter(c=>c.op==='checkUpdate').at(-1).a.force===true);
await page.getByText('可以更新到 preview-41',{exact:true}).waitFor();
await page.getByRole('button',{name:'下载并安装',exact:true}).click();
await page.getByRole('progressbar').waitFor();
await page.evaluate(()=>{nativeProgress(nx.holdDownload,'42');});
await page.getByText('正在下载 42%',{exact:true}).waitFor();
assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'42');
await page.screenshot({path:path.join(folder,'settings-download.png')});
await page.evaluate(()=>nativeResult(nx.holdDownload,{ok:true,data:{tag:'preview-41',ready:true}}));
await page.getByText(/允许 Herdr Pocket「安装未知应用」/).waitFor();
await page.getByRole('button',{name:'安装',exact:true}).first().click();
await page.waitForFunction(()=>nx.calls.filter(c=>c.op==='installUpdate').length===2);
assert.deepEqual(await page.evaluate(()=>nx.calls.filter(c=>c.op==='downloadUpdate'||c.op==='installUpdate').map(c=>c.a.tag)),['preview-41','preview-41','preview-41']);
console.log('PASS: download progress, unknown-sources permission, install handoff');

// A failed download is shown in place and can be retried by hand.
await page.evaluate(()=>{SET.ready=null;render();});
await page.getByRole('button',{name:'下载并安装',exact:true}).click();
await page.evaluate(()=>nativeResult(nx.holdDownload,{ok:false,error:'下载的文件校验不通过，已删除'}));
await page.getByRole('alert').getByText('下载的文件校验不通过，已删除').waitFor();
assert.equal(await page.getByRole('button',{name:'下载并安装',exact:true}).isEnabled(),true);
console.log('PASS: download failure reported, retry possible');

// Dark mode across the main surfaces: demo chat and lists render without light leftovers.
await page.evaluate(()=>window.applyTheme('dark'));
await page.getByRole('button',{name:'设备',exact:true}).click();
await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
await page.screenshot({path:path.join(folder,'dark-live.png')});
await page.locator('.agent-row').first().click();
await page.locator('.timeline').waitFor();
await page.screenshot({path:path.join(folder,'dark-chat.png')});
const light=await page.evaluate(()=>{const bad=[];for(const n of document.querySelectorAll('#app *')){if(n.closest('.primary,.send,.new-btn'))continue;const c=getComputedStyle(n).backgroundColor;const m=c.match(/rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/);if(!m)continue;const [r,g,b]=[+m[1],+m[2],+m[3]];const a=m[4]===undefined?1:+m[4];if(a>0.5&&r>200&&g>200&&b>200)bad.push(n.className||n.tagName);}return bad;});
assert.deepEqual(light,[],'no light backgrounds left in dark mode');
console.log('PASS: dark mode chat has no light surfaces');

assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
