// Computers without Herdr (tmux.js): connect normally, 会话 is the tmux list with a quiet note (no
// error banner; 历史 stays available from local transcripts; no Herdr polling), a Claude inside a tmux pane opens as a chat with its
// transcript, 新建 tmux 会话 and 关闭 (with a confirmation sheet), the "neither installed" empty state,
// and a second computer with Herdr next to it (every request names its computer, the tmux list
// follows the computer on screen). Native SSH is a strict offline fake; nothing leaves the page.
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
 const now=Date.now()/1000,iso=s=>new Date((now-s)*1000).toISOString();
 const D={A:{id:'A',name:'树莓派',user:'pi',host:'pi.invalid',port:22,remember:true},B:{id:'B',name:'工作站',user:'w',host:'work.invalid',port:22,remember:true}};
 const rec={id:'rec1',thread:'T1',title:'整理日志轮转',provider:'claude',parent:null,cwd:'/home/pi/logs',modified:now-90};
 const pane=(id,o)=>({pane_id:id,identity:'tm-'+id.slice(1),session:'main',window_index:0,window_name:'bash',pane_index:0,window_panes:1,active:false,attached:false,command:'bash',cwd:'/home/pi',width:120,height:40,...o});
 const claude=()=>({pane_id:'%1',identity:'ag-1',agent:'claude',agent_status:fx.status,terminal_id:'tmux:tm-1',terminal_title:'✳ 整理日志轮转',cwd:'/home/pi/logs',foreground_cwd:'/home/pi/logs',tmux:true,tmux_session:'main'});
 window.fx={D,links:[],active:'',calls:[],unnamed:[],status:'idle',noTmux:false,killFail:'',newFail:'',
  tmux:{A:[pane('%0',{window_name:'top',command:'htop',active:true,attached:true}),pane('%1',{window_index:1,window_name:'claude',command:'node',cwd:'/home/pi/logs'}),pane('%2',{session:'work',window_name:'build',command:'make',cwd:'/home/pi/src'})],
   B:[pane('%5',{session:'dev',window_name:'server',command:'node',cwd:'/srv/app'})]},
  history:[{id:'1:0',kind:'user',text:'把 /var/log 的轮转配置理一下',title:'',call_id:'',timestamp:iso(300)},{id:'2:0',kind:'assistant',text:'改好了 logrotate，保留 14 天。',title:'',call_id:'',timestamp:iso(280)}]};
 const B_AGENT={pane_id:'w1:p1',terminal_id:'term-b',agent:'codex',agent_status:'idle',identity:'id-b',cwd:'/srv/app',title:'Beta 任务'};
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};
  try{
   if(op==='devices')data={devices:[D.A,D.B],version:'test'};
   else if(op==='connect'){const d=D[a.id];if(!fx.links.includes(d.id))fx.links.push(d.id);fx.active=d.id;
    data={device:d,devices:[D.A,D.B],ready:true,connections:fx.links.map(x=>D[x]),host:d.id==='A'?{python:'3.11',herdr:false,running:null,tmux:!fx.noTmux}:{python:'3.12',herdr:true,running:1,tmux:true}};}
   else if(op==='activate'){fx.active=a.device;}
   else if(op==='remote'){fx.calls.push({...a});
    if(!a.device){fx.unnamed.push(a.op);throw Error('request without device: '+a.op);}
    const A=a.device==='A';
    if(a.op==='sessions')data=A?{sessions:[],herdr:false,tmux:!fx.noTmux}:{herdr:true,sessions:[{name:'main',running:true}]};
    else if(a.op==='doctor')data=A?{herdr:false,running:null,tmux:!fx.noTmux}:{herdr:true,running:1,tmux:true};
    else if(a.op==='tmux'){if(A&&fx.noTmux){data={available:false,panes:[]};}
     else data={available:true,looked:fx.looked||['/tmp/tmux-1000'],skipped:[],servers:[],panes:fx.tmux[a.device].map(p=>p.pane_id==='%1'?{...p,agent:{...claude(),...(a.resolve?{history_ref:{status:'matched',source:'open-file',record_id:'rec1',thread:'T1',record:rec}}:{})}}:p)};}
    else if(a.op==='tmuxInfo'&&fx.infoFail)throw Error(fx.infoFail);
    else if(a.op==='tmuxInfo')data={available:true,home:'/home/pi',dirs:[{path:'/home/pi/logs',source:'tmux'},{path:'/home/pi/src',source:'history',modified:now-7200},...(fx.infoMore||[])],sessions:['main','work']};
    else if(a.op==='tmuxNew'){if(fx.newFail)throw Error(fx.newFail);const n=fx.made=(fx.made||0)+1;const p=pane('%'+(6+n),{session:a.name||String(2+n),cwd:a.cwd==='~'?'/home/pi':a.cwd});fx.tmux.A.push(p);data={created:true,session:p.session,cwd:a.cwd,pane:p};}
    else if(a.op==='tmuxKill'){if(fx.killFail)throw Error(fx.killFail);const p=fx.tmux.A.find(x=>x.pane_id===a.target);fx.tmux.A=fx.tmux.A.filter(x=>a.scope==='session'?x.session!==p.session:x.pane_id!==a.target);data={closed:true,scope:a.scope,session:p.session};}
    else if(a.op==='tmuxRead'){const p=fx.tmux.A.concat(fx.tmux.B).find(x=>x.pane_id===a.target);if(!p)throw Error('这个 tmux 窗格已经关了或换了，回到列表刷新一下');data={text:'pi@pi:~$ ',ansi:'pi@pi:~$ ',pane:p};}
    else if(a.op==='history')data={record:rec,messages:fx.history,before:0,has_more:false,children:[]};
    else if(a.op==='catalog')data={records:[rec],total:1,next:null};
    else if(a.op==='hidden')data={ids:[]};
    else if(a.op==='native')data={sessions:[]};
    else if(a.op==='read'){if(a.target!=='%1'||a.identity!=='ag-1')throw Error('Agent changed or disappeared; reload the agent list');data={text:'✻ Working… (esc to interrupt)',agent_status:fx.status,modes:null,bg:null};}
    // The open tmux chat's own status read (pane as target); Herdr's status never goes to A.
    else if(a.op==='status'&&a.target){if(!A)throw Error('tmux status on B');data={tmux:true,agents:a.target==='%1'?[claude()]:[]};}
    else if(A&&a.op==='glance')data={previews:{}};
    else if(a.op==='agents'&&a.target)data={follow:true,state:'same',agents:[{...claude(),history_ref:{status:'matched',source:'open-file',record_id:'rec1',thread:'T1',record:rec}}],pane:null};
    else if(a.op==='prompt'){data={sent:true,receipt:a.id};}
    else if(a.op==='account')data={ssh_user:'pi',hostname:'pi'};
    else if(!A&&a.op==='agents')data={agents:[B_AGENT]};
    else if(!A&&a.op==='status')data={agents:[B_AGENT]};
    else if(!A&&a.op==='glance')data={previews:{}};
    else if(!A&&a.op==='createInfo')data={kinds:[{kind:'codex',found:true}],more:[],workspaces:[],dirs:[],home:'/home/w'};
    else throw Error('unexpected remote op '+a.op+' on '+a.device);}
   else if(['watchState','protect','settings','cachePut','setAlerts','dropImages','dropFiles'].includes(op))data={};
   else if(op==='cacheGet')data={value:null};
   else throw Error('unexpected native op '+op);
  }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
  setTimeout(()=>nativeResult(id,{ok:true,data}),op==='remote'&&a.op==='tmuxInfo'&&fx.infoDelay||10);}};
});
await page.goto(require('./ui_bundle.cjs').url(html));
await page.evaluate(()=>{window.followInterval=()=>1e9;});
const shot=async name=>{if(!shots)return;await page.evaluate(()=>document.getElementById('toast')?.classList.remove('show'));await page.waitForTimeout(300);await page.screenshot({path:path.join(shots,'tmuxonly-'+name+'.png')});};
const dark=async name=>{await page.evaluate(()=>{document.documentElement.dataset.theme='dark';});await shot(name+'-dark');await page.evaluate(()=>{document.documentElement.dataset.theme='light';});};
const calls=(op,dev)=>page.evaluate(([o,d])=>fx.calls.filter(c=>c.op===o&&(!d||c.device===d)),[op,dev]);
const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
const card=name=>page.locator('.device-card').filter({hasText:name});
const role=(r,name)=>page.getByRole(r,{name,exact:true});

// ── 1. Connect a computer without Herdr: tmux is the page, quietly ──
await card('树莓派').getByRole('button',{name:'连接设备',exact:true}).click();
await page.locator('.tmux-only-note').waitFor();
await page.locator('.tmux-row').first().waitFor();
assert.equal(await page.locator('.tmux-only-note').textContent(),'这台电脑没装 Herdr，只显示 tmux');
assert.equal(await page.locator('.connection-status').count(),0,'no warning banner for a missing Herdr');
assert.equal(await role('button','历史').count(),1,'历史 stays available without Herdr');
await role('button','历史').click();await page.getByText('整理日志轮转',{exact:true}).waitFor();await role('button','会话').click();
for(const t of ['会话','终端','设备','设置'])assert.equal(await role('button',t).count(),1);
// The Claude in pane %1 is listed as an agent (with its transcript found), the rest as terminals.
const agent=page.locator('.tmux-agents .agent-row');
await agent.first().waitFor();
await page.waitForFunction(()=>/整理日志轮转/.test(document.querySelector('.tmux-agents .agent-row')?.textContent||''));
assert.equal(await agent.count(),1);
assert.match(await agent.locator('.card-meta').textContent(),/tmux/);
assert.equal(await page.locator('.tmux-row').count(),2);
assert.equal(await page.locator('.tmux-label').textContent().then(t=>t.replace(/\s+/g,'')),'tmux会话3');
assert.ok((await calls('tmux','A')).some(c=>c.resolve),'transcripts are looked up for agents in panes');
for(const op of ['agents','status','createInfo','panes'])assert.equal((await calls(op,'A')).filter(c=>!c.target).length,0,'no Herdr op on a computer without Herdr: '+op);
assert.ok((await calls('catalog','A')).length>=1,'历史 reads local transcripts without Herdr');
assert.equal(await page.locator('#toast.show').count(),0,'no error toast');
assert.equal(await overflow(),false);
await shot('list');await dark('list');
// The row hint follows the main list: once a long press (or a swipe action) has been used it retires.
const hint=page.getByText('左滑或长按一行：关闭、更多操作',{exact:true});
await hint.waitFor();
await page.locator('.tmux-row').first().dispatchEvent('contextmenu');
await page.getByRole('dialog').waitFor();
await page.evaluate(()=>{closeSheet();render();});
await page.locator('.tmux-row').first().waitFor();
assert.equal(await hint.count(),0,'the row hint retires after use');
assert.equal(await page.evaluate(()=>CLOSE_HINT.done),true,'same flag as the main list');
console.log('PASS: a computer without Herdr shows its tmux sessions, quietly, without Herdr requests');

// ── 2. The Claude in a tmux pane opens as a chat with its transcript ──
await agent.first().click();
await page.getByText('改好了 logrotate，保留 14 天。').waitFor();
assert.equal(await role('button','对话').count(),1);
assert.equal(await role('button','终端').count()>=1,true);
const hist=await calls('history','A');assert.equal(hist.at(-1).record_id,'rec1');
await page.getByRole('textbox',{name:'消息输入框'}).fill('顺便看看 nginx 的');
await role('button','发送消息').click();
await page.waitForFunction(()=>fx.calls.some(c=>c.op==='prompt'));
const sent=(await calls('prompt','A'))[0];
assert.deepEqual([sent.target,sent.identity,sent.text],['%1','ag-1','顺便看看 nginx 的']);
assert.match(sent.id,/^[0-9a-f-]{36}$/);
// Its state follows the pane (its own status read, pane as target), not Herdr's status.
await page.evaluate(()=>{fx.status='working';});
await page.waitForFunction(()=>S.chat?.agent?.agent_status==='working',null,{timeout:12000});
await shot('chat');
await role('button','终端').first().click();
await page.waitForFunction(()=>fx.calls.some(c=>c.op==='read'&&c.target==='%1'&&c.identity==='ag-1'));
assert.equal((await calls('status','A')).filter(c=>c.target!=='%1').length,0);
await page.waitForFunction(()=>fx.calls.some(c=>c.op==='status'&&c.target==='%1'&&c.identity==='ag-1'),null,{timeout:12000});
await page.evaluate(()=>{fx.status='idle';});
await role('button','返回列表').click();
await page.locator('.tmux-only-note').waitFor();
console.log('PASS: a tmux Claude opens with its conversation; sends and reads go to its pane');

// ── 3. 新建 tmux 会话 ──
await role('button','新建 tmux 会话').click();
const sheetBox=page.locator('.sheet.tmux-new');await sheetBox.waitFor();
await page.waitForFunction(()=>fx.calls.some(c=>c.op==='tmuxInfo'));
await sheetBox.getByText('logs',{exact:true}).waitFor();
const name=page.getByRole('textbox',{name:'会话名字'});
await name.fill('a b');
assert.match(await page.locator('.tmux-name-note').textContent(),/只能用英文字母/);
await role('button','开始新建 tmux 会话').click();await page.waitForTimeout(200);
assert.equal((await calls('tmuxNew')).length,0,'a bad name is not sent');
await name.fill('work');assert.match(await page.locator('.tmux-name-note').textContent(),/已经有叫 work/);
await name.fill('scratch');
await sheetBox.getByRole('radio',{name:/logs/}).click();
await shot('new');await dark('new');
await page.evaluate(()=>{fx.newFail='没创建：这个目录不存在';});
await role('button','开始新建 tmux 会话').click();
await page.locator('.new-status.error').waitFor();
assert.match(await page.locator('.new-status').textContent(),/这个目录不存在/);
await page.evaluate(()=>{fx.newFail='';});
await role('button','开始新建 tmux 会话').click();
await page.locator('#pane-screen').waitFor();
const made=(await calls('tmuxNew')).at(-1);
assert.deepEqual([made.name,made.cwd],['scratch','/home/pi/logs']);
assert.notEqual(made.id,(await calls('tmuxNew'))[0].id,'a new press is a new id');
assert.equal(await page.locator('.term-head h2').textContent(),'scratch:bash');
await role('button','返回列表').click();
await page.waitForFunction(()=>document.querySelectorAll('.tmux-row').length===3);
console.log('PASS: 新建 tmux 会话 validates the name, picks a directory and opens the new pane');

// ── 3b. The directory list is slow or cannot be read: 家目录 still works (sent as ~) ──
await page.evaluate(()=>{fx.infoDelay=4000;TX_NEW.info=null;TX_NEW.infoFor='';});
await role('button','新建 tmux 会话').click();await sheetBox.waitFor();
await sheetBox.getByText('正在读取最近用过的目录…',{exact:true}).waitFor();
assert.equal(await sheetBox.getByRole('radio',{name:/^家目录/}).getAttribute('aria-checked'),'true');
await role('button','开始新建 tmux 会话').click();
await page.locator('#pane-screen').waitFor();
assert.equal((await calls('tmuxNew')).at(-1).cwd,'~','home before the list arrived goes out as ~ (the bridge expands it)');
await role('button','返回列表').click();await page.locator('.tmux-only-note').waitFor();
await page.evaluate(()=>{fx.infoDelay=0;fx.infoFail='tmux 没有及时回应';TX_NEW.info=null;TX_NEW.infoFor='';});
await role('button','新建 tmux 会话').click();await sheetBox.waitFor();
await sheetBox.getByText('读不到最近用过的目录（tmux 没有及时回应），家目录和手填的路径照样能用',{exact:true}).waitFor();
assert.equal(await role('button','开始新建 tmux 会话').isDisabled(),false,'a failed list does not block creating');
await shot('new-noinfo');
// An empty typed path says what to type, in the sheet.
await sheetBox.getByRole('radio',{name:/^其他目录/}).click();
await role('button','开始新建 tmux 会话').click();
await sheetBox.getByText('先填目录路径，比如 ~/projects/app',{exact:true}).waitFor();
await page.getByRole('textbox',{name:'目录路径'}).fill('~/src/');
await role('button','开始新建 tmux 会话').click();
await page.locator('#pane-screen').waitFor();
assert.equal((await calls('tmuxNew')).at(-1).cwd,'~/src/');
await role('button','返回列表').click();await page.locator('.tmux-only-note').waitFor();
await page.evaluate(()=>{fx.infoFail='';fx.tmux.A=fx.tmux.A.filter(p=>!['%8','%9'].includes(p.pane_id));TX_NEW.info=null;TX_NEW.infoFor='';tmuxLoad();});
await page.waitForFunction(()=>document.querySelectorAll('.tmux-row').length===3);
console.log('PASS: 新建 tmux 会话 works while the directory list is slow or unreadable, errors stay in the sheet');

// ── 3c. A path typed while the list loads keeps the focus (and the keyboard) and stays clear of the
//        pinned footer; back keeps typed text; Enter creates; the header follows a renamed window;
//        a list from before is asked again ──
await page.evaluate(()=>{fx.infoDelay=1500;TX_NEW.info=null;TX_NEW.infoFor='';});
await page.setViewportSize({width:390,height:520});// about what the soft keyboard leaves
await role('button','新建 tmux 会话').click();await sheetBox.waitFor();
await sheetBox.getByRole('radio',{name:/^其他目录/}).click();
const pathBox=page.getByRole('textbox',{name:'目录路径'});
await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='目录路径');
await page.keyboard.type('~/sr');
await page.waitForTimeout(250);
const clear=await page.evaluate(()=>{const i=document.querySelector('.tmux-new .new-path').getBoundingClientRect(),f=document.querySelector('.tmux-new .new-foot').getBoundingClientRect();return i.bottom<=f.top+1;});
assert.equal(clear,true,'the focused path input is not under the pinned footer');
await sheetBox.getByText('logs',{exact:true}).waitFor();
assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'目录路径','the list arriving keeps the focus');
await page.waitForTimeout(100);
assert.equal(await page.evaluate(()=>{const i=document.querySelector('.tmux-new .new-path').getBoundingClientRect(),f=document.querySelector('.tmux-new .new-foot').getBoundingClientRect();return i.bottom<=f.top+1;}),true,'rows arriving above it do not push the path under the footer');
await page.keyboard.type('c');
assert.equal(await pathBox.inputValue(),'~/src');
await page.evaluate(()=>pocketBack());
assert.equal(await sheetBox.count(),1,'back does not throw a typed path away');
await page.keyboard.press('Enter');
await page.locator('#pane-screen').waitFor();
assert.equal((await calls('tmuxNew')).at(-1).cwd,'~/src');
await page.setViewportSize({width:390,height:844});
await page.evaluate(()=>{const p=fx.tmux.A.at(-1);p.window_name='vim';p.command='vim';});
await page.waitForFunction(()=>document.getElementById('term-title')?.textContent.endsWith(':vim'),null,{timeout:5000});
await role('button','返回列表').click();await page.locator('.tmux-only-note').waitFor();
await page.evaluate(()=>{fx.infoDelay=0;fx.infoMore=[{path:'/home/pi/new-proj',source:'history',modified:Date.now()/1000-60}];});
await role('button','新建 tmux 会话').click();await sheetBox.waitFor();
await sheetBox.getByText('new-proj',{exact:true}).waitFor();
await page.evaluate(()=>{closeSheet();fx.infoMore=[];fx.tmux.A=fx.tmux.A.filter(p=>p.cwd!=='~/src');tmuxLoad();});
await page.waitForFunction(()=>document.querySelectorAll('.tmux-row').length===3);
console.log('PASS: typing a path while the list loads, footer clearance, back, Enter, renamed window, refreshed list');

// ── 4. 关闭 with a confirmation ──
const row=page.locator('.tmux-row').filter({hasText:'work:build'});
await row.click({button:'right'});
await page.locator('.sheet').getByText('关闭…').click();
const close=page.locator('.sheet.close-sheet');await close.waitFor();
const go=close.locator('.sheet-actions .primary');
assert.equal(await go.isDisabled(),true,'nothing closes before a choice');
assert.match(await close.textContent(),/里面正在运行 make/);
await close.getByRole('radio',{name:/结束整个会话「work」/}).click();
assert.equal(await go.textContent(),'结束会话');
await shot('close');await dark('close');
await page.evaluate(()=>{fx.killFail='没关：这个会话里开着 Herdr，只能单独关窗格';});
await go.click();await close.locator('.close-status.error').waitFor();
assert.match(await close.locator('.close-status').textContent(),/开着 Herdr/);
await page.evaluate(()=>{fx.killFail='';});
await close.getByRole('radio',{name:/关闭这个窗口/}).click();await go.click();
await page.waitForFunction(()=>!document.querySelector('.sheet'));
const kill=(await calls('tmuxKill')).at(-1);
assert.deepEqual([kill.target,kill.identity,kill.scope],['%2','tm-2','pane']);
await page.waitForFunction(()=>![...document.querySelectorAll('.tmux-row')].some(n=>/work:build/.test(n.textContent)));
// An unknown outcome locks the sheet: no second press.
await page.locator('.tmux-row').filter({hasText:'main:top'}).click({button:'right'});
await page.locator('.sheet').getByText('关闭…').click();
await page.evaluate(()=>{fx.killFail='关闭结果未知：tmux 没及时回应。刷新看看，别直接再点';});
await close.getByRole('radio',{name:/关闭这个窗口/}).click();
const before=(await calls('tmuxKill')).length;await go.click();
await close.locator('.close-status.error').waitFor();
assert.equal(await go.textContent(),'结果未知');assert.equal(await go.isDisabled(),true);
assert.equal((await calls('tmuxKill')).length,before+1);
await page.evaluate(()=>{fx.killFail='';closeSheet();});
console.log('PASS: closing asks how, says what runs there, and never repeats an unknown outcome');

// ── 5. Narrow screen ──
await page.setViewportSize({width:320,height:640});await page.evaluate(()=>render());
assert.equal(await overflow(),false,'no sideways scroll at 320 px');await shot('narrow');
await role('button','新建 tmux 会话').click();await page.locator('.sheet.tmux-new').waitFor();assert.equal(await overflow(),false);await shot('new-narrow');
await page.evaluate(()=>closeSheet());await page.setViewportSize({width:390,height:844});

// ── 6. A second computer with Herdr: its own list; tmux lists follow the computer on screen ──
await role('button','设备').click();
await card('工作站').getByRole('button',{name:'连接设备',exact:true}).click();
await page.getByRole('button',{name:/Beta 任务/}).first().waitFor();
await page.locator('.tmux-row').filter({hasText:'dev:server'}).waitFor();
assert.equal(await page.locator('.tmux-only-note').count(),0,'with Herdr, tmux is a section under the agents');
assert.equal(await role('button','历史').count(),1);
assert.equal(await page.locator('.tmux-row').filter({hasText:'main:top'}).count(),0,'the other computer\'s panes are not shown');
await role('button','新建会话').click();
await page.locator('.new-sheet .new-tmux').waitFor();
await page.evaluate(()=>closeSheet());
await page.getByRole('group',{name:'切换设备'}).getByRole('button',{name:/树莓派/}).click();
await page.locator('.tmux-only-note').waitFor();
await page.locator('.tmux-row').filter({hasText:'main:top'}).waitFor();
assert.equal(await page.locator('.tmux-row').filter({hasText:'dev:server'}).count(),0);
assert.deepEqual(await page.evaluate(()=>fx.unnamed),[],'every request names its computer');
console.log('PASS: two computers, one without Herdr: lists stay per computer');

// ── 6b. A named server's pane; an empty list says where it looked ──
await page.evaluate(()=>{fx.tmux.A.push({pane_id:'%0@0123456789ab',identity:'tm-l0',server:'lab',session:'lab',window_index:0,window_name:'repl',pane_index:0,window_panes:1,active:false,attached:false,command:'python3',cwd:'/home/pi',width:120,height:40});});
await page.locator('.tmux-row').filter({hasText:'服务器 lab'}).waitFor({timeout:6000});
// 新建 makes a session on the default server: a name used only on server "lab" is still free.
await role('button','新建 tmux 会话').click();await sheetBox.waitFor();
await name.fill('lab');assert.doesNotMatch(await page.locator('.tmux-name-note').textContent(),/已经有叫/);
await name.fill('main');assert.match(await page.locator('.tmux-name-note').textContent(),/已经有叫 main/);
await page.evaluate(()=>closeSheet());
await page.evaluate(()=>{fx.keepA=fx.tmux.A;fx.tmux.A=[];fx.looked=['/tmp/tmux-1000','/run/user/1000/tmux-1000'];loadLive();});
await page.getByText('还没有 tmux 会话',{exact:true}).waitFor();
const emptyText=await page.locator('.empty').filter({hasText:'还没有 tmux 会话'}).textContent();
assert.match(emptyText,/没找到正在运行的 tmux（看过 \/tmp\/tmux-1000、\/run\/user\/1000\/tmux-1000）/);
assert.match(emptyText,/几秒内会自动出现/);assert.match(emptyText,/别的电脑上.*「设备」页/);
assert.equal(await overflow(),false);
await shot('empty');await dark('empty');
// A session started on the computer shows up on its own (no refresh).
await page.evaluate(()=>{fx.tmux.A=fx.keepA;fx.looked=null;});
await page.locator('.tmux-row').first().waitFor({timeout:6000});
console.log('PASS: named servers are shown, 新建 checks names on the default server, an empty list says where it looked');

// ── 7. Neither Herdr nor tmux ──
await page.evaluate(()=>{fx.noTmux=true;S.hostTmux=false;TX.by.clear();loadLive();});
await page.getByText('这台电脑上没有 Herdr，也没有 tmux').waitFor();
assert.match(await page.locator('.tmux-none').textContent(),/sudo apt install tmux/);
assert.equal(await role('button','重新检查').count(),1);
assert.equal(await role('button','新建 tmux 会话').count(),0);
await shot('none');await dark('none');
await role('button','重新检查').click();
await page.waitForFunction(()=>fx.calls.some(c=>c.op==='doctor'));
// tmux installed now: a recheck (or the list's own poll, whichever comes first) brings the list.
await page.evaluate(()=>{fx.noTmux=false;recheckHost();});
await page.locator('.tmux-row').first().waitFor({timeout:12000});
console.log('PASS: neither installed: says what to install, rechecks');

assert.deepEqual(errors,[]);
console.log('PASS: tmux-only UI');
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
