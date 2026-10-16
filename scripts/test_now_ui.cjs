// 立即发送: a queued message interrupts the busy agent (Esc), waits until Herdr reports it stopped,
// then goes out once through the checked send. Offline: native SSH is a strict fake that records everything.
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
 const rec=(id,thread,title)=>({id,thread,title,provider:'claude',parent:null,cwd:'/work/proj',modified:now-60});
 const R={r1:rec('r1','t1','整理发布脚本'),r2:rec('r2','t2','另一段对话')};
 let n=50;const msg=(kind,text,age=30)=>({id:(++n)+':0',kind,text,title:'',call_id:'',timestamp:iso(age)});
 const H={r1:[msg('user','把发布脚本整理一下',300),msg('assistant','好，我先看看现在的脚本。',290)],r2:[msg('user','新对话的问题',20),msg('assistant','新对话的回答。',10)]};
 const ref=r=>({status:'matched',source:'native-process',record_id:r.id,thread:r.thread,record:r});
 const A1={pane_id:'w1:p1',terminal_id:'term1',agent:'claude',agent_status:'working',identity:'id-1',cwd:'/work/proj',title:'整理发布脚本',history_ref:ref(R.r1)};
 window.fx={R,H,A1,ref,list:[A1],follow:null,calls:[],attempts:[],prompts:[],promptErrors:[],nx:[],keys:[],stuck:false,keyError:'',
  say(text,rid='r1',pic=false){H[rid].push(msg('user',text+(pic?'\n\n[图片] /home/u/.herdr-pocket/uploads/2026-10-15/'+'e'.repeat(64)+'.jpg':''),1));},
  pic(label){const c=document.createElement('canvas');c.width=240;c.height=180;const g=c.getContext('2d');const gr=g.createLinearGradient(0,0,240,180);gr.addColorStop(0,'hsl(200,55%,62%)');gr.addColorStop(1,'hsl(240,60%,38%)');g.fillStyle=gr;g.fillRect(0,0,240,180);g.fillStyle='#fff';g.font='600 26px sans-serif';g.fillText(label,20,100);return c.toDataURL('image/jpeg',0.8);}};
 const device={id:'fx',name:'测试电脑',user:'u',host:'fixture.invalid',port:22,remember:true};
 const strip=a=>{const {history_ref,...rest}=a;return rest;};
 let att=0;
 window.PocketNative={request(id,op,raw){const a=JSON.parse(raw);let data={};fx.nx.push({op,args:a});
  try{
  if(op==='devices')data={devices:[device],version:'test',connected:device};
  else if(op==='remote'){fx.calls.push({op:a.op,target:a.target||''});
   if(a.op==='sessions')data={sessions:[{name:'fx',running:true}]};
   else if(a.op==='agents'){if(a.target){const row=fx.list.find(x=>x.pane_id===a.target);data=fx.follow?JSON.parse(JSON.stringify(fx.follow)):row?{follow:true,state:'same',agents:[row],pane:null}:{follow:true,state:'gone',agents:[],pane:null};}else data={agents:fx.list};}
   else if(a.op==='status')data={agents:fx.list.map(strip)};
   else if(a.op==='history')data={record:Object.values(R).find(r=>r.id===a.record_id),messages:H[a.record_id]||[],before:0,has_more:false,children:[]};
   else if(a.op==='read')data={text:'$ '};
   else if(a.op==='catalog')data={records:[],total:0,next:null};
   else if(a.op==='prompt'){fx.attempts.push(a);const e=fx.promptErrors.shift();if(e)throw Error(e);fx.prompts.push(a);data={sent:true,receipt:a.id};}
   else if(a.op==='account')data={ssh_user:'u',hostname:'fx'};
   else if(a.op==='key'){fx.keys.push(a);if(fx.keyError)throw Error(fx.keyError);if(!fx.stuck)setTimeout(()=>{fx.list=fx.list.map(x=>({...x,agent_status:'idle'}));},1500);data={sent:true};}
   else throw Error('unexpected remote op '+a.op);}
  else if(op==='pickImages')data={images:[{id:'att-'+(++att),thumb:fx.pic('截图'),width:800,height:600,bytes:40000,type:'jpg'}],failed:0};
  else if(op==='image')data={url:fx.pic('截图'),width:240,height:180};
  else if(op==='uploadImage')data={name:'2026-10-15/'+'e'.repeat(64)+'.jpg',sha256:'e'.repeat(64),bytes:40000};
  else if(!['watchState','protect','setAlerts','dropImages'].includes(op))throw Error('unexpected native op '+op);
  }catch(e){setTimeout(()=>nativeResult(id,{ok:false,error:e.message}),10);return;}
  setTimeout(()=>nativeResult(id,{ok:true,data}),10);}};
});
await page.goto('data:text/html;charset=utf-8,'+encodeURIComponent(html));
await page.evaluate(()=>{window.followInterval=()=>1e9;});
const shot=async name=>{await page.evaluate(()=>document.getElementById('toast').classList.remove('show'));await page.waitForTimeout(250);await page.screenshot({path:path.join(shots,'now-'+name+'.png')});};
const box=()=>page.getByRole('textbox',{name:'消息输入框',exact:true});
const send=async text=>{await box().fill(text);await page.getByRole('button',{name:'发送消息',exact:true}).click();};
// Herdr reports a status; the UI notices it like a regular poll would.
const status=async st=>{await page.evaluate(async st=>{fx.list=fx.list.map(a=>({...a,agent_status:st}));S.statusBusy=false;await refreshStatus();},st);};
const prompts=()=>page.evaluate(()=>fx.prompts.map(p=>p.text));
const attempts=()=>page.evaluate(()=>fx.attempts.length);
const bubble=text=>page.locator('.message.queued').filter({hasText:text});


await page.getByRole('button',{name:/整理发布脚本/}).click();
await page.getByText('好，我先看看现在的脚本。').first().waitFor();

// 1. Busy agent: the message queues and offers 立即发送; one tap interrupts, waits for idle, sends once.
await send('先停下，改成处理这个');
const row=bubble('先停下，改成处理这个');await row.waitFor();
await row.getByRole('button',{name:'立即发送',exact:true}).click();
await page.getByText('正在中断当前工作…').waitFor();
await shot('interrupting-390');
await page.waitForFunction(()=>fx.prompts.length===1,null,{timeout:15000});
assert.deepEqual(await page.evaluate(()=>fx.keys.map(k=>k.key)),['esc']);
assert.deepEqual(await prompts(),['先停下，改成处理这个']);
// The interrupt went out before the prompt, and the agent was seen idle in between.
const order=await page.evaluate(()=>fx.calls.map(c=>c.op));
// A status read happened after the Esc and before the prompt (status polls may also run later).
const k=order.indexOf('key'),p=order.indexOf('prompt',k);assert(k>=0&&p>k&&order.slice(k+1,p).includes('status'),'status read between Esc and prompt: '+order.join(','));
await page.locator('.message.user.pending').filter({hasText:'先停下，改成处理这个'}).getByText('已送达 Agent').waitFor();
assert.equal(await bubble('先停下，改成处理这个').count(),0);
await shot('sent-390');
console.log('PASS: 立即发送 interrupts with Esc, waits for idle, sends exactly once, shows the real result');

// 2. It goes ahead of what was already waiting.
await page.evaluate(()=>{fx.H.r1.push({id:'90:0',kind:'user',text:'先停下，改成处理这个',title:'',call_id:'',timestamp:new Date().toISOString()});});
await status('working');
await send('第一条，本来排着');await send('第二条，要插队');
await bubble('第二条，要插队').getByRole('button',{name:'立即发送',exact:true}).click();
await page.waitForFunction(()=>fx.prompts.length===2,null,{timeout:15000});
assert.equal((await prompts())[1],'第二条，要插队');
assert.equal(await bubble('第一条，本来排着').count(),1,'the other one still waits its turn');
console.log('PASS: 立即发送 jumps the queue; the rest keep waiting');

// 3. The agent does not stop: nothing is sent, the reason is shown, and it can be tried again.
await page.evaluate(()=>{fx.H.r1.push({id:'91:0',kind:'user',text:'第二条，要插队',title:'',call_id:'',timestamp:new Date().toISOString()});Q.clear();});
await status('working');await page.evaluate(()=>{fx.stuck=true;});
await send('停不下来的情况');
const before=await page.evaluate(()=>fx.attempts.length);
await bubble('停不下来的情况').getByRole('button',{name:'立即发送',exact:true}).click();
await bubble('停不下来的情况').getByText(/中断后它还没停下，消息没发/).waitFor({timeout:30000});
assert.equal(await page.evaluate(()=>fx.attempts.length),before,'never sent while it is still working');
assert.equal(await bubble('停不下来的情况').getByRole('button',{name:'立即发送',exact:true}).count(),1);
console.log('PASS: an agent that does not stop gets nothing; the message stays with the reason');

// 4. The interrupt itself fails: nothing is sent, the queue pauses with the reason.
await page.evaluate(()=>{fx.keyError='没发出去：这个窗格已经不在了，回到列表刷新一下';});
await bubble('停不下来的情况').getByRole('button',{name:'立即发送',exact:true}).click();
await page.locator('.queue-bar').getByText(/没能中断它/).waitFor({timeout:8000});
assert.equal(await page.evaluate(()=>fx.attempts.length),before);
console.log('PASS: a failed interrupt sends nothing and says why');

// 5. The phone's screenshot case: a send reported "unknown" had in fact arrived, and the person sent the
// same words again (queued, the agent was busy). Once the transcript shows it, the first becomes
// delivered and the queued copy is held for the person instead of going out twice.
await page.evaluate(()=>{fx.keyError='';fx.stuck=false;Q.clear();S.outbox=[];fx.list=fx.list.map(a=>({...a,agent_status:'idle'}));});
await status('idle');
await page.evaluate(()=>{fx.promptErrors.push('等了 35 秒还没有回应；请求已经发出，结果未知。先刷新看看，别直接重发。');});
await send('明天再测试今天先到这');
await page.locator('.message.user.pending').filter({hasText:'明天再测试今天先到这'}).getByText('发送未确认').waitFor();
await status('working');
await send('明天再测试今天先到这');
await bubble('明天再测试今天先到这').waitFor();
const tries=await page.evaluate(()=>fx.attempts.length);
await page.evaluate(()=>{fx.H.r1.push({id:'95:0',kind:'user',text:'明天再测试今天先到这',title:'',call_id:'',timestamp:new Date().toISOString()});});
await page.waitForFunction(id=>{const has=S.messages.some(m=>m.id===id);if(!has&&!S.polling)fetchHistory();return has;},'95:0',{polling:300,timeout:20000});
await page.getByText('刚才那条其实送到了').waitFor();
assert.equal(await page.locator('.message.user.pending').filter({hasText:'明天再测试今天先到这'}).count(),0,'no 发送未确认 left');
await page.locator('.queue-bar').getByText(/和刚送到的消息一样/).waitFor();
await status('idle');await page.waitForTimeout(3500);
assert.equal(await page.evaluate(()=>fx.attempts.length),tries,'the duplicate never goes out by itself');
console.log('PASS: an unknown send seen in the transcript becomes delivered; a queued duplicate waits for the person');

// Claude Code wraps pasted text as <pasted_content id=…>: the transcript copy (with a ch picture line)
// must match the phone's own copy, so the pending bubble settles instead of showing twice.
assert.deepEqual(await page.evaluate(()=>{const h='a'.repeat(64);const t='<pasted_content id="b39b">\n终端界面，没有颜色，不好看\n\n</pasted_content id="b39b">\n\n[图片 · ch-local fetch] ch-file://'+h+'.jpg';const x=imgSplit({text:t});return [x.text,msgSig(x.text)===msgSig('终端界面，没有颜色，不好看'),x.specs.length,cleanTitle(t).includes('pasted_content')];}),
 ['终端界面，没有颜色，不好看',true,1,false]);
console.log('PASS: pasted-content wrappers are hidden and do not block settling');

const ids=await page.evaluate(()=>[...fx.attempts,...fx.keys].map(x=>x.id));
assert.equal(new Set(ids).size,ids.length,'every request has its own id');
assert.deepEqual(errors,[]);
await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
