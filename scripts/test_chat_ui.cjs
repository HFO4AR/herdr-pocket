// Conversation reading and replying: tool summaries (files changed, tests), notice-only turns,
// message actions (copy, quote, code, select), file sheets, kept turn DOM across polls and pages,
// scroll anchoring, cached chats and composer states. Offline: native SSH is a strict fake; nothing is sent.
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
 const r1={id:'r1',thread:'t1',title:'修登录页',provider:'claude',parent:null,cwd:'/work/proj',modified:now-60};
 const m=(n,kind,text,extra={})=>({id:n+':0',kind,text,title:'',call_id:'',timestamp:iso(4000-n*20),...extra});
 const tool=(n,name,input,call)=>m(n,'tool',typeof input==='string'?input:JSON.stringify(input,null,2),{title:name,call_id:call});
 const out=(n,text,call)=>m(n,'result',text,{title:'执行结果',call_id:call});
 // Older page: the start of turn A. Newer page starts mid-turn (with its Bash call).
 const older=[m(1,'user','先修一下登录页'),m(2,'assistant','我先改 login.js。'),
  tool(3,'Edit',{file_path:'/work/proj/app/login.js',old_string:'a\nb',new_string:'a\nc\nd'},'e1'),out(4,'The file /work/proj/app/login.js has been updated successfully.','e1')];
 const filler=[];for(let k=0;k<14;k++)filler.push(m(30+k,'user','第 '+k+' 个问题'),m(30+k+0.5,'assistant','第 '+k+' 个回答。\n\n'+'很长的一段解释。'.repeat(12)));
 const newer=[tool(5,'Bash','cd /work/proj && PYTHONPATH=. python -m unittest discover -s tests','b1'),out(6,'..........\nRan 24 tests in 0.1s\n\nOK','b1'),
  m(7,'assistant','改好了，`app/login.js` 已更新，测试都通过。'),
  m(10,'user','<command-name>/status</command-name>\n<command-message>status</command-message>\n<command-args></command-args>'),
  m(11,'user','<local-command-stdout>Model: opus</local-command-stdout>'),
  m(12,'user','<system-reminder>后台检查已完成</system-reminder>'),
  ...filler.map((x,i)=>({...x,id:(20+i)+':0',timestamp:iso(3000-i*10)})),
  m(60,'user','再跑一下失败的测试'),tool(61,'Bash','npm test','b2'),out(62,'PASS: a\nPASS: b\nFAIL: login\nExit code 1','b2'),
  m(63,'assistant','**还有一个失败：** 登录超时。\n\n```bash\nnpm test\n```\n\n看 `app/login.js:12`。')];
 window.fx={older,newer,calls:[],copied:[],history:0};
 const A1={pane_id:'w1:p1',terminal_id:'term1',agent:'claude',agent_status:'idle',identity:'id-1',cwd:'/work/proj',title:'修登录页',history_ref:{status:'matched',source:'native-process',record_id:'r1',thread:'t1',record:r1}};
 fx.A1=A1;
 const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};
  try{
  if(op==='devices')data={devices:[device],version:'test',connected:device};
  else if(op==='remote'){fx.calls.push(a.op);
   if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
   else if(a.op==='agents')data=a.target?{follow:true,state:'same',agents:[fx.A1],pane:null}:{agents:[fx.A1]};
   else if(a.op==='status'){const {history_ref,...rest}=fx.A1;data={agents:[rest]};}
   else if(a.op==='history'){fx.history++;data=a.before===undefined?{record:r1,messages:fx.newer,before:5,has_more:true,children:[]}:{record:r1,messages:fx.older,before:0,has_more:false,children:[]};}
   else if(a.op==='read')data={text:'$ '};
   else if(a.op==='prompt'){fx.prompt=(fx.prompt||[]);fx.prompt.push(a);data={sent:true,receipt:'r'};}
   else if(a.op==='catalog')data={records:[],total:0,next:null};
   else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
   else throw Error('blocked remote op '+a.op);}
  else if(!['watchState','protect','setAlerts','cacheGet','cachePut'].includes(op))throw Error('unexpected native op '+op);
  }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
  setTimeout(()=>nativeResult(id,{ok:true,data}),10);}};
});
await page.goto(require('./ui_bundle.cjs').url(html));
await page.evaluate(()=>{window.followInterval=()=>1e9;window.copyText=t=>{fx.copied.push(t);toast('已复制');};S.paused=true;});
const shot=async name=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(250);await page.screenshot({path:path.join(shots,'chat-'+name+'.png')});};
const box=()=>page.getByRole('textbox',{name:'消息输入框',exact:true});
const copied=()=>page.evaluate(()=>fx.copied.at(-1));

await page.getByRole('button',{name:/修登录页/}).click();
await page.getByText('登录超时。',{exact:false}).waitFor();
await page.evaluate(()=>{S.paused=true;});

// 1. Tool runs read as one line: what ran, and how tests went.
const last=page.locator('.turn').last();
assert.match(await last.locator('details.work .work-facts').textContent(),/1 失败 · 2 通过/);
await last.locator('details.work>summary').click();
const run=last.locator('details.tool-row').first();
assert.match(await run.locator('summary').textContent(),/运行npm test1 失败 · 2 通过/);
await run.locator('summary').click();
await run.getByText('Exit code 1',{exact:false}).waitFor();
await shot('tools');
console.log('PASS: tool rows say what ran and how tests went');

// 2. A slash command with only a harness notice: no empty 「工作过程」 block.
const cmd=page.locator('.turn').filter({has:page.locator('.slash-card.logged')});
assert.equal(await cmd.count(),1);
assert.equal(await cmd.locator('details.work').count(),0,'no empty work block for a notice-only turn');
assert.match(await cmd.locator('.notice-row').textContent(),/系统消息后台检查已完成/);
console.log('PASS: notice-only turns show the notice, not an empty work block');

// 3. Reply actions: copy, quote, long-press menu (copy code, select text).
const reply=page.locator('.message.reply').last();
await reply.getByRole('button',{name:'复制回答',exact:true}).click();
assert.match(await copied(),/^\*\*还有一个失败：\*\* 登录超时。/);
await reply.getByRole('button',{name:'引用回答',exact:true}).click();
assert.equal(await box().inputValue(),'> 还有一个失败： 登录超时。\n> [代码]\n> 看 app/login.js:12。\n\n');
assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'消息输入框');
await shot('quote');
await box().fill('');await page.evaluate(()=>{S.drafts.clear();renderComposer();});
await reply.locator('.bubble').dispatchEvent('contextmenu');
await page.getByRole('dialog',{name:'消息'}).waitFor();
await page.getByRole('button',{name:/复制代码.*bash · 1 行/}).click();
assert.equal(await copied(),'npm test');
await reply.locator('.bubble').dispatchEvent('contextmenu');
await page.getByRole('button',{name:/选择文字/}).click();
await page.getByRole('dialog',{name:'选择文字'}).locator('.select-text').getByText('看 `app/login.js:12`。',{exact:false}).waitFor();
await page.evaluate(()=>closeSheet());
console.log('PASS: reply copy and quote buttons; long-press menu copies code and opens selectable text');

// 4. Kept turns: a repaint reuses finished turns; loading the earlier page keeps the reader in place.
const keep=await page.evaluate(()=>{window.__cmd=document.querySelectorAll('.turn')[2];window.__mid=document.querySelectorAll('.turn')[5];return !!window.__mid;});assert(keep);
await page.evaluate(()=>paintTimeline());
assert(await page.evaluate(()=>document.querySelectorAll('.turn')[5]===window.__mid&&window.__mid.isConnected),'finished turn DOM is kept on repaint');
// Open the partial first turn's work block, then read upwards.
// Hold the automatic read-upwards while setting up, then load the page explicitly.
await page.evaluate(()=>{window.__fh=fetchHistory;fetchHistory=()=>{};const n=document.getElementById('chat-scroll');n.scrollTop=0;S.stick=false;});
assert.match(await page.locator('.turn').first().textContent(),/接上文/);
await page.locator('.turn').first().locator('details.work summary').click();
await page.waitForTimeout(200);
const before=await page.evaluate(()=>window.__mid.getBoundingClientRect().top);
await page.evaluate(()=>{fetchHistory=window.__fh;return fetchHistory(true);});
await page.getByText('先修一下登录页',{exact:true}).waitFor();
await page.waitForTimeout(150);
const after=await page.evaluate(()=>window.__mid.getBoundingClientRect().top);
assert(Math.abs(after-before)<3,'reading position kept when earlier messages load ('+before+' → '+after+')');
assert(await page.evaluate(()=>window.__mid.isConnected),'kept turn survives the earlier page');
const first=page.locator('.turn').first();
assert.equal(await first.locator('details.work[open]').count(),1,'open work block survives its turn growing an earlier start');
assert.equal(await first.locator('.turn-cont').count(),0);
assert.match(await first.locator('details.work .work-stats').textContent(),/1 条进展 · 2 个操作/);
const edit=first.locator('details.tool-row').filter({hasText:'编辑'});
assert.match(await edit.locator('summary').textContent(),/编辑login\.jsapp\+2−1/);
await edit.locator('summary').click();await edit.locator('.tl-diff').waitFor();
assert.deepEqual(await edit.locator('.tl-diff span').allTextContents(),['  a','− b','+ c','+ d']);
assert.match(await first.locator('details.tool-row').filter({hasText:'运行'}).locator('summary').textContent(),/运行python -m unittest discover -s tests24 通过/);
await first.locator('details.work>summary').click();
assert.match(await first.locator('.work-facts').textContent(),/改 1 个文件\+2−1/);
await shot('tally');
console.log('PASS: finished turns are kept, reading position and open blocks survive earlier pages, edits show +/− and diffs');

// 5. Tapping a file path: its sheet with this chat's edits.
await first.locator('.message.reply .md-file').click();
const sheet=page.getByRole('dialog',{name:'login.js'});
await sheet.getByText('这段对话里的改动 · 1 处',{exact:false}).waitFor();
await sheet.getByText('/work/proj/app/login.js',{exact:true}).waitFor();
await shot('file-sheet');
await sheet.getByRole('button',{name:'复制路径',exact:true}).click();
assert.equal(await copied(),'app/login.js');
console.log('PASS: a tapped path opens a sheet with copy actions and the edits made to it');

// 6. Cached chat: no "已到记录起点" before the first fresh read.
await page.evaluate(()=>{S.chat.cached=Date.now();S.more=false;paintTimeline();});
assert.equal(await page.getByText('已到记录起点',{exact:true}).count(),0);
assert.equal(await page.getByRole('button',{name:'加载更早消息',exact:true}).count(),0);
await page.evaluate(()=>{S.chat.cached=0;paintTimeline();});
await page.getByText('已到记录起点',{exact:true}).waitFor();
console.log('PASS: paging button waits for the fresh read');

// 7. Composer states: connecting (write but not send), busy (排队), idle.
await page.evaluate(()=>{window.__dev=S.device;S.device=null;renderComposer();});
await page.getByText(/连上后才能发送/).waitFor();
await box().fill('先写好');
assert(await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled());
await shot('connecting');
await page.evaluate(()=>{S.device=window.__dev;S.chat.agent={...S.chat.agent,agent_status:'working'};renderComposer();});
assert.equal(await box().inputValue(),'先写好','draft kept across composer states');
assert.equal(await page.locator('.send .send-label').textContent(),'排队');
assert(!await page.getByRole('button',{name:'发送消息',exact:true}).isDisabled());
await shot('busy');
await page.evaluate(()=>{S.chat.agent={...S.chat.agent,agent_status:'idle'};renderComposer();});
assert.equal(await page.locator('.send .send-label').textContent(),'');
console.log('PASS: composer while connecting, busy and idle');

// 8. Helpers on real shapes: Codex code mode, setup lines, pytest/jest summaries.
assert.deepEqual(await page.evaluate(()=>[
 toolInput({text:'text(await tools.exec_command({cmd:"ls -la","yield_time_ms":1000}));\ntext(await tools.exec_command({cmd:"git status"}));'}),
 tlCmdLine('p=/x\ncd "$p"\necho "=== run ==="\nFOO=1 npm test'),
 resultInfo({text:'==== 3 passed, 1 failed in 2.1s ===='}).tests,
 resultInfo({text:'Ran 5 tests in 0.2s\n\nFAILED (failures=1, errors=1)'}).tests,
 resultInfo({text:'0 errors, 2 warnings'}).tests,
 quoteText('# 标题\n\n- 第一条\n- 第二条\n\n| a | b |\n|---|---|\n| 1 | 2 |')]),
 ['$ ls -la\n\n$ git status','npm test',{pass:3,fail:1},{pass:3,fail:2},null,'> 标题\n> 第一条\n> 第二条\n> | a | b |\n> …']);
console.log('PASS: summaries for code mode, setup lines and test runners');

// 9. Dark theme and narrow screens: no overflow.
for(const [w,h,theme] of [[320,640,'dark'],[390,844,'dark'],[320,640,'light']]){
 await page.setViewportSize({width:w,height:h});await page.evaluate(t=>{document.documentElement.dataset.theme=t;},theme);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow at '+w);
 await page.evaluate(()=>{S.stick=true;scrollBottom();});await shot(theme+'-'+w);}
assert.deepEqual(errors,[]);
assert(!(await page.evaluate(()=>fx.calls)).some(op=>['prompt','key','answer','paneRun','paneText','paneKey'].includes(op)),'nothing was sent');

// 10. A hardware keyboard's Enter sends in the chat; Shift+Enter keeps a newline.
await page.setViewportSize({width:390,height:844});
await page.evaluate(()=>{window.HWKB=Object.assign(window.HWKB||{},{physical:true});S.chat.agent={...S.chat.agent,agent_status:'idle'};renderComposer();});
await box().fill('键盘回车发送');await box().press('Enter');
await page.waitForFunction(()=>window.fx.prompt&&fx.prompt.length===1);
assert.equal(await page.evaluate(()=>fx.prompt[0].text),'键盘回车发送');
await box().fill('第一行');await box().press('Shift+Enter');await box().type('第二行');
assert.equal(await box().inputValue(),'第一行\n第二行');
assert.equal(await page.evaluate(()=>fx.prompt.length),1,'Shift+Enter sends nothing');
console.log('PASS: hardware keyboard Enter sends; Shift+Enter keeps a newline');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
