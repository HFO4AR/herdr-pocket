// ch 控制台 from the phone: the approval list (full text, 700 ms, standing second step), the
// ports / SSH page (close, extend, open, rules) and the bridge page (pause / close / reopen).
// Offline: native SSH and the bridge are strict fakes; nothing leaves the page.
const {chromium}=require('playwright');
const path=require('node:path'),assert=require('node:assert/strict');

(async()=>{
const root=path.resolve(__dirname,'..');
const html=require('./ui_bundle.cjs')(root);
const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{})});
const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
await page.addInitScript(()=>{
 const now=Math.floor(Date.now()/1000),SID='33333333-3333-4333-8333-333333333333';
 const D={id:'A',name:'工作站',user:'yuki',host:'box.invalid',port:22,remember:true};
 const item=(id,extra={})=>({id,session:SID,expires_at:now+90,queued_ms:1,account:'local',
   project:'/home/u/project',project_name:'project',asks:'读 /tmp/x',text:'命令： cat /etc/hosts\n要在沙箱外运行',
   truncated:false,ports:[],standing:null,bridge_state:'open',approvable:true,approve_reason:null,...extra});
 const rule=()=>({id:'99999999-9999-4999-8999-999999999999',kind:'port',port:4444,session:SID,
   project:'/home/u/project',account:'local',requested_by:'会话 33333333',reason:'调试',approved_at:now});
 window.fx={
  calls:[],paused:false,bridgeState:'open',consoleError:null,readOnly:null,guardian:null,
  approvals:[
   item('11111111-1111-4111-8111-111111111111'),
   item('22222222-2222-4222-8222-222222222222',{asks:'端口审批',ports:[5555]}),
   item('33333333-3333-4333-8333-333333333333',{asks:'常开规则',standing:{ports:[4444],reason:'调试'}})],
  state:()=>({now,now_ms:Date.now(),paused:fx.paused?'paused':'running',
   pending:fx.approvals,pending_total:fx.approvals.length,pending_truncated:false,
   ports:{held_by_us:true,held_elsewhere:false,state:'open',sessions:[{id:'entry-1111-4111-8111-111111111111',session:SID,project:'/home/u/project',account:'local',
     ports:[{id:'port-1111-4111-8111-111111111111',port:3333,expires_at_ms:Date.now()+600000,origin:'console'}]}]},
   standing:{rules:[rule()],error:null},
   guardian:fx.guardian||{active:false},
   bridges:[{key:'b'.repeat(64),account:'local',project:'/home/u/project',state:fx.bridgeState,running:fx.bridgeState!=='closed',fetch_only:false}],
   candidates:[{key:'a'.repeat(32),session:SID,project:'/home/u/project',account:'local'}]}),
  summary:{available:true,paused:'running',count:3,expires_at:now+90,server:true,truncated:false}};
 window.PocketNative={request(id,op,raw){
  const a=raw?JSON.parse(raw):{};let data={};
  try{
   if(op==='devices')data={devices:[D],version:'test',connected:D,connections:[D]};
   else if(op==='remote'){
    fx.calls.push(a);
    if(a.op==='sessions')data={herdr:true,sessions:[{name:'default',running:true,default:true}],ch:fx.summary};
    else if(a.op==='agents')data={agents:[],ch:fx.summary};
    else if(a.op==='status')data={agents:[],ch:fx.summary};
    else if(a.op==='chConsole'){
     if(fx.consoleError)throw Error(fx.consoleError);
     if(a.action==='list')data={v:1,id:a.request_id,ok:true,result:fx.state()};
     else if(a.action==='chApprovals')data=fx.readOnly||{available:true,paused:'running',approvals:[],count:0,server:false};
     else{
      if(a.action==='pause')fx.paused=true;
      if(a.action==='resume')fx.paused=false;
      if(a.action==='bridge_action')fx.bridgeState=a.bridge_do==='close'?'closed':a.bridge_do==='reopen'?'open':a.bridge_do==='pause'?'paused':'open';
      if(a.approval_id)fx.approvals=fx.approvals.filter(x=>x.id!==a.approval_id);
      data={v:1,id:a.request_id,ok:true,result:{decision:a.decision||'allow',won:true,
       approval_id:a.approval_id,state:fx.state()}};
     }
    }
    else if(a.op==='chApprovals')data=fx.readOnly||{available:true,paused:'running',approvals:[],count:0,server:false};
    else if(a.op==='glance')data={previews:{}};
    else if(a.op==='catalog')data={records:[],total:0,next:null};
    else if(a.op==='native')data={sessions:[]};
    else if(a.op==='tmux')data={available:false,panes:[],servers:[]};
    else if(a.op==='hello')data={version:'test',protocol:1};
    else if(a.op==='account')data={ssh_user:'u',hostname:'box'};
    else if(a.op==='hidden')data={ids:[]};
    else data={};
   }
   else if(op==='cacheGet')data={value:null};
   else if(op==='cachePut')data={};
   else if(op==='settings')data={theme:'system',dark:false,textZoom:100,secureScreen:false,autoUpdate:false,
     alerts:true,notifications:true,keepAlive:false,version:'test',versionCode:1,update:null};
   else data={};
  }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
  setTimeout(()=>nativeResult(id,{ok:true,data}),10);
 }};
});
await page.goto(require('./ui_bundle.cjs').url(html));
const role=(r,name)=>page.getByRole(r,{name,exact:true});
const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||
 [...document.querySelectorAll('.ch-main,.ch-row,.ch-row-meta,.ch-detail,.ch-actions,.ch-port-row,.ch-rule-row,.ch-bridge-row')]
  .some(n=>n.scrollWidth>n.clientWidth+1));
const calls=op=>page.evaluate(o=>fx.calls.filter(c=>c.op===o),op);
await page.waitForTimeout(300);
await page.evaluate(()=>setTab('live'));
await page.locator('.ch-banner').waitFor();

// 会话 banner and toolbar entry.
assert.ok((await page.locator('.ch-banner').innerText()).includes('ch 审批'));
assert.equal(await page.locator('.ch-entry').count(),1);
await page.locator('.ch-banner').getByRole('button',{name:'查看',exact:true}).click();
await page.getByRole('heading',{name:'ch 控制台',exact:true}).waitFor();

// Approvals: full text, 700 ms, approve.
assert.equal(await page.locator('.ch-row').count(),3);
await page.locator('.ch-row').first().click();
assert.ok((await page.locator('.ch-text').innerText()).includes('cat /etc/hosts'));
const approve=page.locator('.ch-detail .primary').first();
assert.equal(await approve.isEnabled(),false,'approve waits for the reading pause');
await page.waitForTimeout(780);
assert.equal(await approve.isEnabled(),true);
await approve.click();
await page.waitForTimeout(80);
let decided=await calls('chConsole');
assert.ok(decided.some(c=>c.action==='decide'&&c.decision==='allow'&&c.approval_id==='11111111-1111-4111-8111-111111111111'),'approve sends decide allow');
await page.waitForTimeout(80);
assert.equal(await page.locator('.ch-row').count(),2,'the approved row is gone');

// A port request offers both y and a; a standing request takes a second step.
await page.locator('.ch-row').first().click();
await page.waitForTimeout(780);
await page.getByRole('button',{name:'放行端口 15 分钟',exact:true}).click();
await page.waitForTimeout(80);
decided=await calls('chConsole');
assert.ok(decided.some(c=>c.action==='decide_and_open'&&c.approval_id==='22222222-2222-4222-8222-222222222222'),'open ports sends decide_and_open');

await page.locator('.ch-row').first().click();
await page.waitForTimeout(780);
await page.getByRole('button',{name:'批准常开规则',exact:true}).click();
await page.locator('.sheet').getByText('这是常开规则，不是一次性授权',{exact:false}).waitFor();
const confirm=page.locator('.sheet').getByRole('button',{name:'确认批准',exact:true});
assert.equal(await confirm.isEnabled(),false,'the rule warning also waits');
await page.waitForTimeout(780);
await confirm.click();
await page.waitForTimeout(80);
decided=await calls('chConsole');
assert.ok(decided.some(c=>c.action==='decide_standing'&&c.approval_id==='33333333-3333-4333-8333-333333333333'),'standing sends decide_standing');

// Ports page: close one, close all, open.
await page.getByRole('tab',{name:'端口与 SSH',exact:true}).click();
await page.locator('.ch-port').first().waitFor();
assert.ok((await page.locator('.ch-port').first().innerText()).includes('3333'));
await page.locator('.ch-port-row').first().getByRole('button',{name:'关闭',exact:true}).click();
await page.waitForTimeout(80);
let ports=await calls('chConsole');
assert.ok(ports.some(c=>c.action==='ports_close'&&c.id==='port-1111-4111-8111-111111111111'));
await page.getByRole('button',{name:'全部关闭临时端口',exact:true}).click();
await page.locator('.sheet .sheet-actions').getByRole('button',{name:'全部关闭',exact:true}).click();
await page.waitForTimeout(80);
ports=await calls('chConsole');
assert.ok(ports.some(c=>c.action==='ports_close_all'));
await page.getByRole('button',{name:'开放端口…',exact:true}).click();
await page.locator('.sheet .ch-input').fill('3333, 5432');
await page.waitForTimeout(780);
await page.locator('.sheet .sheet-actions').getByRole('button',{name:'开放',exact:true}).click();
await page.waitForTimeout(80);
ports=await calls('chConsole');
assert.ok(ports.some(c=>c.action==='ports_open'&&c.ports.join(',')==='3333,5432'));
assert.ok((await page.locator('.ch-rule-row').innerText()).includes('4444'),'persistent rules are listed');

// Bridge page: pause, resume, close, reopen.
await page.getByRole('tab',{name:'桥',exact:true}).click();
await page.locator('.ch-bridge-row').waitFor();
await page.locator('.ch-bridge-row').getByRole('button',{name:'暂停',exact:true}).click();
await page.waitForTimeout(80);
let bridges=await calls('chConsole');
assert.ok(bridges.some(c=>c.action==='bridge_action'&&c.bridge_do==='pause'));
await page.locator('.ch-bridge-row').getByRole('button',{name:'恢复',exact:true}).click();
await page.locator('.sheet .sheet-actions').getByRole('button',{name:'恢复',exact:true}).click();
await page.waitForTimeout(80);
bridges=await calls('chConsole');
assert.ok(bridges.some(c=>c.action==='bridge_action'&&c.bridge_do==='resume'));
await page.locator('.ch-bridge-row').getByRole('button',{name:'关闭',exact:true}).click();
await page.locator('.sheet .sheet-actions').getByRole('button',{name:'关闭',exact:true}).click();
await page.waitForTimeout(80);
await page.locator('.ch-bridge-row').getByRole('button',{name:'重新打开',exact:true}).click();
await page.locator('.sheet .sheet-actions').getByRole('button',{name:'重新打开',exact:true}).click();
await page.waitForTimeout(80);
bridges=await calls('chConsole');
assert.ok(bridges.some(c=>c.action==='bridge_action'&&c.bridge_do==='close'));
assert.ok(bridges.some(c=>c.action==='bridge_action'&&c.bridge_do==='reopen'));

// Paused banner.
await page.evaluate(()=>{fx.paused=true;});
await page.evaluate(()=>chConsoleOpen('approvals'));
await page.locator('.ch-paused').waitFor();
await page.evaluate(()=>{fx.paused=false;});

// Guardian mode is shown, so a phone-only audit does not read it as "nothing to approve".
await page.evaluate(()=>{fx.guardian={active:true,expires_at_ms:Date.now()+600000,targets:[{session:'33333333-3333-4333-8333-333333333333'}]};});
await page.evaluate(()=>chConsoleOpen('approvals'));
await page.locator('.ch-guardian').waitFor();
await page.evaluate(()=>{fx.guardian=null;});

// Old ch: read-only queue, no approval from the phone.
await page.evaluate(()=>{fx.consoleError='电脑上的 ch 还没有手机控制台';fx.readOnly={available:true,paused:'running',
 approvals:[{id:'11111111-1111-4111-8111-111111111111',session:'33333333-3333-4333-8333-333333333333',expires_at:Math.floor(Date.now()/1000)+90,queued_ms:1,
  account:'local',project:'/home/u/project',project_name:'project',asks:'只读请求',text:'命令： ls',ports:[],standing:null,
  bridge_state:'open',approvable:true,approve_reason:null}],count:1,truncated:false,server:false};});
await page.evaluate(()=>chConsoleOpen('approvals'));
await page.locator('.ch-readonly').waitFor();
await page.locator('.ch-row').first().click();
assert.equal(await page.locator('.ch-detail .primary').count(),0,'old ch cannot approve');
await page.evaluate(()=>{fx.consoleError=null;fx.readOnly=null;});

// 320 px, dark, tablet, and back.
const go=async()=>{await page.evaluate(()=>chConsoleOpen('approvals'));await page.getByRole('heading',{name:'ch 控制台',exact:true}).waitFor();};
await page.setViewportSize({width:320,height:640});
await page.evaluate(()=>{chConsoleLeave();});await go();
assert.equal(await overflow(),false,'320 px: no horizontal overflow');
await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});
assert.equal(await overflow(),false,'dark: no horizontal overflow');
await page.setViewportSize({width:1024,height:768});
await page.evaluate(()=>{chConsoleLeave();});await go();
assert.equal(await page.evaluate(()=>!!(typeof LAYOUT!=='undefined'&&LAYOUT.wide&&LAYOUT.frame&&LAYOUT.frame.root.dataset.mode==='solo')),true,'tablet solo');
let backs=0;while(backs<4&&await page.evaluate(()=>!!CH.view)){await page.evaluate(()=>pocketBack());backs++;}
assert.equal(await page.evaluate(()=>CH.view),null,'back leaves the console');

assert.deepEqual(errors,[]);
await browser.close();
console.log('PASS: ch console — approvals, ports, rules, bridges, paused, old ch, 320 px, dark, tablet');
})().catch(e=>{console.error(e);process.exit(1);});
