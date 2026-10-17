// Answering agent questions from the phone: question card, raw-key fallback, answered rows and
// Codex async replies. Offline: native SSH is a strict fixture and `remote` is a recorded fake.
// Menus come from the real bridge parser (python3) so the UI is tested against its actual output.
const {chromium}=require('playwright');
const {execFileSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const RULE='─'.repeat(64);
const claudeScreen=(question,rows,tabs)=>[RULE,tabs,'',question,'',...rows,'','Enter to select · Tab/Arrow keys to navigate · Esc to cancel'].join('\n');
const SCREENS={
 q1:claudeScreen('运行日志放在哪里？',['❯ 1. 写到项目目录（推荐）','     放在 logs/ 下，和代码一起忽略提交。','  2. 写到系统临时目录','     重启后会清空，不占项目空间。','  3. Type something.',RULE,'  4. Chat about this'],'←  ☐ 日志位置  ☐ 清理范围  ✔ Submit  →'),
 q2:claudeScreen('这次要清理哪些目录？',['❯ 1. [ ] 构建产物','     dist/ 和 build/。','  2. [ ] 缓存','     .cache/ 下的所有内容。','  3. [ ] Type something','     Next'],'←  ☒ 日志位置  ☐ 清理范围  ✔ Submit  →'),
 scroll:claudeScreen('先修哪个？',['❯ 1. 修登录','     先保证能连上。','  2. 修历史','     翻页会丢消息。','  ↓'],'←  ☐ 先修  ✔ Submit  →'),
 bash:['● 我先清掉旧的构建结果。','',RULE,' Bash command','','   rm -rf dist .cache','   Remove build outputs','',' Do you want to proceed?',' ❯ 1. Yes',"   2. Yes, and don't ask again for rm commands in /home/demo/site",'   3. No, and tell Claude what to do differently (esc)','',' Esc to cancel · Tab to amend · ctrl+e to explain'].join('\n'),
};
const menus=JSON.parse(execFileSync('python3',['-c',`
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('b',sys.argv[1]);b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
print(json.dumps({k:b.parse_menu(v,'claude') for k,v in json.loads(sys.argv[2]).items()},ensure_ascii=False))`,path.join(root,'bridge/pocket_bridge.py'),JSON.stringify(SCREENS)],{encoding:'utf8'}));
for(const [k,m] of Object.entries(menus))assert(m&&m.cursor,'bridge parsed '+k);

(async()=>{
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{window.PocketNative={request(id,op){if(!['devices','demo','disconnect','protect','watchState'].includes(op))throw Error('Forbidden native call in offline UI test: '+op);setTimeout(()=>nativeResult(id,{ok:true,data:op==='devices'?{devices:[]}:{}}),0);}};});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
const folder=path.join(root,'ui-artifacts');fs.mkdirSync(folder,{recursive:true});
await page.getByRole('button',{name:'体验聊天演示',exact:true}).click();

// The offline demo's blocked Codex approval already uses the card.
await page.getByRole('button',{name:/清理构建缓存/}).click();
await page.getByRole('group',{name:'等你确认',exact:true}).waitFor();
await page.getByRole('radio',{name:/Yes, proceed/}).click();
await page.getByRole('button',{name:'确认这个选择',exact:true}).click();
await page.getByText('演示：没有真的回答',{exact:true}).waitFor();
await page.getByRole('button',{name:'返回列表',exact:true}).click();
console.log('PASS: demo approval renders as a card and never answers');

// Live fixture: a Claude agent blocked on AskUserQuestion with two questions.
await page.evaluate(({menus,screens})=>{
 const t=n=>new Date(Date.UTC(2026,9,15,9,n)).toISOString();
 const msg=(n,kind,text,extra={})=>({id:n+':0',kind,text,title:'',call_id:'',timestamp:t(n),...extra});
 const ask={questions:[{question:'运行日志放在哪里？',header:'日志位置',multiSelect:false,options:[{label:'写到项目目录（推荐）',description:'放在 logs/ 下，和代码一起忽略提交。日志轮转按天，最多保留 7 天。'},{label:'写到系统临时目录',description:'重启后会清空，不占项目空间。'}]},
  {question:'这次要清理哪些目录？',header:'清理范围',multiSelect:true,options:[{label:'构建产物',description:'dist/ 和 build/。'},{label:'缓存',description:'.cache/ 下的所有内容。'}]}]};
 window.fx={screen:'q1',calls:[],answerError:null,
  messages:[msg(1,'user','把日志和缓存整理一下。'),msg(2,'assistant','先确认两件事再动手。'),
   msg(3,'tool',JSON.stringify({questions:[{question:'要保留旧日志吗？',header:'旧日志',multiSelect:false,options:[{label:'保留',description:''},{label:'删除',description:''}]}]},null,2),{title:'AskUserQuestion',call_id:'toolu_old'}),
   msg(4,'result','Your questions have been answered: "要保留旧日志吗？"="保留". You can now continue with these answers in mind.',{title:'执行结果',call_id:'toolu_old'}),
   msg(5,'tool',JSON.stringify({questions:[{question:'要压缩吗？',header:'压缩',options:[{label:'要',description:''}]}]},null,2),{title:'AskUserQuestion',call_id:'toolu_no'}),
   msg(6,'result',"The user doesn't want to proceed with this tool use. The tool use was rejected.",{title:'执行失败',call_id:'toolu_no'}),
   msg(7,'tool',JSON.stringify(ask,null,2),{title:'AskUserQuestion',call_id:'toolu_live'})]};
 fx.agent={pane_id:'w1:p9',identity:'id-claude',agent:'claude',agent_status:'blocked',cwd:'/home/demo/site',terminal_title:'整理日志',agent_session:{value:'s1'},
  history_ref:{status:'matched',record:{id:'rec-claude',thread:'s1',provider:'claude',title:'整理日志',cwd:'/home/demo/site',modified:Date.now()/1000}}};
 window.fxMenus=menus;window.fxScreens=screens;
 remote=async(op,args={})=>{fx.calls.push({op,args});await new Promise(r=>setTimeout(r,30));
  if(op==='status')return{agents:[fx.agent]};
  if(op==='history')return{record:fx.agent.history_ref.record,messages:structuredClone(fx.messages),children:[],before:0,has_more:false};
  if(op==='read')return{text:screens[fx.screen],...(fx.agent.agent_status==='blocked'||fx.menuAlways?{menu:menus[fx.screen]}:{})};
  if(op==='answer'){if(fx.answerError)throw Error(fx.answerError);return{sent:true,receipt:args.id,result:{answered:true}};}
  if(op==='prompt'||op==='key')return{sent:true};
  throw Error('unexpected op '+op);};
 S.demo=false;S.session='fixture';S.agents=[fx.agent];
},{menus,screens:SCREENS});
await page.evaluate(()=>openAgent(fx.agent));
await page.getByText('把日志和缓存整理一下。',{exact:true}).waitFor();
await page.evaluate(()=>fetchTerminal(true));
const card=page.getByRole('group',{name:'Agent 的提问',exact:true});
await card.waitFor();
assert.match(await card.locator('.qa-head').textContent(),/Claude 在问你.*1\/2/);
await card.getByText('日志位置',{exact:true}).waitFor();
await card.getByText('运行日志放在哪里？',{exact:true}).waitFor();
// Full description from the transcript, not the screen's shorter copy.
await card.getByText('放在 logs/ 下，和代码一起忽略提交。日志轮转按天，最多保留 7 天。',{exact:true}).waitFor();
assert.equal(await page.getByRole('button',{name:'Enter 确认',exact:true}).count(),0,'raw keys hidden behind the card');
assert(await card.getByRole('button',{name:'发送回答',exact:true}).isDisabled(),'nothing chosen yet');
// History rows: an answered and a cancelled question stay readable outside the folded work block.
await page.getByText('你的回答：',{exact:true}).first().waitFor();
assert.match(await page.locator('.qa-log.answered').first().textContent(),/要保留旧日志吗？.*你的回答：保留/);
assert.match(await page.locator('.qa-log.cancelled').textContent(),/没有回答（已取消）/);
assert.match(await page.locator('.qa-log.waiting').textContent(),/等你回答 · 在下面选/);
await page.screenshot({path:path.join(folder,'answer-claude-question.png')});

// Raw keys stay one tap away and come back.
await card.getByRole('button',{name:'用按键操作',exact:true}).click();
await page.getByRole('button',{name:'Enter 确认',exact:true}).waitFor();
await page.getByRole('button',{name:'用选项回答',exact:true}).click();
await card.waitFor();
assert.equal(await page.getByRole('button',{name:'Enter 确认',exact:true}).count(),0);

// A failed answer is reported in place and never retried automatically.
await page.evaluate(()=>{fx.answerError='光标没停在目标选项上，已停下，没有按确认';});
await card.getByRole('radio',{name:/写到系统临时目录/}).click();
assert.equal(await card.getByRole('radio',{name:/写到系统临时目录/}).getAttribute('aria-checked'),'true');
await card.getByRole('button',{name:'发送回答',exact:true}).click();
await card.locator('.qa-error').getByText(/没完成：光标没停在目标选项上/).waitFor();
assert.equal(await page.locator('#toast.show').filter({hasText:'没完成'}).count(),0,'the inline error on screen is not toasted as well');
assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c.op==='answer').length),1);
assert.equal(await card.getByRole('button',{name:'发送回答',exact:true}).isDisabled(),false,'can retry by hand');
// Polling with an unchanged menu keeps the selection.
await page.evaluate(()=>fetchTerminal(true));
assert.equal(await card.getByRole('radio',{name:/写到系统临时目录/}).getAttribute('aria-checked'),'true');
await page.evaluate(()=>{fx.answerError=null;});
await card.getByRole('button',{name:'发送回答',exact:true}).click();
await card.getByText('已回答，等它继续…',{exact:true}).waitFor();
const sent=await page.evaluate(()=>fx.calls.filter(c=>c.op==='answer').at(-1).args);
assert.deepEqual({action:sent.action,option:sent.option,label:sent.label,fingerprint:sent.fingerprint,target:sent.target,identity:sent.identity},
 {action:'select',option:2,label:'写到系统临时目录',fingerprint:menus.q1.fingerprint,target:'w1:p9',identity:'id-claude'});
assert.match(sent.id,/^[a-f0-9-]{36}$/);
console.log('PASS: Claude question card with transcript details, raw-key fallback, failure in place, answer request');
// Regression: the menu is on screen (and parsed) while Herdr still says "working"; when the status
// flips to blocked, the next read returns the same menu. The card must show without leaving the chat.
await page.evaluate(async()=>{fx.screen='q1';fx.menuAlways=true;fx.agent={...fx.agent,identity:'id-claude-2',agent_status:'working'};S.agents=[fx.agent];S.qaMenu=null;
 await openAgent(fx.agent);await fetchTerminal(true);});
assert.equal(await page.getByRole('group',{name:'Agent 的提问',exact:true}).count(),0,'no card while working');
await page.evaluate(async()=>{fx.agent={...fx.agent,agent_status:'blocked'};S.statusBusy=false;S.liveLoading=false;await refreshStatus();});
await page.getByRole('group',{name:'Agent 的提问',exact:true}).waitFor({timeout:3000});
console.log('PASS: question card appears in place when the same menu was already read while working');
// The transcript's question call lands after the card was first drawn from the screen: the card
// picks up the full descriptions and step without leaving the chat.
await page.evaluate(async()=>{const live=fx.messages.pop();fx.lateCall=live;fx.agent={...fx.agent,identity:'id-claude-3',agent_status:'blocked'};fx.menuAlways=false;S.agents=[fx.agent];S.qaMenu=null;
 await openAgent(fx.agent);await fetchTerminal(true);});
const late=page.getByRole('group',{name:'Agent 的提问',exact:true});await late.waitFor();
assert.equal(await late.getByText('放在 logs/ 下，和代码一起忽略提交。日志轮转按天，最多保留 7 天。',{exact:true}).count(),0,'screen-only copy first');
await page.evaluate(()=>{fx.messages.push(fx.lateCall);});
await page.waitForFunction(id=>{const has=S.messages.some(m=>m.id===id);if(!has&&!S.polling)fetchHistory();return has;},await page.evaluate(()=>fx.lateCall.id),{polling:300,timeout:20000});
await late.getByText('放在 logs/ 下，和代码一起忽略提交。日志轮转按天，最多保留 7 天。',{exact:true}).waitFor({timeout:3000});
assert.match(await page.locator('.qa-card .qa-head').textContent(),/1\/2/);
console.log('PASS: card upgrades in place when the question call reaches the transcript');

// Next question on screen: multi-select with checkboxes and free text.
await page.evaluate(()=>{fx.screen='q2';return fetchTerminal(true);});
await card.locator('.qa-head').getByText('2/2').waitFor();
await card.getByRole('checkbox',{name:/构建产物/}).click();
await card.getByRole('checkbox',{name:/缓存/}).click();
await card.getByRole('checkbox',{name:/其他…/}).click();
await card.getByRole('textbox',{name:'自己写的回答',exact:true}).fill('还有 tmp/\n目录');
await page.screenshot({path:path.join(folder,'answer-claude-multi.png')});
await card.getByRole('button',{name:'发送回答',exact:true}).click();
await card.getByText('已回答，等它继续…',{exact:true}).waitFor();
const multi=await page.evaluate(()=>fx.calls.filter(c=>c.op==='answer').at(-1).args);
assert.deepEqual([multi.action,multi.options,multi.option,multi.text,multi.fingerprint],['multi',[1,2],3,'还有 tmp/ 目录',menus.q2.fingerprint]);
console.log('PASS: multi-select toggles, free text is sent as one line');

// Approval dialog: command context, explicit confirmation button.
await page.evaluate(()=>{fx.screen='bash';fx.messages=fx.messages.slice(0,6);return fetchTerminal(true);});
const approval=page.getByRole('group',{name:'等你确认',exact:true});
await approval.waitFor();
await approval.getByText(/rm -rf dist \.cache/).waitFor();
assert.equal(await approval.getByRole('radio').count(),3);
await approval.getByRole('radio',{name:/^Yes$/}).click();
await approval.getByRole('button',{name:'确认这个选择',exact:true}).click();
await approval.getByText('已确认，等它继续…',{exact:true}).waitFor();
assert.equal(await page.evaluate(()=>fx.calls.filter(c=>c.op==='answer').at(-1).args.option),1);
await page.screenshot({path:path.join(folder,'answer-approval.png')});
for(const [width,height] of [[320,640],[844,390],[1024,768]]){
 await page.setViewportSize({width,height});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'horizontal overflow at '+width);
 // The layout settles after a resize (two-pane switch, card transition): measure once it stops moving.
 let b=null;for(let i=0;i<30;i++){const n=await approval.locator('.qa-submit').boundingBox();if(b&&n&&Math.abs(n.y-b.y)<0.5&&Math.abs(n.height-b.height)<0.5){b=n;break;}b=n;await page.waitForTimeout(100);}
 assert(b&&b.y+b.height<=height,'submit clipped at '+width+'x'+height);
 const top=(await approval.boundingBox()).y,head=await page.locator('#chat-head').boundingBox();assert(top>=head.y+head.height-1,'card overlaps the header at '+width+'x'+height);
 await page.screenshot({path:path.join(folder,`answer-approval-${width}.png`)});}
await page.setViewportSize({width:390,height:844});
console.log('PASS: approval card with command context, responsive at 320/landscape/tablet');

// Codex async question: the agent is idle, the card sits in the timeline and replies as a prompt.
await page.evaluate(()=>{
 const t=n=>new Date(Date.UTC(2026,9,15,10,n)).toISOString();
 const msg=(n,kind,text,extra={})=>({id:'9'+n+':0',kind,text,title:'',call_id:'',timestamp:t(n),...extra});
 fx.agent={pane_id:'w1:p7',identity:'id-codex',agent:'codex',agent_status:'idle',cwd:'/home/demo/site',terminal_title:'问我一个问题',agent_session:{value:'c1'},
  history_ref:{status:'matched',record:{id:'rec-codex',thread:'c1',provider:'codex',title:'问我一个问题',cwd:'/home/demo/site',modified:Date.now()/1000}}};
 fx.messages=[msg(1,'user','用选择题问我。'),
  msg(2,'tool',JSON.stringify({questions:[{header:'节奏',id:'pace',question:'你更喜欢哪种节奏？',options:[{label:'做完一件再做下一件',description:'少切换。'},{label:'同时推进几件',description:''}]}]},null,2),{title:'request_user_input',call_id:'call_sync'}),
  msg(3,'result',JSON.stringify({answers:{pace:{answers:['None of the above','user_note: 看当天状态']}}},null,2),{title:'执行结果',call_id:'call_sync'}),
  msg(4,'assistant','好的，按状态来。',{phase:'final_answer'}),msg(5,'user','再问一个。'),
  msg(6,'tool',JSON.stringify({questions:[{title:'今天先做哪件？',options:['修测试','写文档','整理日志']}]},null,2),{title:'request_user_input_async',call_id:'call_async'}),
  msg(7,'result','{"accepted":true}',{title:'执行结果',call_id:'call_async'}),msg(8,'assistant','已弹出选择题，选一个试试。',{phase:'final_answer'})];
 S.agents=[fx.agent];});
await page.evaluate(()=>openAgent(fx.agent));
await page.getByText('已弹出选择题，选一个试试。',{exact:true}).waitFor();
assert.match(await page.locator('.qa-log.answered').textContent(),/你更喜欢哪种节奏？.*你的回答：看当天状态/);
const inline=page.locator('.qa-log.waiting').getByRole('group',{name:'Agent 的提问',exact:true});
await inline.waitFor();
await inline.getByRole('radio',{name:'写文档',exact:true}).click();
await page.screenshot({path:path.join(folder,'answer-codex-async.png')});
await inline.getByRole('button',{name:'发送回答',exact:true}).click();
await page.getByText('已回答',{exact:true}).first().waitFor();
const prompt=await page.evaluate(()=>fx.calls.filter(c=>c.op==='prompt').at(-1).args);
assert.equal(prompt.target,'w1:p7');
assert.match(prompt.text,/^<send_user_message_question_reply>\n/);
const items=JSON.parse(prompt.text.split('\n')[1]);
assert.deepEqual(items,[{answer:'写文档',question:'今天先做哪件？',questionItemId:'["request_user_input_async","call_async",0]'}]);
assert.equal(await page.evaluate(()=>S.chat.agent.agent_status),'working');
// Once the reply is in the transcript the question shows as answered and the reply as the next turn.
await page.evaluate(()=>{fx.messages.push({id:'99999:0',kind:'user',text:fx.calls.filter(c=>c.op==='prompt').at(-1).args.text,title:'',call_id:'',timestamp:new Date().toISOString()});});
// A plain poll merges it (one asked for while another read runs is queued, not dropped) and repaints:
// the waiting question row turns answered with no forced repaint.
await page.evaluate(()=>fetchHistory());
await page.waitForFunction(()=>S.messages.some(m=>m.id==='99999:0'),null,{polling:300,timeout:20000});
await page.locator('.qa-log .qa-log-state.done').getByText('已回答',{exact:true}).waitFor();
assert.equal(await page.locator('.qa-log.waiting').count(),0);
await page.locator('.notice-row.answer').filter({hasText:'写文档'}).first().waitFor();
console.log('PASS: Codex sync answers in history, async question answered inline as a prompt');

// Claude's option list scrolls: options outside the window come from the transcript, with the text row after them.
assert.deepEqual(await page.evaluate(({menu})=>{
 const call={id:'1:0',kind:'tool',title:'AskUserQuestion',call_id:'t9',text:JSON.stringify({questions:[{question:'先修哪个？',header:'先修',options:[{label:'修登录',description:'先保证能连上。'},{label:'修历史',description:''},{label:'修通知',description:'后台提醒不响。'}]}]})};
 S.messages=[call];const m=qaMenuModel(menu,{...S.chat.agent,agent:'claude'});const q=m.questions[0];
 return [q.options.map(o=>[o.n,o.label]),q.textRow];},{menu:menus.scroll}),
 [[[1,'修登录'],[2,'修历史'],[3,'修通知']],4]);

// Real transcript shapes (wording anonymized): Claude results with previews and multi-select, Codex notes.
assert.deepEqual(await page.evaluate(()=>{
 const call=(title,input,id)=>({id:'1:0',kind:'tool',title,call_id:id,text:JSON.stringify(input,null,2)});
 const res=(id,text,title='执行结果')=>({id:'2:0',kind:'result',title,call_id:id,text});
 const c=call('AskUserQuestion',{questions:[{question:'用在哪些操作上？',header:'范围',multiSelect:true,options:[{label:'清理 (A)'},{label:'重建 (B)'}]},{question:'默认怎么办？',header:'默认',options:[{label:'保持老行为',preview:'x'}]}]},'t1');
 const r=res('t1','Your questions have been answered: "用在哪些操作上？"="清理 (A), 重建 (B)", "默认怎么办？"="保持老行为" selected preview:\n对刀方式: [整层一次 ▾]\n  ← 默认不变. You can now continue with these answers in mind.');
 const typed=res('t1','Your questions have been answered: "用在哪些操作上？"="都不要，先问清楚", "默认怎么办？"="保持老行为". You can now continue with these answers in mind.');
 const x=call('request_user_input',{questions:[{id:'scope',header:'范围',question:'先支持哪些？',options:[{label:'只要 Linux (Recommended)',description:''}]}]},'c1');
 const xr=res('c1',JSON.stringify({answers:{scope:{answers:['只要 Linux (Recommended)']}}},null,2));
 const rej=res('t1',"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).",'执行失败');
 return [qaOutcome(c,qaParse(c),[c,r]).answers,qaOutcome(c,qaParse(c),[c,typed]).answers,qaOutcome(x,qaParse(x),[x,xr]).answers,qaOutcome(c,qaParse(c),[c,rej]).state,qaOutcome(c,qaParse(c),[c]).state,qaNotice(c).text];}),
 [['清理 (A), 重建 (B)','保持老行为'],['都不要，先问清楚','保持老行为'],['只要 Linux (Recommended)'],'cancelled','waiting','范围 · 用在哪些操作上？ 等 2 个问题']);
console.log('PASS: answers parsed from Claude and Codex transcript formats');


assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
