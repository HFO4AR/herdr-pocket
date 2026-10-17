// Tablet two-pane layout (layout.js): list and conversation side by side on wide screens,
// back closes the chat to a placeholder, rotation keeps the open chat and the draft.
// Offline: native SSH is a fake that serves a fixed set of agents and histories.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=path.join(root,'ui-artifacts');fs.mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const errors=[];

async function open(width,height,theme){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{
  const now=Date.now()/1000,iso=s=>new Date((now-s)*1000).toISOString();
  const rec=(id,title,provider,age)=>({id,thread:'t-'+id,title,provider,parent:null,cwd:'/work/'+id,modified:now-age});
  const R={r1:rec('r1','整理发布脚本','claude',60),r2:rec('r2','修复登录超时','codex',600),r3:rec('r3','清理旧日志','codex',3600),r4:rec('r4','写周报','claude',86400*2)};
  let n=10;const msg=(kind,text,age)=>({id:(++n)+':0',kind,text,title:'',call_id:'',timestamp:iso(age)});
  const H={};for(const id of Object.keys(R)){H[id]=[];for(let i=0;i<14;i++){H[id].push(msg('user',R[id].title+' · 第 '+(i+1)+' 个问题，说得长一点，好让对话能滚动起来。',900-i*60));H[id].push(msg('assistant',R[id].title+' · 第 '+(i+1)+' 条回复。\n\n- 先看现状\n- 再改代码\n- 最后跑测试',880-i*60));}}
  const ref=r=>({status:'matched',source:'native-process',record_id:r.id,thread:r.thread,record:r});
  const agent=(i,r,st)=>({pane_id:'w1:p'+i,terminal_id:'term'+i,agent:r.provider,agent_status:st,identity:'id-'+i,cwd:r.cwd,title:r.title,history_ref:ref(r)});
  window.fx={R,H,history:[],list:[agent(1,R.r1,'idle'),agent(2,R.r2,'idle'),agent(3,R.r3,'blocked')]};
  const device={id:'fx',name:'平板测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
  const strip=a=>{const {history_ref,...rest}=a;return rest;};
  window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};
   try{
    if(op==='devices')data={devices:[device],version:'test',connected:device};
    else if(op==='remote'){
     if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
     else if(a.op==='agents')data={agents:fx.list};
     else if(a.op==='status')data={agents:fx.list.map(strip)};
     else if(a.op==='history'){fx.history.push(a.record_id);data={record:fx.R[a.record_id],messages:fx.H[a.record_id]||[],before:0,has_more:false,children:[]};}
     else if(a.op==='read')data={text:'$ '};
     else if(a.op==='catalog')data={records:Object.values(fx.R),total:4,next:null};
     else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
     else if(a.op==='glance')data={agents:[]};
     else throw Error('unexpected remote op '+a.op);}
    else if(!['watchState','protect','setAlerts','settings','cacheGet','cachePut','cacheList'].includes(op))throw Error('unexpected native op '+op);
   }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),5);return;}
   setTimeout(()=>nativeResult(id,{ok:true,data}),5);}};
 });
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
 return page;}

const row=(page,title)=>page.locator('.wide-list .card-button').filter({hasText:title});
const box=page=>page.getByRole('textbox',{name:'消息输入框',exact:true});
const overflow=page=>page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
const shot=async(page,name)=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(250);await page.screenshot({path:path.join(shots,'tablet-'+name+'.png')});};

for(const [w,h] of [[1024,768],[1280,800]])for(const theme of ['light','dark']){
 const tag=w+'-'+theme,page=await open(w,h,theme);
 // Live list on the left, placeholder on the right, navigation as a rail.
 await row(page,'整理发布脚本').waitFor();
 assert.equal(await page.locator('.wide-frame[data-mode="split"]').count(),1,'two panes on '+tag);
 assert.equal(await page.locator('.wide-rail .nav-item').count(),5,'rail has the five tabs');
 await page.getByRole('heading',{name:'选一个会话'}).waitFor();
 assert.equal(await page.locator('.wide-wait-row').count(),1,'placeholder lists the agent that waits for you');
 assert.ok(await overflow(page)<=0,'no horizontal scroll on '+tag);
 await shot(page,tag+'-empty');

 // Opening a chat keeps the list and marks the row.
 await row(page,'整理发布脚本').click();
 await page.getByText('整理发布脚本 · 第 14 条回复。').first().waitFor();
 assert.ok(await row(page,'修复登录超时').isVisible(),'list stays visible with a chat open');
 assert.equal(await row(page,'整理发布脚本').getAttribute('aria-current'),'true','open row is highlighted');
 assert.equal(await page.locator('.wide-list [aria-current="true"]').count(),1,'only one row is highlighted');
 assert.ok(await page.getByRole('button',{name:'关闭对话',exact:true}).isVisible(),'header button closes the chat');
 assert.equal(await page.getByRole('button',{name:'返回列表',exact:true}).count(),0);
 await box(page).fill('平板上的草稿');
 const reads=await page.evaluate(()=>fx.history.length);
 await row(page,'整理发布脚本').click();await page.waitForTimeout(150);
 assert.equal(await page.evaluate(()=>fx.history.length),reads,'tapping the open row does not reload it');
 assert.equal(await box(page).inputValue(),'平板上的草稿');
 await shot(page,tag+'-chat');

 // Switching chats from the list; the draft waits for its own chat.
 await row(page,'修复登录超时').click();
 await page.getByText('修复登录超时 · 第 14 条回复。').first().waitFor();
 assert.equal(await row(page,'修复登录超时').getAttribute('aria-current'),'true');
 assert.equal(await row(page,'整理发布脚本').getAttribute('aria-current'),null);
 assert.equal(await box(page).inputValue(),'');
 await row(page,'整理发布脚本').click();
 await page.getByText('整理发布脚本 · 第 14 条回复。').first().waitFor();
 assert.equal(await box(page).inputValue(),'平板上的草稿','draft is back with its chat');

 // A status change repaints the list beside the open chat without touching the chat.
 await page.evaluate(async()=>{fx.list=fx.list.map(a=>a.identity==='id-2'?{...a,agent_status:'working'}:a);S.statusBusy=false;await refreshStatus();});
 await page.locator('.wide-list .group-label').filter({hasText:'执行中'}).waitFor();
 assert.equal(await box(page).inputValue(),'平板上的草稿','status repaint keeps the draft');
 assert.equal(await row(page,'整理发布脚本').getAttribute('aria-current'),'true','status repaint keeps the highlight');

 // Back (Android back / header button) closes the chat to the placeholder; the list stays.
 await page.evaluate(()=>pocketBack());
 await page.getByRole('heading',{name:'选一个会话'}).waitFor();
 assert.ok(await row(page,'整理发布脚本').isVisible(),'back keeps the list');
 assert.equal(await page.locator('.wide-list [aria-current="true"]').count(),0,'nothing highlighted after closing');
 await row(page,'整理发布脚本').click();
 await page.getByRole('button',{name:'关闭对话',exact:true}).click();
 await page.getByRole('heading',{name:'选一个会话'}).waitFor();

 // Rotation: two panes → phone → two panes keeps the open chat, the draft and the position.
 await row(page,'整理发布脚本').click();
 await page.getByText('整理发布脚本 · 第 14 条回复。').first().waitFor();
 await box(page).fill('转屏前写的');
 // Read from the middle: the 8th turn at the top of the view.
 const pick=await page.evaluate(()=>{const n=document.getElementById('chat-scroll'),t=n.querySelectorAll('.timeline > section.turn')[7];n.scrollTop+=t.getBoundingClientRect().top-n.getBoundingClientRect().top+12;n.dispatchEvent(new Event('scroll'));return t.dataset.id;});
 const gap=()=>page.evaluate(id=>{const n=document.getElementById('chat-scroll'),t=n.querySelector('section.turn[data-id="'+id+'"]');return Math.round(t.getBoundingClientRect().top-n.getBoundingClientRect().top);},pick);
 await page.waitForTimeout(100);assert.equal(await gap(),-12);
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'返回列表',exact:true}).waitFor();
 assert.equal(await page.locator('.wide-frame').count(),0,'phone width is single-pane');
 assert.equal(await page.locator('.bottom-nav').count(),0,'phone chat is full screen');
 assert.equal(await box(page).inputValue(),'转屏前写的','draft survives rotation');
 assert.ok(Math.abs(await gap()+12)<=2,'reading position survives rotation');
 assert.ok(await overflow(page)<=0,'no horizontal scroll at phone width');
 await page.setViewportSize({width:w,height:h});
 await page.getByRole('button',{name:'关闭对话',exact:true}).waitFor();
 assert.ok(await row(page,'修复登录超时').isVisible(),'list is back beside the chat');
 assert.equal(await row(page,'整理发布脚本').getAttribute('aria-current'),'true');
 assert.equal(await box(page).inputValue(),'转屏前写的','draft survives rotating back');
 assert.ok(Math.abs(await gap()+12)<=2,'position survives rotating back');

 // History: same pattern, read-only.
 await page.getByRole('button',{name:'历史',exact:true}).click();
 await page.getByRole('heading',{name:'选一条历史'}).waitFor();
 await row(page,'写周报').click();
 await page.getByText('写周报 · 第 14 条回复。').first().waitFor();
 assert.equal(await row(page,'写周报').getAttribute('aria-current'),'true');
 assert.ok(await row(page,'清理旧日志').isVisible());
 await shot(page,tag+'-history');
 await page.evaluate(()=>pocketBack());
 await page.getByRole('heading',{name:'选一条历史'}).waitFor();

 // One-column tabs use the rail and a centred column.
 await page.getByRole('button',{name:'设置',exact:true}).click();
 assert.equal(await page.locator('.wide-frame[data-mode="solo"]').count(),1);
 assert.ok(await overflow(page)<=0);
 if(theme==='light')await shot(page,tag+'-settings');
 // A chat opened from elsewhere (e.g. a notification) takes the space next to the rail.
 await page.evaluate(()=>openAgent(S.agents.find(a=>a.identity==='id-2')));
 await page.getByText('修复登录超时 · 第 14 条回复。').first().waitFor();
 assert.equal(await page.locator('.wide-frame[data-mode="focus"]').count(),1);
 assert.ok(await page.locator('.wide-rail .nav-item').first().isVisible(),'rail stays');
 await page.evaluate(()=>pocketBack());
 await page.locator('.wide-frame[data-mode="solo"]').waitFor();
 await page.close();}

// Every size the app is used at: each page fits, keeps a readable column and uses the width.
// 768×1024 (portrait tablet) is one pane with the bottom bar; 1600×1000 gives the list more room.
const box2=(page,sel)=>page.evaluate(sel=>{const r=document.querySelector(sel)?.getBoundingClientRect();return r?{l:Math.round(r.left),r:Math.round(r.right),w:Math.round(r.width),t:Math.round(r.top)}:null;},sel);
for(const [w,h] of [[768,1024],[1024,768],[1280,800],[1600,1000]])for(const theme of ['light','dark']){
 const tag=w+'x'+h+'-'+theme,page=await open(w,h,theme),wide=w>=840;
 const pick=()=>page.locator(wide?'.wide-list .card-button':'.card-button').filter({hasText:'整理发布脚本'});
 await pick().waitFor();
 assert.equal(await page.locator('.wide-frame').count(),wide?1:0,'panes at '+tag);
 if(w===1600)assert.equal((await box2(page,'.wide-list')).w,440,'the list gets more room on a very wide screen');
 assert.ok(await overflow(page)<=0,'no horizontal scroll: '+tag);
 await shot(page,tag+'-list');
 await pick().click();await page.getByText('整理发布脚本 · 第 14 条回复。').first().waitFor();
 // One reading column: timeline ≤ 780 px; the rail and the composer share its edges; on a wide pane
 // the header's first button starts where the conversation does.
 const tl=await box2(page,'.timeline'),comp=await box2(page,'#composer .composer');
 assert.ok(tl.w<=780,'timeline width '+tl.w);
 assert.ok(Math.abs(tl.l-comp.l)<=30&&Math.abs(tl.r-comp.r)<=30,'composer under the reading column: '+JSON.stringify([tl,comp]));
 if(w===1600){const head=await box2(page,'#chat-head > .icon-btn');assert.ok(Math.abs(head.l-tl.l)<=30,'header lines up: '+JSON.stringify([head,tl]));}
 assert.ok(await overflow(page)<=0);
 await shot(page,tag+'-chat');
 // Sheets are centred dialogs once there is room.
 await page.evaluate(()=>agentSwitcher());const sh=await box2(page,'#overlay .sheet');
 assert.ok(sh.w<=640&&Math.abs((sh.l+sh.r)/2-w/2)<=(wide?w:2),'sheet as a dialog: '+JSON.stringify(sh));
 if(theme==='light')await shot(page,tag+'-sheet');
 await page.evaluate(()=>closeSheet());
 // Settings: two columns of groups on wide one-column pages, one column below that.
 await page.evaluate(()=>{pocketBack();setTab('settings');});await page.locator('.set-col').first().waitFor();
 const cols=await page.evaluate(()=>[...document.querySelectorAll('.set-col')].map(c=>Math.round(c.getBoundingClientRect().left)));
 assert.equal(cols[0]!==cols[1],w>=1180,'settings columns at '+tag+': '+cols);
 assert.ok(await overflow(page)<=0);
 await shot(page,tag+'-settings');
 for(const t of ['devices','terminals','history']){await page.evaluate(t=>setTab(t),t);await page.waitForTimeout(250);assert.ok(await overflow(page)<=0,t+' fits at '+tag);if(theme==='light'&&w>=1280)await shot(page,tag+'-'+t);}
 await page.close();}

// Landscape phones stay single-pane even though they are wider than 840 px.
{const page=await open(844,390,'light');
 await page.locator('.card-button').filter({hasText:'整理发布脚本'}).waitFor();
 assert.equal(await page.locator('.wide-frame').count(),0,'landscape phone is single-pane');
 assert.equal(await page.locator('.bottom-nav').count(),1);
 await page.close();}

await browser.close();
assert.deepEqual(errors,[],'no page errors');
console.log('PASS: tablet two-pane layout');
})().catch(e=>{console.error(e);process.exit(1);});
