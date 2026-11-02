// 终端 look: the screen and the page's keys and controls each have their own light / dark, apart from
// the app theme. Offline demo: native is a strict fake that keeps the settings and records pageBars.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');

const DARK_KEY='rgb(42, 41, 38)',LIGHT_KEY='rgb(244, 243, 239)';
const WELL='rgb(13, 13, 12)',CARD='rgb(28, 27, 25)',WHITE='rgb(255, 255, 255)';

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const errors=[];
async function fresh(app,prefs={},width=390,height=844){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,hasTouch:true});
 const page=await context.newPage();
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(p=>{window.nx={bars:[],prefs:p};window.PocketNative={request(id,op,raw){
  const a=JSON.parse(raw),reply=d=>setTimeout(()=>nativeResult(id,{ok:true,data:d}),0);
  if(op==='inputInfo')return reply({physicalKeyboard:false});
  if(op==='pageBars'){nx.bars.push(a.dark);return reply({});}
  if(op==='settings')return reply(nx.prefs);
  if(op==='setSetting'){nx.prefs={...nx.prefs,[a.key]:a.value};return reply(nx.prefs);}
  if(op==='devices')return reply({devices:[]});
  if(op==='cacheGet')return reply({value:null});
  if(['demo','disconnect','protect','watchState','cachePut','cacheInfo'].includes(op))return reply({});
  throw Error('Forbidden native call in offline UI test: '+op);}};},{theme:'system',dark:app==='dark',textZoom:100,autoUpdate:false,...prefs});
 await page.goto(require('./ui_bundle.cjs').url(html));
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 await page.getByText('离线演示 · 示例数据，不连接电脑',{exact:true}).first().waitFor();
 await page.waitForFunction(()=>!!SET.prefs);
 await page.evaluate(t=>window.applyTheme(t),app);
 return page;}
const nav=(page,name)=>page.locator('.bottom-nav').getByRole('button',{name,exact:true}).click();
async function openSsh(page){await nav(page,'终端');await page.getByRole('button',{name:'打开 SSH 终端',exact:true}).click();await page.locator('.xterm-screen').waitFor();}
const leave=page=>page.getByRole('button',{name:'返回终端列表',exact:true}).click();
const choose=(page,group,name)=>page.getByRole('radiogroup',{name:group,exact:true}).getByRole('radio',{name,exact:true}).click();
const picked=(page,group)=>page.getByRole('radiogroup',{name:group,exact:true}).locator('[aria-checked="true"]').textContent();
const seen=page=>page.evaluate(()=>{document.getAnimations().forEach(a=>a.finish());const css=(s,p)=>getComputedStyle(document.querySelector(s))[p],r=document.documentElement.dataset;
 return {theme:r.theme,term:r.term,key:css('.tk-page .key','backgroundColor'),surface:css('#term-surface','backgroundColor'),xterm:T.shell.term.options.theme.background,fg:T.shell.term.options.theme.foreground};});
const tokenRgb=hex=>{let h=hex.slice(1);if(h.length===3)h=[...h].map(x=>x+x).join('');return 'rgb('+[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)).join(', ')+')';};
function look(s,theme,term,key,surface,tag){
 assert.equal(s.theme,theme,tag+': page theme');assert.equal(s.term,term,tag+': screen theme');
 assert.equal(s.key,key,tag+': key colour');assert.equal(s.surface,surface,tag+': screen colour');
 assert.equal(tokenRgb(s.xterm),surface,tag+': xterm repainted');}

// 1. Every combination: the keys and the screen land where the two settings say, and the system bars
// are told only when the page differs from the app theme.
for(const [app,prefs,theme,term,key,surface,bars] of [
 ['light',{},'dark','dark',DARK_KEY,WELL,[true]],
 ['light',{termLook:'app'},'light','dark',LIGHT_KEY,CARD,[]],
 ['light',{termLook:'light'},'light','dark',LIGHT_KEY,CARD,[]],
 ['light',{termScreen:'light'},'light','light',LIGHT_KEY,WHITE,[]],
 ['light',{termScreen:'app'},'light','light',LIGHT_KEY,WHITE,[]],
 ['light',{termScreen:'light',termLook:'dark'},'dark','light',DARK_KEY,WHITE,[true]],
 ['dark',{},'dark','dark',DARK_KEY,WELL,[]],
 ['dark',{termScreen:'app'},'dark','dark',DARK_KEY,WELL,[]],
 ['dark',{termScreen:'light'},'light','light',LIGHT_KEY,WHITE,[false]],
 ['dark',{termLook:'light'},'light','dark',LIGHT_KEY,CARD,[false]],
 ['dark',{termScreen:'light',termLook:'app'},'dark','light',DARK_KEY,WHITE,[]],
]){
 const tag=app+' '+JSON.stringify(prefs);const page=await fresh(app,prefs);
 await openSsh(page);look(await seen(page),theme,term,key,surface,tag);
 assert.deepEqual(await page.evaluate(()=>nx.bars),bars,tag+': bars on the way in');
 // Back on the list the app theme is back, and so are the bars.
 await leave(page);
 assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),app,tag+': theme restored');
 assert.deepEqual(await page.evaluate(()=>nx.bars),bars.length?[...bars,null]:[],tag+': bars restored');
 await page.context().close();}
console.log('PASS: screen and controls follow their own settings, the app theme comes back on the way out');

// 2. The app theme changing under a terminal page (system dark mode): only what follows it moves.
{const page=await fresh('light',{termScreen:'app'});await openSsh(page);
 look(await seen(page),'light','light',LIGHT_KEY,WHITE,'follow light');
 await page.evaluate(()=>T.shell.term.write('\x1b[32mgreen\x1b[0m \x1b[31mred\x1b[0m \x1b[33myellow\x1b[0m \x1b[34mblue\x1b[0m \x1b[35mmagenta\x1b[0m \x1b[36mcyan\x1b[0m \x1b[37mwhite\x1b[0m \x1b[90mgrey\x1b[0m\r\n$ '));await page.waitForTimeout(150);
 await page.screenshot({path:path.join(folder,'termlook-light.png')});
 await page.evaluate(()=>window.applyTheme('dark'));look(await seen(page),'dark','dark',DARK_KEY,WELL,'follow dark');
 assert.deepEqual(await page.evaluate(()=>nx.bars),[],'following the app never overrides the bars');
 await page.context().close();
 const pinned=await fresh('light');await openSsh(pinned);
 look(await seen(pinned),'dark','dark',DARK_KEY,WELL,'pinned');
 await pinned.evaluate(()=>window.applyTheme('dark'));look(await seen(pinned),'dark','dark',DARK_KEY,WELL,'pinned, app dark');
 assert.deepEqual(await pinned.evaluate(()=>nx.bars),[true,null],'same as the app: no override');
 await pinned.evaluate(()=>window.applyTheme('light'));await leave(pinned);
 assert.equal(await pinned.evaluate(()=>document.documentElement.dataset.theme),'light','the latest app theme is what comes back');
 await pinned.context().close();
 console.log('PASS: a system theme change only moves what follows it');}

// 3. 终端选项: both choices apply on the spot, and 设置 shows the same answer.
for(const [width,height] of [[390,844],[320,640]]){
 const page=await fresh('light',{},width,height);await openSsh(page);
 await page.screenshot({path:path.join(folder,'termlook-default-'+width+'.png')});
 await page.getByRole('button',{name:'终端选项',exact:true}).click();
 assert.equal(await picked(page,'终端屏幕'),'深色');assert.equal(await picked(page,'终端按键和控件'),'跟随屏幕');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=0,'sheet fits '+width);
 for(const name of ['跟随主题','浅色','深色','跟随屏幕']){const b=await page.getByRole('radiogroup',{name:'终端按键和控件',exact:true}).getByRole('radio',{name,exact:true}).boundingBox();assert.ok(b.x>=0&&b.x+b.width<=width&&b.height>=36,name+' fits '+width+': '+JSON.stringify(b));}
 await page.screenshot({path:path.join(folder,'termlook-sheet-'+width+'.png')});
 await choose(page,'终端屏幕','浅色');
 await page.waitForFunction(()=>document.documentElement.dataset.term==='light');
 look(await seen(page),'light','light',LIGHT_KEY,WHITE,'menu: light screen');
 assert.equal(await picked(page,'终端屏幕'),'浅色','the sheet stays open on the new choice');
 await choose(page,'终端按键和控件','深色');
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 look(await seen(page),'dark','light',DARK_KEY,WHITE,'menu: dark controls');
 assert.deepEqual(await page.evaluate(()=>[nx.prefs.termScreen,nx.prefs.termLook]),['light','dark'],'saved natively');
 await page.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('.sheet').waitFor({state:'detached'});await page.waitForTimeout(300);
 await page.screenshot({path:path.join(folder,'termlook-mixed-'+width+'.png')});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=0,'page fits '+width);
 await leave(page);await nav(page,'设置');
 assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');
 assert.equal(await picked(page,'终端屏幕'),'浅色');assert.equal(await picked(page,'终端按键和控件'),'深色');
 await page.screenshot({path:path.join(folder,'termlook-settings-'+width+'.png')});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=0,'settings fit '+width);
 // From 设置 too, and the app theme stays put there.
 await choose(page,'终端按键和控件','跟随屏幕');await page.waitForFunction(()=>nx.prefs.termLook==='screen');
 assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');
 await page.context().close();}
console.log('PASS: 终端选项 and 设置 change the look on the spot and agree');

// 3b. The key bar: what stays put and what swipes read apart, in two rows and with the keyboard up, and still fit.
for(const [width,height,rows] of [[390,844,2],[390,460,1],[320,640,2],[320,380,1]]){
 const tag=width+'x'+height,page=await fresh('light',{},width,height);await openSsh(page);await page.waitForTimeout(150);
 const s=await page.evaluate(()=>{document.getAnimations().forEach(a=>a.finish());
  const m=document.querySelector('.tk-mods'),p=document.querySelector('.tk-pager'),page=p.querySelector('.tk-page'),box=n=>n.getBoundingClientRect();
  return {two:document.querySelector('.tk-bar').classList.contains('two-rows'),line:getComputedStyle(m,':after').width,gap:box(p).left-box(m).right,
   mod:getComputedStyle(m.querySelector('.key')).backgroundColor,key:getComputedStyle(page.querySelector('.key')).backgroundColor,
   small:[...m.querySelectorAll('.key'),...page.querySelectorAll('.key')].filter(k=>box(k).width&&(box(k).width<44||box(k).height<44)).map(k=>k.textContent+' '+box(k).width),
   left:box(m).left,right:innerWidth-Math.max(...[...page.querySelectorAll('.key')].map(k=>box(k).right)),dots:box(document.querySelector('.tk-dots')).left-box(p).left,dot:Math.min(...[...document.querySelectorAll('.tk-dots i')].map(i=>box(i).width))};});
 assert.equal(s.two,rows===2,tag+': rows');
 assert.equal(s.line,'1px',tag+': a line between them');assert.ok(s.gap>=10,tag+': room around the line '+s.gap);
 assert.equal(s.mod,'rgba(0, 0, 0, 0)',tag+': pinned keys are outlined');assert.notEqual(s.key,s.mod,tag+': paged keys are filled');
 assert.deepEqual(s.small,[],tag+': still 44 px targets');
 assert.ok(Math.abs(s.left-s.right)<=1,tag+': same inset both sides '+s.left+'/'+s.right);
 assert.ok(Math.abs(s.dots)<=1,tag+': the dots belong to the pages '+s.dots);
 assert.ok(s.dot>=4.5,tag+': dots keep their shape '+s.dot);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=0,tag+': fits');
 await page.locator('.tk-bar').screenshot({path:path.join(folder,'termlook-keys-'+tag+'.png')});
 await page.context().close();}
{const page=await fresh('light',{termScreen:'light'},390,460);await openSsh(page);await page.waitForTimeout(150);
 await page.locator('.tk-bar').screenshot({path:path.join(folder,'termlook-keys-light.png')});await page.context().close();}
console.log('PASS: the key bar tells pinned keys from the pages');

// 4. A light screen stays readable: the palette, and whatever colours a program asks for.
{const page=await fresh('dark',{termScreen:'light'});
 const r=await page.evaluate(()=>{const P=ansiPalette(),low=P.pal.map((c,i)=>[i,ansiContrast(c,P.bg)]).filter(x=>x[1]<4.5);
  const box=document.createElement('pre');box.className='agent-terminal';document.body.append(box);
  ansiRender(box,'\x1b[38;2;245;245;245mpale\x1b[0m \x1b[97mbright\x1b[0m \x1b[37mwhite\x1b[0m \x1b[33myellow\x1b[0m \x1b[2mdim\x1b[0m');
  const runs=[...box.querySelectorAll('span')].filter(n=>n.textContent.trim()).map(n=>{const m=getComputedStyle(n).color.match(/\d+/g).slice(0,3).map(Number);return [n.textContent,Math.round(ansiContrast(m,P.bg)*10)/10];});
  const out={bg:getComputedStyle(box).backgroundColor,ink:getComputedStyle(box).color,low,runs};box.remove();return out;});
 assert.equal(r.bg,WHITE,'read-only screens use the light screen');assert.equal(r.ink,'rgb(28, 27, 25)');
 assert.deepEqual(r.low,[],'palette reads on white');
 for(const [t,c] of r.runs)assert.ok(c>=(t==='dim'?2.5:4),t+' contrast '+c);
 await page.context().close();
 console.log('PASS: a light screen keeps every colour readable');}

// 5. A read-only pane repaints its colours at once; the chat card and confirm screen use the setting
// while the chat itself keeps the app theme; the file viewer's stage is not a terminal.
{const page=await fresh('light');await nav(page,'终端');
 await page.getByRole('button',{name:/开发终端/}).click();
 await page.evaluate(()=>{T.view.ansi='\x1b[38;2;245;245;245mpale\x1b[0m';renderTerminal();});
 const colour=()=>page.$eval('#pane-screen span',n=>getComputedStyle(n).color);
 assert.equal(await colour(),'rgb(245, 245, 245)','pale text reads on the dark screen');
 await page.getByRole('button',{name:'终端选项',exact:true}).click();await choose(page,'终端屏幕','浅色');
 await page.waitForFunction(()=>document.documentElement.dataset.term==='light');
 assert.notEqual(await colour(),'rgb(245, 245, 245)','repainted for the light screen, no poll needed');
 await page.getByRole('button',{name:'关闭',exact:true}).click();await leave(page);
 await nav(page,'会话');await page.getByRole('button',{name:/把移动端做成真正的聊天工具/}).click();
 await page.getByRole('button',{name:'终端',exact:true}).click();await page.locator('#terminal-output').waitFor();
 assert.equal(await page.locator('.term-card').evaluate(n=>getComputedStyle(n).backgroundColor),WHITE,'chat 终端 card');
 assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light','a chat keeps the app theme');
 const stage=t=>page.evaluate(t=>{document.documentElement.dataset.theme=t;const n=document.createElement('div');n.className='fx-stage';document.body.append(n);const c=getComputedStyle(n).backgroundColor;n.remove();return c;},t);
 assert.equal(await stage('light'),CARD,'file viewer stays dark with a light terminal');
 assert.equal(await stage('dark'),'rgb(11, 11, 10)');
 await page.context().close();
 console.log('PASS: read-only screens follow the screen setting; the file viewer does not');}

await browser.close();
assert.deepEqual(errors,[],'no page errors');
console.log('ALL PASS: terminal look');
})().catch(e=>{console.error(e);process.exit(1);});
