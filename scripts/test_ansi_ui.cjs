// Colored terminal screens (ansi.js): the chat 「终端」 tab and the confirm panel.
//  · Reads ask for color (`ansi: true`) only while the 终端 tab or the confirm screen shows.
//  · Colors land as inline styles (16 / 256 / truecolor), dark colors are lifted to stay readable.
//  · Rule rows (────) are one rule that fits; padded rows with a background stay full-width bands;
//    trailing padding is gone; 「原始宽度」 keeps the desktop layout and is remembered.
//  · ⏵ ⏸ ⎿ … come from the bundled glyph font, one cell wide. No HTML is ever inserted.
// Fixtures: tests/fixtures/*.ansi (shapes of real Herdr 0.8.2 reads, made-up text), run through the
// real bridge (clean_ansi + ansi_with_scrollback). 320 / 390 wide, light and dark.
const {chromium}=require('playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const SCREENS=JSON.parse(execFileSync('python3',['-c',`
import importlib.util,json,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('b',sys.argv[1]);b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
fx=Path(sys.argv[2]);out={}
for name in ('claude_screen','codex_screen','claude_blocked','codex_blocked'):
    screen=b.clean_ansi((fx/(name+'.ansi')).read_bytes().decode())
    rows=[r.rstrip() for r in b.strip_sgr(screen).split('\\n')]
    while rows and not rows[-1]: rows.pop()
    text=(fx/'claude_recent.txt').read_text() if name=='claude_screen' else '\\n'.join(rows)+'\\n'
    out[name]={'text':text,'ansi':b.ansi_with_scrollback(text,screen),'menu':b.parse_menu(text,name.split('_')[0])}
print(json.dumps(out,ensure_ascii=False))`,path.join(root,'bridge/pocket_bridge.py'),path.join(root,'tests/fixtures')],{encoding:'utf8'}));
const shots=process.env.SHOTS||path.join(root,'ui-artifacts');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
fs.mkdirSync(shots,{recursive:true});
const errors=[];
async function fresh({width=390,height=844,dark=false}={}){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:2,colorScheme:dark?'dark':'light'});
 const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{window.cacheStore=new Map();
  window.PocketNative={request(id,op,raw){if(!['devices','demo','disconnect','protect','watchState','settings','cacheGet','cachePut'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);
   const a=JSON.parse(raw||'{}');let data=op==='devices'?{devices:[]}:{};
   if(op==='cachePut')cacheStore.set(a.key,a.value);if(op==='cacheGet')data={value:cacheStore.get(a.key)||null};
   setTimeout(()=>nativeResult(id,{ok:true,data}),0);}};});
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 if(dark)await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 await page.getByText('离线演示 · 示例数据，不连接电脑',{exact:true}).waitFor();
 await page.evaluate(SCREENS=>{
  window.fx={calls:[],screens:SCREENS,agents:[]};
  remote=async(op,args={})=>{fx.calls.push({op,args});await new Promise(r=>setTimeout(r,20));
   if(op==='sessions')return{sessions:[{name:'fixture',running:true}]};
   if(op==='agents'||op==='status')return{agents:fx.agents};
   if(op==='history'){const a=fx.agents.find(x=>x.history_ref.record.id===args.record_id);return{record:a.history_ref.record,messages:[{id:'1:0',kind:'user',text:'看看终端',title:'',call_id:'',timestamp:new Date().toISOString()}],children:[],before:0,has_more:false};}
   if(op==='read'){const a=fx.agents.find(x=>x.pane_id===args.target),s=SCREENS[a.screen];
    return{text:s.text,agent_status:a.agent_status,...(args.ansi===true?{ansi:s.ansi}:{}),...(a.agent_status==='blocked'?{menu:s.menu}:{})};}
   if(op==='glance')return{previews:{}};
   return {};};
  window.agent=(id,provider,status,screen)=>({pane_id:'w1:'+id,identity:'id-'+id,agent:provider,agent_status:status,cwd:'/home/demo/site',terminal_title:'任务 '+id,agent_session:{value:'t-'+id},screen,
   history_ref:{status:'matched',record_id:'rec-'+id,thread:'t-'+id,record:{id:'rec-'+id,thread:'t-'+id,provider,title:'任务 '+id,cwd:'/home/demo/site',modified:Date.now()/1000}}});
  S.demo=false;S.session='fixture';S.device={id:'dev-fixture',name:'工作站',user:'demo',host:'w',port:22};
 },SCREENS);
 return page;}
const reads=page=>page.evaluate(()=>fx.calls.filter(c=>c.op==='read').map(c=>c.args));
const overflow=page=>page.evaluate(()=>document.scrollingElement.scrollWidth-innerWidth);
async function openTerminal(page,id,provider,screen){
 await page.evaluate(([id,provider,screen])=>{const a=agent(id,provider,'done',screen);fx.agents=[a];S.agents=[a];openAgent(a);},[id,provider,screen]);
 await page.getByRole('button',{name:'终端',exact:true}).click();
 await page.locator('#terminal-output.ansi .ansi-line').first().waitFor();await page.waitForTimeout(150);}

// No HTML insertion anywhere in the renderer.
const src=fs.readFileSync(path.join(root,'app/src/main/assets/ui/ansi.js'),'utf8');
assert.doesNotMatch(src,/innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser/);

for(const [width,height,dark] of [[390,844,false],[390,844,true],[320,640,false],[320,640,true]]){
 const tag=width+(dark?'-dark':'-light');
 // ── 1. Claude in the 终端 tab ──
 {const page=await fresh({width,height,dark});
  // Conversation view: a working agent's activity reads stay plain.
  await page.evaluate(()=>{const a=agent('cl','claude','working','claude_screen');fx.agents=[a];S.agents=[a];openAgent(a);});
  await page.waitForFunction(()=>fx.calls.some(c=>c.op==='read'),null,{timeout:8000});
  assert.ok((await reads(page)).every(a=>!a.ansi),'conversation reads stay plain');
  await page.evaluate(()=>{fx.agents[0].agent_status='done';S.chat.agent={...S.chat.agent,agent_status:'done'};});
  await page.getByRole('button',{name:'终端',exact:true}).click();
  await page.locator('#terminal-output.ansi .ansi-line').first().waitFor();
  assert.equal((await reads(page)).at(-1).ansi,true,'the 终端 tab asks for color');
  const out=page.locator('#terminal-output');
  const info=await out.evaluate(n=>{
   const spans=[...n.querySelectorAll('span')];const find=t=>spans.find(s=>s.textContent.includes(t));
   const cs=x=>x&&getComputedStyle(x);
   const prompt=[...n.querySelectorAll('.ansi-line')].find(l=>l.textContent.startsWith('❯ 好，顺手'));
   const rules=[...n.querySelectorAll('.ansi-rule')];
   const line=t=>[...n.querySelectorAll('.ansi-line')].find(l=>l.textContent.startsWith(t));
   return {bullet:cs(line('● Update(')?.querySelector('span'))?.color,update:cs(find('Update'))?.fontWeight,code:cs(spans.find(s=>s.textContent==='test_status_poll_is_cheap'))?.color,
    fail:cs(find('FAIL:'))?.color,mode:cs(find('bypass permissions'))?.color,
    promptBand:prompt?.classList.contains('band'),promptBg:cs(prompt)?.backgroundColor,promptText:prompt?.textContent,
    rules:rules.length,ruleH:rules.map(r=>r.getBoundingClientRect().height),ruleW:rules.map(r=>r.getBoundingClientRect().right<=n.getBoundingClientRect().right+1),
    lineH:parseFloat(getComputedStyle(n).lineHeight),scroll:n.scrollWidth-n.clientWidth,
    trailing:[...n.querySelectorAll('.ansi-line')].filter(l=>/ $/.test(l.textContent)).length,
    history:n.textContent.includes('列表页的轮询太频繁了'),imgs:n.querySelectorAll('img,script').length,
    diff:cs(find('-const POLL_BEAT=2500;'))?.backgroundColor};});
  assert.equal(info.bullet,'rgb(135, 215, 135)','256-color green bullet');
  assert.equal(info.update,'650','bold');
  assert.equal(info.code,'rgb(175, 215, 255)','inline code color');
  assert.equal(info.mode,'rgb(255, 135, 175)','mode line color');
  assert.ok(info.fail,'error line colored');
  assert.ok(info.promptBand,'the prompt row is a band');assert.equal(info.promptBg,'rgb(58, 58, 58)');
  assert.equal(info.promptText,'❯ 好，顺手把通知的文案也看一下','padding trimmed');
  assert.equal(info.trailing,0,'no trailing padding anywhere');
  assert.equal(info.rules,2,'each ──── row is one rule');
  for(const h of info.ruleH)assert.ok(h<=info.lineH+1,'rule fits one line: '+h);
  assert.ok(info.ruleW.every(Boolean),'rules fit the width');
  assert.ok(info.scroll<=1,'wrapped view does not scroll sideways');
  assert.ok(info.history,'plain history above the colored screen');
  assert.equal(info.imgs,0);
  assert.equal(info.diff,'rgb(95, 0, 0)','diff background');
  // ⏵ ⏸ ⎿: the bundled glyph font covers them, one monospace cell wide.
  const glyph=await page.evaluate(async()=>{const faces=await document.fonts.load('13px "Pocket Term Glyphs"','⏵⏸⎿');
   const box=document.getElementById('terminal-output');const a=document.createElement('span'),b=document.createElement('span');a.textContent='⏵⏵⏸⎿';b.textContent='abcd';box.append(a,b);
   const w=[a.getBoundingClientRect().width,b.getBoundingClientRect().width];a.remove();b.remove();return {faces:faces.length,w};});
  assert.equal(glyph.faces,1,'glyph font covers ⏵ ⏸ ⎿');
  assert.ok(Math.abs(glyph.w[0]-glyph.w[1])<1.5,'glyphs are one cell wide: '+glyph.w);
  // Dark colors are lifted against the card; hostile text stays text.
  const contrast=await page.evaluate(()=>{const n=document.createElement('pre');n.className='agent-terminal';document.querySelector('.term-card').append(n);
   ansiRender(n,'\x1b[30mblack\x1b[0m \x1b[38;2;12;12;12mnear-black\x1b[0m \x1b[2;38;5;236mdim gray\x1b[0m <img src=x onerror="window.pwned=1">');
   const P=ansiPalette();const r=[...n.querySelectorAll('span')].map(s=>ansiContrast(getComputedStyle(s).color.match(/\d+/g).map(Number),P.bg));
   const out={r,img:n.querySelectorAll('img').length,text:n.textContent};n.remove();return out;});
  assert.ok(contrast.r[0]>=4&&contrast.r[1]>=4,'dark colors readable: '+contrast.r);assert.ok(contrast.r[2]>=2.5,'dim stays legible: '+contrast.r);
  assert.equal(contrast.img,0);assert.match(contrast.text,/<img src=x/);
  assert.ok(await overflow(page)<=0,'no page overflow');
  await page.screenshot({path:path.join(shots,'ansi-claude-'+tag+'.png')});
  // 「原始宽度」: no wrapping, sideways scroll, remembered.
  const raw=page.getByRole('button',{name:'原始宽度',exact:true});
  assert.equal(await raw.getAttribute('aria-pressed'),'false');await raw.click();
  assert.equal(await raw.getAttribute('aria-pressed'),'true');
  const r2=await out.evaluate(n=>({raw:n.classList.contains('raw'),scroll:n.scrollWidth-n.clientWidth,
   one:[...n.querySelectorAll('.ansi-line')].find(l=>l.textContent.includes('ui checks passed')).getBoundingClientRect().height,lh:parseFloat(getComputedStyle(n).lineHeight),
}));
  assert.ok(r2.raw&&r2.scroll>50,'raw width scrolls sideways');assert.ok(r2.one<=r2.lh+1,'long line stays one row');
  await page.waitForFunction(()=>cacheStore.get('term:raw')?.raw===true,null,{timeout:5000});
  assert.ok(await overflow(page)<=0,'raw mode: no page overflow');
  if(width===390&&!dark)await page.screenshot({path:path.join(shots,'ansi-claude-raw.png')});
  await page.evaluate(()=>renderChat());await page.locator('#terminal-output.ansi').waitFor();
  assert.equal(await page.getByRole('button',{name:'原始宽度',exact:true}).getAttribute('aria-pressed'),'true','remembered');
  await page.getByRole('button',{name:'原始宽度',exact:true}).click();
  assert.equal(await out.evaluate(n=>n.classList.contains('raw')),false);
  await page.context().close();}

 // ── 2. Codex (truecolor) in the 终端 tab ──
 {const page=await fresh({width,height,dark});await openTerminal(page,'cx','codex','codex_screen');
  const info=await page.locator('#terminal-output').evaluate(n=>{const spans=[...n.querySelectorAll('span')];const find=t=>spans.find(s=>s.textContent.includes(t));
   const bands=[...n.querySelectorAll('.ansi-line.band')];const lab=n.querySelector('.ansi-rule.labeled');
   return {ctx:find('Context 38% used')&&getComputedStyle(find('Context 38% used')).color,bands:bands.length,
    bandFull:bands.every(b=>Math.abs(b.getBoundingClientRect().width-(n.clientWidth-28))<2),label:lab?.textContent,strike:find('读取彩色终端画面')&&getComputedStyle(find('读取彩色终端画面')).textDecorationLine};});
  assert.equal(info.ctx,'rgb(242, 181, 144)','truecolor');
  assert.equal(info.bands,3,'the input box rows are bands');assert.ok(info.bandFull,'bands span the screen');
  assert.equal(info.label,'Worked for 6m 02s','labeled rule');
  assert.equal(info.strike,'line-through');
  assert.ok(await overflow(page)<=0);
  await page.screenshot({path:path.join(shots,'ansi-codex-'+tag+'.png')});
  await page.context().close();}

 // ── 3. Confirm screens ──
 for(const [provider,screen] of [['claude','claude_blocked'],['codex','codex_blocked']]){
  const page=await fresh({width,height,dark});
  await page.evaluate(([provider,screen])=>{const a=agent('b'+provider,provider,'blocked',screen);fx.agents=[a];S.agents=[a];openAgent(a);},[provider,screen]);
  await page.evaluate(async()=>{await fetchTerminal(true);S.chat.qaRaw=true;renderComposer();});
  const scr=page.locator('#confirm-screen.ansi');await scr.waitFor();
  assert.equal((await reads(page)).at(-1).ansi,true,'the confirm screen asks for color');
  const info=await scr.evaluate(n=>({rows:n.children.length,rules:n.querySelectorAll('.ansi-rule').length,
   sel:[...n.querySelectorAll('span')].find(s=>/1\. Yes/.test(s.textContent)),bottom:n.scrollHeight-n.scrollTop-n.clientHeight}));
  assert.ok(info.rows<=12,'last 12 rows');assert.ok(info.bottom<4,'shows the last rows');
  if(provider==='claude')assert.equal(info.rules,1);
  const color=await scr.evaluate(n=>getComputedStyle([...n.querySelectorAll('span')].find(s=>/1\. Yes/.test(s.textContent))).color);
  assert.equal(color,provider==='claude'?'rgb(175, 215, 255)':'rgb(137, 180, 250)','highlighted choice keeps its color');
  assert.ok(await overflow(page)<=0);
  await page.screenshot({path:path.join(shots,'ansi-confirm-'+provider+'-'+tag+'.png')});
  await page.context().close();}
 console.log('PASS: '+tag+': colored 终端 tab (Claude 256 / Codex truecolor), rules, bands, glyphs, 原始宽度, confirm screens');}

// Plain screens (older Herdr without --format ansi) still work.
{const page=await fresh();
 await page.evaluate(()=>{const a=agent('pl','claude','done','claude_screen');fx.agents=[a];S.agents=[a];openAgent(a);
  const real=remote;remote=async(op,args)=>{const r=await real(op,args);if(op==='read')delete r.ansi;return r;};});
 await page.getByRole('button',{name:'终端',exact:true}).click();
 await page.getByText('列表页的轮询太频繁了',{exact:false}).waitFor();
 assert.equal(await page.locator('#terminal-output').evaluate(n=>n.classList.contains('ansi')),false);
 await page.context().close();
 console.log('PASS: plain fallback when the bridge sends no colors');}

assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
