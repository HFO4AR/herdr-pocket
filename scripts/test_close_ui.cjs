// Closing sessions from the phone: long press / 更多操作 → the close sheet, 结束 Agent (exitAgent)
// and 关闭整个窗格 (closePane), unknown outcomes never retried, ch wording, and hiding history records.
// Offline: native SSH is a strict fixture and `remote` is a recorded fake, so nothing is closed anywhere.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
const errors=[];
async function fresh(width=390,height=844){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:2});
 page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
 await page.addInitScript(()=>{window.PocketNative={request(id,op){if(!['devices','demo','disconnect','protect','watchState','dropImages','dropFiles'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);setTimeout(()=>nativeResult(id,{ok:true,data:op==='devices'?{devices:[]}:{}}),0);}};});
 await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
 await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();
 await page.getByText('离线演示 · 示例数据，不连接电脑',{exact:true}).waitFor();
 return page;}
const H=c=>c.repeat(64);
// A connected-looking fixture with a recorded fake for every bridge op the close flow uses.
async function live(page,agents){
 await page.evaluate(agents=>{
  window.fx={calls:[],agents,info:{},closeError:null,exitError:null,closeResult:null,follow:null,hidden:[],
   records:[{id:'a'.repeat(64),thread:'t1',provider:'codex',title:'整理串口日志',cwd:'/home/me/IterxAI/stm32_host',modified:Date.now()/1000-600},
    {id:'b'.repeat(64),thread:'t2',provider:'claude',title:'检查 Gateway OTA',cwd:'/home/me/IterxAI/stm32_host',modified:Date.now()/1000-7200}]};
  remote=async(op,args={})=>{fx.calls.push({op,args});await new Promise(r=>setTimeout(r,30));
   if(op==='sessions')return{sessions:[{name:'default',running:true}]};
   if(op==='agents'&&args.target){if(fx.follow)return fx.follow;return{follow:true,state:'same',agents:fx.agents.filter(a=>a.pane_id===args.target),pane:null};}
   if(op==='agents'||op==='status')return{agents:fx.agents};
   if(op==='closeInfo')return{pane_id:args.target,agent:'codex',focused:false,workspace_label:'stm32_host',tab_label:'调试',tab_panes:3,exit_command:'/quit',ch:false,...(fx.info[args.target]||{})};
   if(op==='closePane'){if(fx.closeError)throw Error(fx.closeError);fx.agents=fx.agents.filter(a=>a.pane_id!==args.target);return fx.closeResult||{closed:true,pane_id:args.target,verified:true};}
   if(op==='exitAgent'){if(fx.exitError)throw Error(fx.exitError);return{sent:true,receipt:args.id,command:'/quit'};}
   if(op==='key')return{sent:true};
   if(op==='read')return{text:'› '};
   if(op==='catalog')return{records:fx.records,total:fx.records.length,next:null};
   if(op==='history')return{messages:[],children:[],before:0,has_more:false};
   if(op==='hidden'){if(args.add)fx.hidden=fx.hidden.filter(x=>!args.add.includes(x)).concat(args.add);if(args.remove)fx.hidden=fx.hidden.filter(x=>!args.remove.includes(x));return{ids:fx.hidden};}
   throw Error('unexpected op '+op);};
  S.demo=false;S.device={id:'d1',name:'工作站',user:'me',host:'h',port:22};S.agents=[];S.session='';
 },agents);
 await page.evaluate(()=>setTab('live'));
 await page.locator('.agent-row').first().waitFor();}
const calls=(page,op)=>page.evaluate(op=>fx.calls.filter(c=>c.op===op).map(c=>c.args),op);
const agent=(pane,status,extra={})=>({pane_id:pane,identity:H(pane.slice(-1)),agent:'codex',agent_status:status,cwd:'/home/me/IterxAI/stm32_host',terminal_title:'排查串口 '+pane+' | stm32_host',agent_session:{value:'s'+pane},history_ref:{status:'unavailable'},...extra});
async function hold(page,locator){const box=await locator.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.waitForTimeout(700);await page.mouse.up();}
async function openClose(page,name){
 await hold(page,page.getByRole('button',{name}));
 const acts=page.getByRole('dialog');await acts.getByRole('button',{name:/关闭会话/}).click();
 const sheet=page.getByRole('dialog',{name:'关闭会话'});await sheet.waitFor();return sheet;}

// 1. Demo: long press opens the actions (not the chat); closing never happens.
{const page=await fresh();
 await hold(page,page.locator('.agent-row').first());
 const acts=page.getByRole('dialog');await acts.getByRole('button',{name:/打开对话/}).waitFor();
 assert.equal(await page.locator('#chat-head').count(),0,'long press must not open the chat');
 await acts.getByRole('button',{name:/关闭会话/}).click();
 const sheet=page.getByRole('dialog',{name:'关闭会话'});
 await sheet.getByRole('radio',{name:'关闭整个窗格'}).click();
 await sheet.getByRole('button',{name:'关闭窗格',exact:true}).click();
 await page.getByText('演示：不会真的关闭',{exact:true}).waitFor();
 assert.equal(await page.locator('.agent-row').count()>0,true);
 await page.close();console.log('PASS: demo long press → close sheet, nothing closed');}

// 2. Idle agent: the sheet names agent, pane and place; 结束 Codex sends exitAgent once, no text.
{const page=await fresh();
 await live(page,[agent('w1:p1','idle'),agent('w1:p2','idle')]);
 await page.evaluate(()=>{fx.info['w1:p1']={focused:true,tab_panes:1,tab_label:'调试'};});
 const sheet=await openClose(page,/排查串口 w1:p1/);
 await sheet.getByText('窗格 w1:p1 · 标签页「调试」',{exact:true}).waitFor();
 await sheet.getByText('电脑屏幕上现在正显示这个窗格',{exact:true}).waitFor();
 await sheet.getByText(/最后一个窗格/).waitFor();
 const go=sheet.getByRole('button',{name:'选一种方式'});assert.equal(await go.isDisabled(),true,'nothing chosen yet');
 await sheet.getByRole('radio',{name:'结束 Codex，保留终端'}).click();
 await sheet.getByText(/发送 \/quit/).waitFor();
 await page.screenshot({path:path.join(folder,'close-idle-390.png')});
 await sheet.getByRole('button',{name:'结束 Codex',exact:true}).click();
 await page.getByText('Codex 收到 /quit，正在退出',{exact:true}).waitFor();
 const ex=await calls(page,'exitAgent');assert.equal(ex.length,1);
 assert.deepEqual(Object.keys(ex[0]).sort(),['id','identity','session','target']);
 assert.equal(ex[0].target,'w1:p1');assert.equal(ex[0].identity,H('1'));assert.match(ex[0].id,/^[0-9a-f-]{36}$/);
 assert.equal((await calls(page,'closePane')).length,0);
 await page.close();console.log('PASS: idle agent → exitAgent once with receipt id, sheet names pane and place');}

// 3. Working agent with a queued message: strong warnings, exit disabled, close pane clears queue and list.
{const page=await fresh();
 await live(page,[agent('w1:p1','working'),agent('w1:p2','idle')]);
 await page.evaluate(()=>{const a=fx.agents[0];queueAdd(agentKey(a),a,'跑完再看日志',[]);render();});
 const sheet=await openClose(page,/排查串口 w1:p1/);
 await sheet.getByText('还在干活，关闭会中断当前任务',{exact:true}).waitFor();
 await sheet.getByText('还有 1 条排队的消息，关闭后不会再发',{exact:true}).waitFor();
 const exit=sheet.getByRole('radio',{name:'结束 Codex，保留终端'});
 assert.equal(await exit.getAttribute('aria-disabled'),'true');await exit.dispatchEvent('click');
 assert.equal(await exit.getAttribute('aria-checked'),'false');
 await sheet.getByRole('button',{name:'先中断',exact:true}).waitFor();
 await sheet.getByRole('radio',{name:'关闭整个窗格'}).click();
 await page.screenshot({path:path.join(folder,'close-busy-390.png')});
 await sheet.getByRole('button',{name:'关闭窗格',exact:true}).click();
 await page.getByText('窗格关掉了',{exact:true}).waitFor();
 const cp=await calls(page,'closePane');assert.equal(cp.length,1);assert.equal(cp[0].target,'w1:p1');assert.equal(cp[0].identity,H('1'));
 await page.getByRole('button',{name:/排查串口 w1:p1/}).waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>Q.size),0,'queue cleared');
 assert.equal((await calls(page,'exitAgent')).length,0);
 await page.close();console.log('PASS: working agent → warnings, exit disabled, closePane clears queue and row');}

// 4. Unknown outcome: shown as unknown, never retried; a definite refusal can be chosen again.
{const page=await fresh();
 await live(page,[agent('w1:p1','idle')]);
 await page.evaluate(()=>{fx.closeError='关闭结果未知：Herdr 没及时回应。刷新列表看看，别直接重试';});
 let sheet=await openClose(page,/排查串口 w1:p1/);
 await sheet.getByRole('radio',{name:'关闭整个窗格'}).click();
 await sheet.getByRole('button',{name:'关闭窗格',exact:true}).click();
 await sheet.getByText('结果未知：Herdr 没及时回应。刷新列表看看，别直接重试',{exact:true}).waitFor();
 const stuck=sheet.locator('.close-foot .primary');assert.equal(await stuck.textContent(),'结果未知');assert.equal(await stuck.isDisabled(),true);
 await sheet.getByRole('radio',{name:'关闭整个窗格'}).dispatchEvent('click');
 assert.equal(await stuck.isDisabled(),true,'still not resendable');
 assert.equal((await calls(page,'closePane')).length,1);
 await page.screenshot({path:path.join(folder,'close-unknown-390.png')});
 await page.evaluate(()=>closeSheet());
 await page.evaluate(()=>{fx.closeError='没关：这个窗格里的 Agent 变了，刷新列表再看';});
 sheet=await openClose(page,/排查串口 w1:p1/);
 await sheet.getByRole('radio',{name:'关闭整个窗格'}).click();
 await sheet.getByRole('button',{name:'关闭窗格',exact:true}).click();
 await sheet.getByText('没关：这个窗格里的 Agent 变了，刷新列表再看',{exact:true}).waitFor();
 assert.equal(await sheet.getByRole('button',{name:'关闭窗格',exact:true}).isDisabled(),false);
 const ids=(await calls(page,'closePane')).map(c=>c.id);assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);
 await page.evaluate(()=>closeSheet());
 // The bridge's own identity check (English) is a definite refusal, not an unknown outcome.
 await page.evaluate(()=>{fx.exitError='Agent changed or disappeared; reload the agent list';});
 sheet=await openClose(page,/排查串口 w1:p1/);
 await sheet.getByRole('radio',{name:'结束 Codex，保留终端'}).click();
 await sheet.getByRole('button',{name:'结束 Codex',exact:true}).click();
 await sheet.getByText('没关：这个窗格里的 Agent 变了，刷新列表再看',{exact:true}).waitFor();
 assert.equal(await sheet.getByRole('button',{name:'结束 Codex',exact:true}).isDisabled(),false);
 await page.close();console.log('PASS: unknown close is never retried; refusal can be chosen again with a new id');}

// 5. ch pane: remote session wording.
{const page=await fresh();
 await live(page,[agent('w1:p3','idle',{agent:'claude',terminal_title:'stm32_host: ch',history_ref:{status:'remote',remote:{route:'r'}}})]);
 await page.evaluate(()=>{fx.info['w1:p3']={agent:'claude',exit_command:'/exit',ch:true,ch_session:'7458c85a-6863-d9ce-a5a4-61ac374b8883'};});
 const sheet=await openClose(page,/Claude/);
 await sheet.getByRole('radio',{name:'结束远端会话'}).waitFor();
 await sheet.getByRole('radio',{name:'只关本机窗格'}).click();
 await sheet.getByText(/ch resume 接回/).waitFor();
 await page.screenshot({path:path.join(folder,'close-ch-390.png')});
 await sheet.getByRole('button',{name:'关闭窗格',exact:true}).click();
 await page.getByText('本机窗格关了，远端会话还在，之后可以 ch resume 接回',{exact:true}).waitFor();
 await page.close();console.log('PASS: ch pane → remote/local wording');}

// 6. From the chat: 更多操作 → 关闭会话; exit shows the follow "已退出" state, then the leftover pane can be closed.
{const page=await fresh();
 await live(page,[agent('w1:p1','idle'),agent('w1:p2','idle')]);
 await page.getByRole('button',{name:/排查串口 w1:p1/}).click();
 await page.locator('#chat-head').waitFor();
 await page.getByRole('button',{name:'更多操作',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:/关闭会话/}).click();
 let sheet=page.getByRole('dialog',{name:'关闭会话'});
 await page.evaluate(()=>{fx.follow={follow:true,state:'exited',agents:[],pane:{pane_id:'w1:p1',terminal_id:'term_x',terminal_title:'zsh',cwd:'/home/me/IterxAI/stm32_host',identity:'c'.repeat(64)}};fx.agents=fx.agents.filter(a=>a.pane_id!=='w1:p1');});
 await sheet.getByRole('radio',{name:'结束 Codex，保留终端'}).click();
 await sheet.getByRole('button',{name:'结束 Codex',exact:true}).click();
 await page.getByText(/Codex 已退出/).first().waitFor({timeout:8000});
 await page.getByRole('button',{name:'更多操作',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:/关闭这个窗格/}).click();
 sheet=page.getByRole('dialog',{name:'关闭会话'});
 assert.equal(await sheet.getByRole('radio').count(),1,'only the pane option once the agent is gone');
 await sheet.getByRole('radio',{name:'关闭整个窗格'}).click();
 await sheet.getByRole('button',{name:'关闭窗格',exact:true}).click();
 await page.locator('#chat-head').waitFor({state:'detached'});
 const cp=await calls(page,'closePane');assert.equal(cp.length,1);assert.equal(cp[0].identity,'c'.repeat(64));
 await page.close();console.log('PASS: chat → exit → follow exited → close leftover pane → back to list');}

// 7. History: 从列表移除 hides (bridge list), 已隐藏 brings it back; nothing is deleted.
{const page=await fresh();
 await live(page,[agent('w1:p1','idle')]);
 await page.evaluate(()=>setTab('history'));
 const row=page.getByRole('button',{name:/整理串口日志/});await row.waitFor();
 await hold(page,row);
 await page.getByRole('dialog').getByRole('button',{name:/从列表移除/}).click();
 await page.getByText('已从列表移除，在「已隐藏」里能找回',{exact:true}).waitFor();
 await row.waitFor({state:'detached'});
 assert.deepEqual((await calls(page,'hidden')).filter(c=>c.add).map(c=>c.add),[['a'.repeat(64)]]);
 await page.getByRole('button',{name:'已隐藏 · 1'}).click();
 await page.getByText(/只在 App 里不显示/).waitFor();
 assert.deepEqual(await page.$$eval('.tabs .pill.active',n=>n.map(x=>x.textContent)),['已隐藏 · 1']);
 await page.screenshot({path:path.join(folder,'close-hidden-390.png')});
 await hold(page,page.getByRole('button',{name:/整理串口日志/}));
 await page.getByRole('dialog').getByRole('button',{name:/放回列表/}).click();
 await page.getByRole('button',{name:/整理串口日志/}).waitFor();
 assert.equal(await page.getByRole('button',{name:/已隐藏/}).count(),0);
 assert.equal((await calls(page,'closePane')).length+(await calls(page,'exitAgent')).length,0);
 await page.close();console.log('PASS: history hide / unhide through the bridge list');}

// 8. Layout: the busy + queued sheet at 320 and 390 has no horizontal overflow.
for(const [w,h] of [[390,844],[320,640]]){
 const page=await fresh(w,h);
 await live(page,[agent('w1:p1','blocked',{terminal_title:'一个很长很长的会话标题，用来检查小屏上的截断和换行是否正常 | stm32_host'})]);
 await page.evaluate(()=>{const a=fx.agents[0];queueAdd(agentKey(a),a,'回头再说',[]);queueAdd(agentKey(a),a,'还有这个',[]);render();});
 const sheet=await openClose(page,/一个很长很长/);
 await sheet.getByText('它在等你确认，关闭会中断当前任务',{exact:true}).waitFor();
 await sheet.getByRole('radio',{name:'关闭整个窗格'}).click();
 await page.waitForTimeout(250);
 const over=await page.evaluate(()=>{const s=document.querySelector('.sheet');return s.scrollWidth-s.clientWidth;});
 assert.ok(over<=1,'sheet overflows at '+w+': '+over);
 await page.screenshot({path:path.join(folder,'close-sheet-'+w+'.png')});
 if(w===390){await sheet.getByRole('button',{name:'先中断',exact:true}).click();await page.getByText('已发送 Ctrl+C，等它停下再来结束',{exact:true}).waitFor();
  const k=await calls(page,'key');assert.equal(k.length,1);assert.equal(k[0].key,'ctrl+c');assert.equal(k[0].target,'w1:p1');
  assert.equal((await calls(page,'closePane')).length+(await calls(page,'exitAgent')).length,0);}
 await page.close();}
console.log('PASS: close sheet fits 390 and 320');

assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
