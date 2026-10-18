// Quick rename (rename.js): tapping the chat title opens a small sheet; 保存 sends exactly
// "/rename <name>" through the normal send path (direct, queued while busy, refused on a menu,
// unknown outcomes never resent), the header shows the new name with a quiet state and keeps it once
// the terminal title or Claude's transcript confirms it, otherwise it goes back and says so.
// Offline: native SSH is a strict fake that records every request.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=path.join(root,'ui-artifacts');fs.mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 const now=Date.now()/1000,iso=s=>new Date((now-s)*1000).toISOString();
 const rec=(id,thread,title,provider)=>({id,thread,title,provider,parent:null,cwd:'/work/proj',modified:now-60});
 const R={r1:rec('r1','t1','整理发布脚本','claude'),r2:rec('r2','t2','修一下登录','codex')};
 let n=50;const msg=(kind,text,age=30)=>({id:(++n)+':0',kind,text,title:'',call_id:'',timestamp:iso(age)});
 const H={r1:[msg('user','把发布脚本整理一下',400),msg('assistant','好，整理完了。',390)],r2:[msg('user','修一下登录',200),msg('assistant','修好了。',190)]};
 const ref=r=>({status:'matched',source:'native-process',record_id:r.id,thread:r.thread,record:r});
 // Titles as the agents set them (checked live): Claude "✳ <name>", Codex "<name> | <dir>".
 const A1={pane_id:'w1:p1',terminal_id:'term1',agent:'claude',agent_status:'idle',identity:'id-1',cwd:'/work/proj',terminal_title:'✳ 整理发布脚本',terminal_title_stripped:'整理发布脚本',history_ref:ref(R.r1)};
 const A2={pane_id:'w1:p2',terminal_id:'term2',agent:'codex',agent_status:'idle',identity:'id-2',cwd:'/work/proj',terminal_title:'修登录 | proj',terminal_title_stripped:'修登录 | proj',history_ref:ref(R.r2)};
 const A3={pane_id:'w1:p3',terminal_id:'term3',agent:'opencode',agent_status:'idle',identity:'id-3',cwd:'/work/oc',terminal_title:'OpenCode',terminal_title_stripped:'OpenCode'};
 const IDLE='❯ \n  ? for shortcuts';
 window.fx={R,H,A1,A2,A3,list:[A1,A2,A3],screen:IDLE,IDLE,prompts:[],promptError:'',onPrompt:null,msg};
 const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
 const strip=a=>{const {history_ref,...rest}=a;return rest;};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};
  try{
  if(op==='devices')data={devices:[device],version:'test',connected:device};
  else if(op==='remote'){
   if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
   else if(a.op==='agents'){if(a.target){const row=fx.list.find(x=>x.pane_id===a.target);data=row?{follow:true,state:'same',agents:[row],pane:null}:{follow:true,state:'gone',agents:[],pane:null};}else data={agents:fx.list};}
   else if(a.op==='status')data={agents:fx.list.map(strip)};
   else if(a.op==='history')data={record:Object.values(R).find(r=>r.id===a.record_id),messages:H[a.record_id]||[],before:0,has_more:false,children:[]};
   else if(a.op==='read'){const row=fx.list.find(x=>x.pane_id===a.target);data={text:fx.screen,agent_status:row?.agent_status,...(a.menu===true?{menu:null}:{})};}
   else if(a.op==='commands')data={commands:[]};
   else if(a.op==='prompt'){fx.prompts.push(a);if(fx.promptError)throw Error(fx.promptError);if(fx.onPrompt)fx.onPrompt(a);data={sent:true,receipt:a.id,verified:true,replaced:false};}
   else if(a.op==='key')data={sent:true,receipt:a.id};
   else if(a.op==='catalog')data={records:[],total:0,next:null};
   else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
   else if(a.op==='glance')data={agents:[]};
   else throw Error('unexpected remote op '+a.op);}
  else if(!['watchState','protect','setAlerts','dropImages'].includes(op))throw Error('unexpected native op '+op);
  }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
  setTimeout(()=>nativeResult(id,{ok:true,data}),10);}};
});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
await page.evaluate(()=>{window.followInterval=()=>1e9;});
const shot=async name=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(300);await page.screenshot({path:path.join(shots,'rename-'+name+'.png')});};
const theme=t=>page.evaluate(t=>{document.documentElement.dataset.theme=t;},t);
const titleBtn=()=>page.locator('.chat-title-btn');
const h2=()=>page.locator('#chat-head h2').textContent();
const meta=()=>page.locator('#chat-meta').textContent();
const dialog=()=>page.getByRole('dialog',{name:'改标题'});
const field=()=>dialog().getByRole('textbox',{name:'新标题'});
const save=()=>dialog().getByRole('button',{name:'保存',exact:true});
const prompts=()=>page.evaluate(()=>fx.prompts.map(p=>p.text));
const box=()=>page.getByRole('textbox',{name:'消息输入框',exact:true});
const status=async st=>{await page.evaluate(async st=>{fx.list=fx.list.map(a=>a.pane_id==='w1:p1'?{...a,agent_status:st}:a);S.statusBusy=false;await refreshStatus();},st);};
const setTitle=(pane,raw,stripped)=>page.evaluate(([pane,raw,stripped])=>{fx.list=fx.list.map(a=>a.pane_id===pane?{...a,terminal_title:raw,terminal_title_stripped:stripped}:a);},[pane,raw,stripped]);
const toastSaid=re=>page.waitForFunction(re=>new RegExp(re).test(document.getElementById('toast').textContent),re.source,{timeout:8000});
const metaSays=text=>page.waitForFunction(t=>document.getElementById('chat-meta')?.textContent.includes(t),text,{timeout:8000});
const metaGone=text=>page.waitForFunction(t=>!document.getElementById('chat-meta')?.textContent.includes(t),text,{timeout:8000});
const rename=async name=>{await titleBtn().click();await dialog().waitFor();await field().fill(name);await field().press('Enter');await dialog().waitFor({state:'detached'});};

await page.getByRole('button',{name:/整理发布脚本/}).click();
await page.getByText('好，整理完了。').first().waitFor();

// 1. The title is a button with the same look: the heading text is still just the title, a pencil
//    shows the first time, and the hit area covers the subtitle too.
assert.equal(await page.getByRole('button',{name:'改标题：整理发布脚本',exact:true}).count(),1);
assert.equal(await h2(),'整理发布脚本');
assert.equal(await titleBtn().evaluate(b=>b.classList.contains('hint')),true,'first-time pencil');
assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.chat-title-pen')).opacity),'1');
await box().fill('草稿：等会儿再发');
await shot('header-hint');
// A tap on the subtitle lands on the title button (its hit area covers the block).
await page.locator('#chat-meta').click({force:true});
await dialog().waitFor();
await shot('sheet-light');
assert.equal(await field().inputValue(),'整理发布脚本');
assert.deepEqual(await field().evaluate(i=>[document.activeElement===i,i.selectionStart,i.selectionEnd,i.value.length]),[true,0,6,6],'prefilled and selected');
assert.equal(await save().isDisabled(),true,'unchanged: nothing to save');
await field().fill('   ');assert.equal(await save().isDisabled(),true,'empty: nothing to save');
await dialog().getByText('/rename …',{exact:true}).waitFor();
await field().fill('  发布脚本   v2 ');assert.equal(await save().isDisabled(),false);
await dialog().getByText('/rename 发布脚本 v2',{exact:true}).waitFor();
assert(await dialog().getByText(/保存就是给 Claude 发/).isVisible());
// Pasted line breaks become spaces; more than 80 characters are cut.
await field().fill('');await field().evaluate(i=>{const d=new DataTransfer();d.setData('text/plain','第一行\n第二行');i.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));});
assert.equal(await field().inputValue(),'第一行 第二行');
await field().fill('长'.repeat(90));await dialog().getByText(/只保留前 80 个字/).waitFor();
assert.equal(await page.evaluate(()=>renameClean('长'.repeat(90)).length),80);
await dialog().getByRole('button',{name:'取消',exact:true}).click();
await dialog().waitFor({state:'detached'});
assert.equal(await titleBtn().evaluate(b=>b.classList.contains('hint')),false,'the pencil hint retires once used');
assert.equal(await page.evaluate(()=>RN.hint),false);// stored in localStorage when the WebView allows it
assert.deepEqual(await prompts(),[],'cancel sends nothing');
console.log('PASS: title button, same heading text, first-time pencil, subtitle hit area, sheet prefilled/selected, empty/unchanged disabled, trim, newlines, 80 chars, cancel');

// 2. Idle Claude: Enter saves = exactly "/rename <name>", the header shows it with 改名已发出,
//    the draft stays, a 命令输出 card appears; the terminal title confirms it.
await rename('  发布脚本   v2 ');
assert.deepEqual(await prompts(),['/rename 发布脚本 v2']);
assert.equal(await h2(),'发布脚本 v2');
await metaSays('改名已发出');
assert.equal(await box().inputValue(),'草稿：等会儿再发','the composer draft is untouched');
await page.locator('.slash-card').filter({hasText:'/rename 发布脚本 v2'}).first().waitFor();
assert.equal(await page.getByRole('button',{name:'改标题：发布脚本 v2',exact:true}).count(),1);
await shot('sent-light');
await theme('dark');await shot('sent-dark');await theme('light');
await setTitle('w1:p1','✳ 发布脚本 v2','发布脚本 v2');
await metaSays('已改名');
await metaGone('已改名');
assert.equal(await h2(),'发布脚本 v2');
console.log('PASS: Claude direct send, optimistic header with 改名已发出, draft kept, command card, confirmed by terminal title');

// 3. Nothing confirms it: the header goes back and says so.
await page.evaluate(()=>{RN.wait=1500;});
await rename('不会生效的名字');
await metaSays('改名已发出');
await toastSaid(/等了一会儿没看到标题变成「不会生效的名字」/);
assert.equal(await h2(),'发布脚本 v2');
assert.equal(await meta().then(t=>t.includes('改名')),false);
console.log('PASS: no confirmation → back to the old title, honestly');

// 4. Claude's transcript confirms it even when the terminal title does not change (e.g. a ch pane).
await page.evaluate(()=>{RN.wait=10000;fx.onPrompt=a=>{if(a.text==='/rename 从记录确认')fx.H.r1.push(
  fx.msg('user','<command-name>/rename</command-name>\n            <command-message>rename</command-message>\n            <command-args>从记录确认</command-args>',0),
  fx.msg('user','<local-command-stdout>Session renamed to: 从记录确认</local-command-stdout>',0));};});
await rename('从记录确认');
await metaSays('已改名');
assert.equal(await h2(),'从记录确认');
await page.locator('.slash-card.logged').filter({hasText:'Session renamed to: 从记录确认'}).waitFor();
// Claude's command rows are not a prompt waiting for a reply.
assert.equal(await page.evaluate(()=>awaitingReply()),false);
assert(!/正在读取回复|等它开始/.test(await meta()),'no reply is awaited after a slash command');
await metaGone('已改名');
await page.evaluate(()=>{fx.onPrompt=null;});
await setTitle('w1:p1','✳ 从记录确认','从记录确认');
console.log('PASS: confirmed from Claude\'s transcript');

// 5. Busy: it queues (the sheet says so), the header says 改名排队中, and it goes out when it stops.
await status('working');
await page.waitForFunction(()=>S.chat.agent.agent_status==='working');
await titleBtn().click();await dialog().waitFor();
await dialog().getByText('它正在忙，保存后先排队，停下就发').waitFor();
await field().fill('排队里的名字');await save().click();
await metaSays('改名排队中');
assert.equal(await h2(),'排队里的名字');
assert.equal((await prompts()).length,3,'nothing sent while busy');
await page.locator('.message.queued').filter({hasText:'/rename 排队里的名字'}).waitFor();
assert.equal(await box().inputValue(),'草稿：等会儿再发');
await shot('queued-light');
await status('idle');
await page.waitForFunction(()=>fx.prompts.length===4,null,{timeout:12000});
assert.equal((await prompts())[3],'/rename 排队里的名字');
await metaSays('改名已发出');
await setTitle('w1:p1','✳ 排队里的名字','排队里的名字');
await metaSays('已改名');
console.log('PASS: busy agent → queued, sent when it stops, then confirmed');

// 6. A question or menu on screen: the bridge refuses before typing; it waits in the queue and goes later.
await metaGone('已改名');
await page.evaluate(()=>{fx.promptError='没发出去：它正停在一个提问或选择框上（电脑那边还显示它空闲），这时打字回车会直接选中选项。先回答它';});
await rename('等菜单关掉');
await metaSays('改名排队中');
await page.locator('.message.queued').filter({hasText:'/rename 等菜单关掉'}).waitFor();
await page.evaluate(()=>{fx.promptError='';});
await page.waitForFunction(()=>fx.prompts.at(-1).text==='/rename 等菜单关掉'&&fx.prompts.length===6,null,{timeout:15000});
await metaSays('改名已发出');
await setTitle('w1:p1','✳ 等菜单关掉','等菜单关掉');
await metaSays('已改名');await metaGone('已改名');
console.log('PASS: refused on a menu → queued, sent once it clears');

// 7. Unknown outcome: said so, watched, never sent again; back when nothing confirms it.
await page.evaluate(()=>{RN.wait=2500;fx.promptError='连接超时';});
const before=(await prompts()).length;
await rename('结果未知的名字');
await toastSaid(/改名发送未确认：连接超时。不会自动重发/);
await metaSays('改名结果未知');
await toastSaid(/改名发送结果未知，也没看到标题变成「结果未知的名字」/);
assert.equal((await prompts()).length,before+1,'never resent');
assert.equal(await h2(),'等菜单关掉');
await page.evaluate(()=>{fx.promptError='';RN.wait=10000;});
console.log('PASS: unknown outcome → not resent, header back');

// 8. Codex: "No active thread" on screen → back at once; a working rename shows as "<name> | <dir>".
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.getByRole('button',{name:/修登录/}).click();
await page.getByText('修好了。').first().waitFor();
assert.equal(await h2(),'修登录');
assert.equal(await titleBtn().evaluate(b=>b.classList.contains('hint')),false);
await page.evaluate(()=>{fx.screen='■ No active thread is available.\n\n› Ask Codex to do anything';});
await rename('Codex 新名字');
assert.equal((await prompts()).at(-1),'/rename Codex 新名字');
await toastSaid(/没改成：Codex 说现在还没有可改名的对话/);
assert.equal(await h2(),'修登录');
await page.evaluate(()=>{fx.screen='› Ask Codex to do anything';fx.onPrompt=a=>{if(a.text==='/rename Codex 新名字'){const r=fx.list.find(x=>x.pane_id==='w1:p2');r.terminal_title=r.terminal_title_stripped='Codex 新名字 | proj';}};});
await page.waitForTimeout(400);
await rename('Codex 新名字');
await metaSays('已改名');
assert.equal(await h2(),'Codex 新名字');
await page.evaluate(()=>{fx.onPrompt=null;});
// Renamed on the computer: the header follows the agent's new title.
await metaGone('已改名');
await setTitle('w1:p2','电脑上改的 | proj','电脑上改的 | proj');
await page.evaluate(async()=>{S.statusBusy=false;await refreshStatus();FOLLOW.last=0;FOLLOW.busy=false;await followRun();});
await page.waitForFunction(()=>document.querySelector('#chat-head h2').textContent==='电脑上改的');
console.log('PASS: Codex refused without a thread, renamed with one; a rename from the computer reaches the header');

// 9. Not offered: an agent whose /rename opens its own dialog, a history record, the demo.
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.getByRole('button',{name:/OpenCode/}).first().click();
await page.locator('#chat-head h2').waitFor();
assert.equal(await titleBtn().count(),0,'OpenCode: plain title');
await page.evaluate(()=>{openRecord(fx.R.r1);});
await page.getByText('好，整理完了。').first().waitFor();
assert.equal(await titleBtn().count(),0,'history record: plain title');
await page.evaluate(()=>{openAgent(fx.list[0]);});
await titleBtn().waitFor();
await page.evaluate(()=>{S.demo=true;renderChat();});
assert.equal(await titleBtn().count(),0,'demo: plain title');
await page.evaluate(()=>{S.demo=false;renderChat();});
await titleBtn().waitFor();
// A pane that changed under the chat: the title explains instead of sending.
await page.evaluate(()=>{S.chat.stale=true;});
await titleBtn().click();
await toastSaid(/窗格还在确认，稍后再改/);
assert.equal(await dialog().count(),0);
await page.evaluate(()=>{S.chat.stale=false;});
console.log('PASS: not offered for OpenCode, records, demo; a changed pane explains');

// 10. Phone widths: a long title still fits; dark sheet.
await page.setViewportSize({width:320,height:640});await page.waitForTimeout(200);
assert(await page.evaluate(()=>document.scrollingElement.scrollWidth<=innerWidth),'no sideways scroll at 320');
await page.setViewportSize({width:390,height:844});await page.waitForTimeout(200);
await theme('dark');
await titleBtn().click();await dialog().waitFor();await field().fill('深色下的新名字');
await shot('sheet-dark');
await dialog().getByRole('button',{name:'取消',exact:true}).click();
await theme('light');
console.log('PASS: 320 fits; dark sheet');

// 11. Tablet two-pane layout: the same title button and sheet in the right pane.
await page.setViewportSize({width:1024,height:768});await page.waitForTimeout(400);
await page.locator('.wide-frame').waitFor();
await titleBtn().waitFor();
await titleBtn().click();await dialog().waitFor();
const r=await dialog().boundingBox();assert(r&&r.y>=0&&r.y+r.height<=768.5,'sheet on screen');
await field().fill('平板上的新名字');await field().press('Enter');await dialog().waitFor({state:'detached'});
assert.equal((await prompts()).at(-1),'/rename 平板上的新名字');
await page.waitForFunction(()=>document.querySelector('#chat-head h2').textContent==='平板上的新名字');
await shot('tablet-light');
await theme('dark');await shot('tablet-dark');
console.log('PASS: tablet two-pane');

assert.deepEqual(errors,[]);
await browser.close();
console.log('rename UI checks passed');
})().catch(e=>{console.error(e);process.exit(1);});
