// Agents other than Claude / Codex (OpenCode, Gemini …): listed with a readable name, opened on
// 终端 with a calm note (no transcript reader), and driven the generic way: send, queue, keys,
// interrupt, menus and close. Native SSH is a strict offline fake; nothing leaves the page.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const shots=process.env.SHOTS||'';if(shots)fs.mkdirSync(shots,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 const now=Date.now()/1000;
 const rec={id:'r1',thread:'t1',title:'整理发布脚本',provider:'claude',parent:null,cwd:'/work/proj',modified:now-60};
 // Field shapes as `herdr agent list` (0.8.2) prints them; only Claude has a history_ref.
 const OC={pane_id:'w1:p7',terminal_id:'term_oc',agent:'opencode',agent_status:'idle',identity:'id-oc',cwd:'/home/u/site',foreground_cwd:'/home/u/site',
  terminal_title:'OpenCode',terminal_title_stripped:'OpenCode',workspace_id:'w1',tab_id:'w1:t3',agent_session:{agent:'opencode',kind:'id',source:'herdr:opencode',value:'ses_1'}};
 const GE={pane_id:'w1:p8',terminal_id:'term_ge',agent:'gemini',agent_status:'working',identity:'id-ge',cwd:'/home/u/api',terminal_title:'api: gemini',workspace_id:'w1',tab_id:'w1:t3'};
 const CL={pane_id:'w1:p1',terminal_id:'term_cl',agent:'claude',agent_status:'idle',identity:'id-cl',cwd:'/work/proj',title:'整理发布脚本',
  history_ref:{status:'matched',source:'native-process',record_id:'r1',thread:'t1',record:rec}};
 window.fx={list:[OC,GE,CL],calls:[],prompts:[],keys:[],unexpected:[],
  screen:{'w1:p7':'  OpenCode 1.2.20\n\n  > \n  build · gpt-6   tab agents · ctrl+p commands','w1:p8':'✦ Working on it (esc to cancel, 4s)'},
  modes:{},menu:{},
  setStatus(pane,st){fx.list=fx.list.map(a=>a.pane_id===pane?{...a,agent_status:st}:a);}};
 const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
 const strip=a=>{const {history_ref,...rest}=a;return rest;};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};
  try{
  if(op==='devices')data={devices:[device],version:'test',connected:device};
  else if(op==='remote'){fx.calls.push({op:a.op,target:a.target||'',key:a.key||''});
   if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
   else if(a.op==='agents'){if(a.target){const row=fx.list.find(x=>x.pane_id===a.target);data=row?{follow:true,state:'same',agents:[row],pane:null}:{follow:true,state:'gone',agents:[],pane:null};}else data={agents:fx.list};}
   else if(a.op==='status')data={agents:fx.list.map(strip)};
   else if(a.op==='read'){const row=fx.list.find(x=>x.pane_id===a.target);data={text:fx.screen[a.target]||'$ ',agent_status:row?.agent_status,modes:fx.modes[a.target]||null,...(fx.menu[a.target]?{menu:fx.menu[a.target]}:{})};}
   else if(a.op==='history')data={messages:[{id:'1:0',kind:'user',text:'整理一下',timestamp:new Date().toISOString()},{id:'2:0',kind:'assistant',text:'好的。',timestamp:new Date().toISOString()}],before:0,has_more:false,children:[]};
   else if(a.op==='catalog')data={records:[],total:0,next:null};
   else if(a.op==='prompt'){fx.prompts.push(a);data={sent:true,receipt:a.id};}
   else if(a.op==='key'){fx.keys.push(a);data={sent:true,receipt:a.id};}
   else if(a.op==='commands')data={provider:'opencode',commands:[]};
   else if(a.op==='closeInfo'){const row=fx.list.find(x=>x.pane_id===a.target);data={pane_id:a.target,agent:row.agent,agent_status:row.agent_status,focused:false,workspace_label:'site',tab_label:'3',tab_panes:2,workspace_panes:3,exit_command:row.agent==='opencode'?'/exit':null,ch:false,ch_session:null};}
   else if(a.op==='glance')data={items:[]};
   else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
   else throw Error('unexpected remote op '+a.op);}
  else if(['watchState','protect','setAlerts','settings','cachePut','dropImages'].includes(op))data={};
  else if(op==='cacheGet')data={value:null};
  else{fx.unexpected.push(op);data={};}
  }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
  setTimeout(()=>nativeResult(id,{ok:true,data}),10);}};
});
await page.goto(require('./ui_bundle.cjs').url(html));
await page.evaluate(()=>{window.followInterval=()=>1e9;});
const shot=async name=>{if(!shots)return;await page.evaluate(()=>document.getElementById('toast')?.classList.remove('show'));await page.waitForTimeout(300);await page.screenshot({path:path.join(shots,'generic-'+name+'.png')});};
const box=()=>page.getByRole('textbox',{name:'消息输入框',exact:true});
const calls=op=>page.evaluate(o=>fx.calls.filter(c=>c.op===o),op);
const status=async(pane,st)=>{await page.evaluate(async([p,st])=>{fx.setStatus(p,st);S.statusBusy=false;await refreshStatus();},[pane,st]);};
const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);

// ── 1. List: readable names, initials, no Claude/Codex-only tags ──
await page.locator('.agent-row').filter({hasText:'site'}).first().waitFor();
const row=page.locator('.agent-row').filter({hasText:'site'}).first();
assert.equal(await row.locator('.card-title').textContent(),'OpenCode','a bare "OpenCode" terminal title falls back to the name (the project is on the meta line)');
assert.equal(await row.locator('.avatar').textContent(),'Oc');
assert.match(await row.locator('.avatar').getAttribute('class'),/kind-other/);
const ge=page.locator('.agent-row').filter({hasText:'api'}).first();
assert.equal(await ge.locator('.card-title').textContent(),'Gemini','"<dir>: gemini" is a generic title');
assert.equal(await ge.locator('.avatar').textContent(),'Ge');
assert.equal(await page.getByText('历史未关联').count(),0,'kinds without transcripts are not flagged as unlinked');
await shot('list');
await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot('list-dark');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
console.log('PASS: other agents are listed with display names, initials and their Herdr state');

// ── 2. Open: 终端 tab with a calm note; no transcript, history or Claude/Codex-only UI ──
await row.click();
await page.getByText('这个 Agent 的对话记录还读不了，先看终端画面',{exact:true}).waitFor();
assert.equal(await page.getByRole('button',{name:'终端',exact:true}).getAttribute('aria-pressed'),'true','opens on 终端');
assert.equal(await page.getByRole('button',{name:'命令',exact:true}).count(),0,'no 命令 tab without a transcript');
await page.waitForFunction(()=>(document.getElementById('terminal-output')?.textContent||'').includes('OpenCode 1.2.20'));
assert.equal(await page.locator('#mode-bar').count(),0,'no mode bar');
assert.equal((await calls('history')).length+(await calls('catalog')).length,0,'nothing tries to read a transcript');
assert.equal(await page.locator('.note.error').count(),0,'no error note');
assert.equal(await page.locator('.spinner').count(),0,'no spinner left');
assert.match(await page.locator('#chat-meta').textContent(),/OpenCode/);
assert.match(await box().getAttribute('placeholder'),/^发给 OpenCode…（\/ 看命令）$/);
await shot('chat');
await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot('chat-dark');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,'fits 320 px');await page.setViewportSize({width:390,height:844});
// 对话 says the same, with a way back.
await page.getByRole('button',{name:'对话',exact:true}).click();
await page.getByRole('button',{name:'看终端',exact:true}).waitFor();
assert.equal(await page.getByRole('button',{name:'选择历史记录'}).count(),0,'no history picker');
await page.getByRole('button',{name:'看终端',exact:true}).click();
await page.waitForFunction(()=>S.chatMode==='terminal');
// Menu: no history items.
await page.getByRole('button',{name:'更多操作',exact:true}).click();
await page.getByRole('button',{name:/终端按键/}).waitFor();
assert.equal(await page.getByRole('button',{name:/选择其他历史记录/}).count(),0);
assert.equal(await page.getByRole('button',{name:/刷新对话/}).count(),0);
await page.keyboard.press('Escape');await page.evaluate(()=>closeSheet());
console.log('PASS: opens on 终端 with a friendly note; no transcript reads, history picker, 命令 tab or mode bar');

// ── 3. Slash list: OpenCode has its own; send goes through prompt ──
await box().click();await box().fill('/');
await page.getByText('OpenCode 命令',{exact:true}).waitFor();
await page.getByRole('option',{name:/\/exit/}).waitFor();
await box().fill('');
await box().fill('把测试跑一下');
await page.getByRole('button',{name:'发送消息',exact:true}).click();
await page.waitForFunction(()=>fx.prompts.length===1);
assert.deepEqual(await page.evaluate(()=>({t:fx.prompts[0].target,x:fx.prompts[0].text})),{t:'w1:p7',x:'把测试跑一下'});
await page.getByText(/发给 OpenCode 了，回复看终端/).waitFor();
console.log('PASS: OpenCode slash list; prompts go out through the bridge with a toast pointing at the terminal');

// ── 4. Queue while it works, then send when it stops ──
await status('w1:p7','working');
await page.waitForFunction(()=>S.chat?.agent?.agent_status==='working');
assert.match(await box().getAttribute('placeholder'),/写好会排队/);
await box().fill('第二条：顺便看看日志');
await page.getByRole('button',{name:'发送消息',exact:true}).click();
await page.locator('.queue').getByText('第二条：顺便看看日志').waitFor();
assert.equal(await page.evaluate(()=>fx.prompts.length),1,'queued, not sent');
await shot('queued');
await status('w1:p7','idle');
await page.waitForFunction(()=>fx.prompts.length===2,null,{timeout:20000});
assert.equal(await page.evaluate(()=>fx.prompts[1].text),'第二条：顺便看看日志');
console.log('PASS: a message written while it works queues and goes out once Herdr reports it stopped');

// ── 5. Interrupt: Esc with honest copy; Shift+Tab only when its footer offers it ──
await status('w1:p7','working');
await page.getByRole('button',{name:'中断',exact:true}).waitFor();
await page.getByRole('button',{name:'中断',exact:true}).click();
await page.getByText(/OpenCode 具体怎么处理不一定/).waitFor();
await shot('interrupt');
await page.getByRole('dialog').getByRole('button',{name:'中断',exact:true}).click();
await page.waitForFunction(()=>fx.keys.some(k=>k.key==='esc'));
await status('w1:p7','idle');
await page.getByRole('button',{name:'更多操作',exact:true}).click();
await page.getByRole('button',{name:/终端按键/}).click();
await page.getByRole('button',{name:'Esc 返回'}).waitFor();
assert.equal(await page.getByRole('button',{name:/Shift\+Tab/}).count(),0,'no Shift+Tab while the footer does not name it');
await page.evaluate(()=>closeSheet());
await page.evaluate(async()=>{fx.screen['w1:p7']='  > \n  Shift+Tab cycle mode';fx.modes['w1:p7']={agent:'opencode',generic:true,cycle:true};await fetchTerminal(true);});
await page.getByRole('button',{name:'更多操作',exact:true}).click();
await page.getByRole('button',{name:/终端按键.*Shift\+Tab/}).click();
await page.getByRole('button',{name:'Shift+Tab',exact:true}).click();
await page.waitForFunction(()=>fx.keys.some(k=>k.key==='shift+tab'));
console.log('PASS: 中断 sends Esc and says its effect varies; Shift+Tab appears only when the footer offers it');

// ── 6. A menu on a blocked agent becomes a question card ──
await page.evaluate(()=>{fx.menu['w1:p7']={kind:'approval',multi:false,cursor:1,question:'Allow this command?',context:['Bash  rm -rf dist','Allow this command?'],esc:{action:'cancel',option:null},tabs:[],
 options:[{n:1,label:'Allow once',description:'',checked:null,chosen:false,input:false,chat:false},{n:2,label:'Allow always',description:'',checked:null,chosen:false,input:false,chat:false},{n:3,label:'Reject',description:'',checked:null,chosen:false,input:false,chat:false}],submit:null,fingerprint:'0123456789abcdef0123'};});
await status('w1:p7','blocked');
await page.getByText('OpenCode 等你确认').first().waitFor();
await page.getByText('Allow always',{exact:true}).waitFor();
await shot('menu');
await status('w1:p7','idle');
console.log('PASS: a parsed menu on a blocked OpenCode shows as a card');

// ── 7. Close: OpenCode can exit with /exit; Gemini only offers closing the pane ──
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.evaluate(()=>closeSession(S.agents.find(a=>a.agent==='opencode')));
await page.getByRole('radio',{name:/结束 OpenCode/}).waitFor();
await page.getByText(/发送 \/exit/).waitFor();
await page.evaluate(()=>closeSheet());
await page.evaluate(()=>closeSession(S.agents.find(a=>a.agent==='gemini')));
await page.getByRole('radio',{name:'关闭整个窗格'}).waitFor();
await page.waitForFunction(()=>!document.querySelector('.close-loading'));
assert.equal(await page.getByRole('radio',{name:/结束 Gemini/}).count(),0,'no guessed exit command');
await shot('close-gemini');
await page.evaluate(()=>closeSheet());
console.log('PASS: close offers 结束 only with a known exit command');

// ── 8. Gemini (no slash list): no command popup; Claude still opens its conversation ──
await page.locator('.agent-row').filter({hasText:'api'}).first().click();
await page.getByText('这个 Agent 的对话记录还读不了，先看终端画面',{exact:true}).waitFor();
await box().fill('/');await page.waitForTimeout(300);
assert.equal(await page.locator('.slash-pop').count(),0,'no command list for an agent without one');
assert.doesNotMatch(await box().getAttribute('placeholder')||'',/看命令/);
await box().fill('');
await page.getByRole('button',{name:'返回列表',exact:true}).click();
await page.locator('.agent-row').filter({hasText:'整理发布脚本'}).first().click();
await page.getByText('好的。').first().waitFor();
assert.equal(await page.getByRole('button',{name:'对话',exact:true}).getAttribute('aria-pressed'),'true','Claude still opens on 对话');
assert.equal(await page.getByText('这个 Agent 的对话记录还读不了，先看终端画面').count(),0);
console.log('PASS: Gemini gets no slash popup; Claude keeps its conversation view');

assert.deepEqual(errors,[]);
assert.deepEqual(await page.evaluate(()=>fx.unexpected),[]);
await browser.close();
console.log('ALL GENERIC AGENT UI CHECKS PASSED');
})().catch(e=>{console.error(e);process.exit(1);});
