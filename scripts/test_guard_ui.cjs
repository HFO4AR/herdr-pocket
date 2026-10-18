// Herdr's server down / restarted and the opt-in 「Herdr 守护」 (guard.js): a stopped server says
// how it ended and offers 「启动 Herdr」 behind a sheet (one herdrStart with a UUID, never on its own);
// after the restart 会话 says which agents came back and which did not (with a way to 历史); the 设备
// card shows Herdr and the guard; the guard sheet shows exactly what would be installed and binds
// guardSet to that plan's digest; 关闭守护; unsupported computers; a version mismatch has no button.
// Native SSH is a strict offline fake; nothing leaves the page.
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
 const now=Math.floor(Date.now()/1000);
 const D={id:'A',name:'工作站',user:'yuki',host:'box.invalid',port:22,remember:true};
 const agent=(n,session,title)=>({pane_id:'w1:p'+n,terminal_id:'t'+n,agent:n===1?'claude':'codex',agent_status:'idle',identity:'id'+n+session,agent_session:{kind:'id',value:session},cwd:'/home/yuki/p',title});
 const UNIT='# Installed by Herdr Pocket (「Herdr 守护」).\n[Service]\nExecStart=/usr/bin/python3 -I /home/yuki/.herdr-pocket/guard/herdr-guard.py --watch --herdr /home/yuki/.local/bin/herdr --boot\nKillMode=process\n';
 window.fx={calls:[],unexpected:[],cachePuts:[],running:false,mismatch:false,guard:{supported:true,kind:'systemd',installed:false},platform:'linux',
  started:now-30,
  snapshot:{started:now-86400,agents:[{agent:'claude',title:'修日志轮转',session:'S-1'},{agent:'codex',title:'重构 bridge',session:'S-2'}]},
  agents:()=>fx.running?[agent(1,'S-1','修日志轮转'),agent(3,'S-9','新开的 Codex')]:[],
  plan:o=>fx.platform==='darwin'?{supported:false,kind:null,reason:'macOS 上还不支持 Herdr 守护（它靠 systemd 或 cron）。Herdr 停了可以点「启动 Herdr」。',options:o}:
   {supported:true,kind:'systemd',options:o,linger:false,oom:{floor:100,default:200,set:100},herdr:'/home/yuki/.local/bin/herdr',
    files:[{path:'/home/yuki/.herdr-pocket/guard/herdr-guard.py',content:'#!/usr/bin/env python3\n"""Herdr Pocket 「Herdr 守护」"""\nprint(1)\n',sha256:'a4c2600686a33827f0e0',what:'守护脚本'},
     {path:'/home/yuki/.config/systemd/user/herdr-pocket-guard.service',content:UNIT.replace('--boot',(o.boot?'--boot':'')+(o.always?' --always':'')),what:'systemd 用户服务'}],
    commands:['systemctl --user daemon-reload','systemctl --user enable --now herdr-pocket-guard.service'],
    remove:['systemctl --user disable --now herdr-pocket-guard.service（只停守护自己）'],digest:'dg-'+(o.boot?'b':'')+(o.always?'a':'')}};
 const health=()=>({installed:true,platform:fx.platform,client:{version:'0.8.2',protocol:20},
  server:fx.mismatch?{state:'mismatch',version:'0.8.1',compatible:false}:fx.running?{state:'running',version:'0.8.2',compatible:true,pid:4321,started:fx.started,previous:{pid:1234,how:'oom',oom:'kernel',at:fx.started-40,started:now-90000}}:
   {state:'stopped',ended:{pid:1234,how:'oom',oom:'kernel',at:now-600,started:now-90000}},
  ...(fx.running?{}:{start:{method:'detached',linger:false,kill_user_processes:false}}),guard:fx.guard});
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};
  try{
   if(op==='devices')data={devices:[D],version:'test'};
   else if(op==='connect')data={device:D,devices:[D],ready:true,connections:[D],host:{python:'3.12',herdr:true,running:fx.running?1:0,tmux:true,server:{state:fx.running?'running':'stopped'}}};
   else if(op==='remote'){fx.calls.push({...a});
    if(a.device!=='A')throw Error('request without device: '+a.op);
    if(a.op==='sessions')data={herdr:true,sessions:[{name:'default',running:fx.running,default:true}],...(fx.running?{server:{pid:4321,started:fx.started,clean:false}}:{})};
    else if(a.op==='doctor')data={herdr:true,running:fx.running?1:0,tmux:true,server:{state:fx.mismatch?'mismatch':fx.running?'running':'stopped',version:'0.8.1'}};
    else if(a.op==='herdrHealth')data=health();
    else if(a.op==='herdrStart'){if(fx.running)throw Error('没启动：Herdr 已经在运行了，刷新一下就好');fx.running=true;data={started:true,running:true,method:'detached'};}
    else if(a.op==='guardPlan')data=fx.plan({boot:a.boot!==false,always:!!a.always});
    else if(a.op==='guardSet'){data=a.enable?(fx.guard={supported:true,kind:'systemd',installed:true,active:true,enabled:true,boot:!!a.boot,always:!!a.always,outdated:false,events:[]},{enabled:true,active:true}):(fx.guard={supported:true,kind:'systemd',installed:false},{enabled:false});}
    else if(a.op==='agents'||a.op==='status')data={agents:fx.agents()};
    else if(a.op==='tmux')data={available:true,panes:[],looked:[],skipped:[],servers:[]};
    else if(a.op==='glance')data={previews:{}};
    else if(a.op==='account')data={ssh_user:'yuki',hostname:'box'};
    else if(a.op==='catalog')data={records:[],total:0,next:null};
    else if(a.op==='hidden')data={ids:[]};
    else if(a.op==='hello')data={version:'0.6.0',protocol:1,python:'3.12'};
    else{fx.unexpected.push(a.op);throw Error('unexpected remote op '+a.op);}}
   else if(op==='cacheGet')data={value:a.key==='herdr'?fx.snapshot:null};
   else if(op==='cachePut'){if(a.key==='herdr')fx.cachePuts.push(a.value);data={};}
   else if(['watchState','protect','settings','setAlerts','activate'].includes(op))data={};
   else throw Error('unexpected native op '+op);
  }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
  setTimeout(()=>nativeResult(id,{ok:true,data}),10);}};
});
await page.goto(require('./ui_bundle.cjs').url(html));
await page.evaluate(()=>{window.followInterval=()=>1e9;});
const shot=async name=>{if(!shots)return;await page.evaluate(()=>document.getElementById('toast')?.classList.remove('show'));await page.waitForTimeout(300);await page.screenshot({path:path.join(shots,'guard-'+name+'.png')});};
const dark=async name=>{await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot(name+'-dark');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});};
const calls=op=>page.evaluate(o=>fx.calls.filter(c=>c.op===o),op);
const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth||[...document.querySelectorAll('.sheet,.main')].some(n=>n.scrollWidth>n.clientWidth+1));
const role=(r,name)=>page.getByRole(r,{name,exact:true});
const narrow=async what=>{await page.setViewportSize({width:320,height:640});assert.equal(await overflow(),false,what+' fits 320 px');await page.setViewportSize({width:390,height:844});};

// ── 1. Herdr's server is down: 会话 says how it ended and what went with it ──
await page.locator('.device-card').filter({hasText:'工作站'}).getByRole('button',{name:'连接设备',exact:true}).click();
const down=page.locator('.hg-down');
await down.waitFor();
await page.waitForFunction(()=>/内存不够/.test(document.querySelector('.hg-down')?.textContent||''));
assert.match(await down.textContent(),/Herdr 没在运行/);
assert.match(await down.textContent(),/OOM killer/);
await page.waitForFunction(()=>/之前在跑的 2 个 Agent/.test(document.querySelector('.hg-down')?.textContent||''));
assert.match(await down.textContent(),/修日志轮转/);
assert.equal(await page.locator('.connection-status.warn').count(),0,'on 会话 the page card says it, not a second banner');
assert.equal((await calls('herdrStart')).length,0,'nothing starts by itself');
assert.equal(await down.getByRole('button',{name:'启动 Herdr'}).count(),1);
assert.equal(await down.getByRole('button',{name:'开启 Herdr 守护'}).count(),1);
await narrow('down card');
await shot('down');await dark('down');
// Elsewhere the banner carries the same start.
await role('button','设备').click();
await page.locator('.connection-status.warn').waitFor();
assert.equal(await page.locator('.connection-status.warn').getByRole('button',{name:'启动 Herdr'}).count(),1);
assert.match(await page.locator('.account-card.current').textContent(),/Herdr没在运行/);
console.log('PASS: a stopped Herdr says how it ended (memory), which agents went with it, starts nothing');

// ── 2. 启动 Herdr: a sheet first, then exactly one start ──
await page.locator('.account-card.current').getByRole('button',{name:'启动 Herdr'}).click();
await role('dialog','启动 Herdr').waitFor();
assert.match(await role('dialog','启动 Herdr').textContent(),/SSH 断开以后它照样运行/);
assert.match(await role('dialog','启动 Herdr').textContent(),/不会开第二个/);
assert.equal((await calls('herdrStart')).length,0,'the sheet alone starts nothing');
await narrow('start sheet');
await shot('start-sheet');
await role('dialog','启动 Herdr').getByRole('button',{name:'启动 Herdr',exact:true}).click();
await page.getByText('Herdr 启动了',{exact:true}).waitFor();
const starts=await calls('herdrStart');assert.equal(starts.length,1);
assert.match(starts[0].id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,'a fresh UUID receipt');
await page.waitForFunction(()=>/运行中/.test(document.querySelector('.account-card.current')?.textContent||''));
assert.equal(await page.locator('.connection-status.warn').count(),0,'the banner goes once it runs');
console.log('PASS: 启动 Herdr behind a sheet, one herdrStart with a UUID, the card follows');

// ── 3. After the restart 会话 says which agents came back ──
await role('button','会话').click();
const card=page.locator('.hg-restart');
await card.waitFor();
assert.match(await card.textContent(),/重新启动过/);
assert.match(await card.textContent(),/上次内存不够，被系统结束了/);
assert.match(await card.textContent(),/接回了 1 个/);
assert.match(await card.textContent(),/没回来 1 个/);
assert.match(await card.locator('.hg-lost').textContent(),/重构 bridge/);
assert.doesNotMatch(await card.locator('.hg-lost').textContent(),/修日志轮转/,'a resumed one is not listed as lost');
await page.waitForFunction(()=>fx.cachePuts.some(v=>v.started===fx.started&&v.agents.length===2));
await narrow('restart card');
await shot('restart');await dark('restart');
// 去历史 hands the lost ones to resumeLost() when another module provides it, else opens 历史.
await page.evaluate(()=>{window.resumeLost=list=>{window.lostSeen=list.map(x=>x.title);};});
await card.getByRole('button',{name:'去历史找回对话'}).click();
assert.deepEqual(await page.evaluate(()=>window.lostSeen),['重构 bridge']);
await page.evaluate(()=>{delete window.resumeLost;});
await card.getByRole('button',{name:'去历史找回对话'}).click();
await page.waitForFunction(()=>S.tab==='history');
await role('button','会话').click();
await card.waitFor();
await card.getByRole('button',{name:'知道了'}).click();
assert.equal(await card.count(),0,'dismissed');
await page.evaluate(()=>loadLive());await page.waitForTimeout(200);
assert.equal(await page.locator('.hg-restart').count(),0,'stays dismissed for this restart');
console.log('PASS: restart card: came back / did not, 去历史 hook, dismiss once');

// ── 4. The guard sheet shows exactly what would be installed; 开启守护 binds to it ──
await role('button','设备').click();
const cur=page.locator('.account-card.current');
await page.waitForFunction(()=>/Herdr 守护没开/.test(document.querySelector('.account-card.current')?.textContent.replace(/\s+/g,' ')||'')||/Herdr守护没开/.test(document.querySelector('.account-card.current')?.textContent||''));
await cur.getByRole('button',{name:'Herdr 守护设置'}).click();
const gs=role('dialog','Herdr 守护');
await gs.getByText('会装哪些东西',{exact:true}).waitFor();
assert.match(await gs.textContent(),/你自己用 herdr server stop 关掉的，它不去拉起/);
assert.match(await gs.textContent(),/OOM 分数调到 100/);
assert.match(await gs.textContent(),/-500/);
assert.match(await gs.textContent(),/没开 linger/);
assert.equal(await gs.getByText('loginctl enable-linger',{exact:true}).count(),1);
assert.equal((await calls('guardSet')).length,0);
await gs.getByText('会装哪些东西',{exact:true}).click();
await gs.getByText('/home/yuki/.config/systemd/user/herdr-pocket-guard.service',{exact:true}).waitFor();
assert.match(await gs.textContent(),/KillMode=process/);
assert.match(await gs.textContent(),/systemctl --user enable --now herdr-pocket-guard.service/);
await narrow('guard sheet');
await shot('guard-sheet');await dark('guard-sheet');
// Turning 正常关掉的也拉起 on fetches the plan for it; 开启守护 sends that plan's digest.
await gs.getByRole('checkbox',{name:'正常关掉的也拉起'}).check({force:true});
await page.waitForFunction(()=>fx.calls.filter(c=>c.op==='guardPlan').some(c=>c.always===true));
await gs.getByText('会装哪些东西',{exact:true}).waitFor();
await gs.getByRole('button',{name:'开启守护'}).click();
await page.getByText('守护开好了',{exact:true}).waitFor();
const sets=await calls('guardSet');assert.equal(sets.length,1);
assert.deepEqual([sets[0].enable,sets[0].boot,sets[0].always,sets[0].digest],[true,true,true,'dg-ba']);
await page.waitForFunction(()=>/开着/.test(document.querySelector('.account-card.current')?.textContent||''));
console.log('PASS: guard sheet shows files, commands, linger and OOM notes; 开启守护 binds the shown plan');

// ── 5. 关闭守护 ──
await cur.getByRole('button',{name:'Herdr 守护设置'}).click();
await gs.getByRole('button',{name:'关闭守护'}).waitFor();
assert.equal(await gs.getByRole('button',{name:'更新守护'}).count(),0,'nothing to update when it matches');
await gs.getByRole('button',{name:'关闭守护'}).click();
await page.getByText('守护关了，Herdr 照常运行',{exact:true}).waitFor();
assert.deepEqual((await calls('guardSet')).map(c=>c.enable),[true,false]);
await page.waitForFunction(()=>/没开/.test(document.querySelector('.account-card.current')?.textContent||''));
console.log('PASS: 关闭守护 is one explicit request; Herdr keeps running');

// ── 6. Unsupported computer and a version mismatch ──
await page.evaluate(()=>{fx.platform='darwin';fx.guard={supported:false,kind:null,reason:'macOS',installed:false};hgState().health=null;render();});
await page.waitForFunction(()=>/不支持/.test(document.querySelector('.account-card.current')?.textContent||''));
await cur.getByRole('button',{name:'Herdr 守护设置'}).click();
await gs.getByText(/macOS 上还不支持/).waitFor();
assert.equal(await gs.getByRole('button',{name:'开启守护'}).count(),0);
await page.evaluate(()=>closeSheet());
await page.evaluate(()=>{fx.mismatch=true;hgState().health=null;recheckHost();});
await page.locator('.connection-status.warn').filter({hasText:'Herdr 版本不配套'}).waitFor();
await page.waitForFunction(()=>/版本不配套/.test(document.querySelector('.account-card.current')?.textContent||''));
assert.equal(await page.locator('.connection-status.warn').getByRole('button',{name:'启动 Herdr'}).count(),0,'never offers to restart a running Herdr');
assert.equal(await cur.getByRole('button',{name:'启动 Herdr'}).count(),0);
console.log('PASS: unsupported computer has no 开启守护; a mismatch is explained without a button');

assert.deepEqual(await page.evaluate(()=>fx.unexpected),[]);
assert.equal((await calls('herdrStart')).length,1,'started once in the whole run');
assert.deepEqual(errors,[]);
console.log('PASS: guard UI');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
