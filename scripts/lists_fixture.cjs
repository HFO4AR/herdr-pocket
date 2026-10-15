// Realistic offline fixture for the list screens (会话 / 历史 / 终端): many agents across projects,
// Codex + Claude, remote ch panes, 240 history records with sub-agents, several plain panes.
// install(page) swaps `remote` for a recorded fake; nothing leaves the page.
module.exports.install=async function install(page,opts={}){
 await page.evaluate(opts=>{
  const now=Date.now()/1000,H=3600,D=86400;
  const projects=[['stm32_host','/home/me/IterxAI/stm32_host'],['herdr-pocket','/home/me/project/herdr-pocket'],['ch-cli','/mnt/E/project/ch-cli'],['dmimu_host_app','/mnt/E/project/dmimu_host_app'],['site','/home/me/site'],['notes','/home/me/notes']];
  const titles=['修复 Gateway OTA 断点续传','检查运动控制回零逻辑','整理串口日志解析','CAM 预处理参数对齐','补齐 Host 回归测试','对话页的阅读体验','连接不稳定排查','新建会话面板','历史分页游标','主题与暗色模式','ch resume 远端恢复','发布 0.6.0','文档：多设备指南','清理构建缓存','IMU 标定流程','加速度计零偏','博客首页改版','周报整理','读书笔记归档','依赖升级','i18n 文案统一','固件版本核对'];
  const st=['working','blocked','idle','done','idle','working','idle','done','idle','idle','working','idle','done','idle','idle','blocked','idle','done','idle','idle','working','idle'];
  const agents=titles.slice(0,opts.agents??22).map((t,i)=>{const [p,cwd]=projects[i%projects.length];const remoteCh=i%7===3;
   return {pane_id:'w'+(1+i%4)+':p'+(i+1),identity:'id'+i,agent:i%3===1?'codex':'claude',agent_status:st[i],cwd,
    terminal_title:remoteCh?p+': ch':(i%5===4?p+': claude':t+' | '+p),
    agent_session:{value:'s'+i},
    history_ref:remoteCh?{status:'matched',remote:{session:'x'},record:{id:'r'+i,title:t,modified:now-i*900}}:{status:'matched',record:{id:'r'+i,title:t,modified:now-i*1700-60}}};});
  const recs=[];for(let i=0;i<(opts.records??240);i++){const [p,cwd]=projects[(i*7)%projects.length];const t=titles[i%titles.length]+(i>=titles.length?' #'+Math.floor(i/titles.length):'');
   const parent=i%9===4?'t'+(i-1):null;recs.push({id:'h'+i,thread:'t'+i+'abcdef00',provider:i%3===0?'codex':'claude',parent,role:parent?'explorer':undefined,title:parent?'子任务：'+t:t,cwd,modified:now-i*(i<30?2400:13000)});}
  const panes=[{pane_id:'w1:p20',terminal_id:'t1',identity:'pa',workspace_label:'stm32_host',tab_id:'w1:t3',cwd:'/home/me/IterxAI/stm32_host',terminal_title:'stm32_host: python3 apps/host_app/server.py'},
   {pane_id:'w1:p21',terminal_id:'t2',identity:'pb',workspace_label:'stm32_host',tab_id:'w1:t4',cwd:'/home/me/IterxAI/stm32_host/motion_controller',terminal_title:'motion_controller: bash'},
   {pane_id:'w2:p22',terminal_id:'t3',identity:'pc',workspace_label:'herdr-pocket',tab_id:'w2:t1',cwd:'/home/me/project/herdr-pocket',terminal_title:'herdr-pocket: ./gradlew assembleDebug'},
   {pane_id:'w3:p23',terminal_id:'t4',identity:'pd',workspace_label:'~',tab_id:'w3:t1',cwd:'/home/me',terminal_title:'htop'},
   {pane_id:'w4:p24',terminal_id:'t5',identity:'pe',workspace_label:'site',tab_id:'w4:t2',cwd:'/home/me/site',terminal_title:'site: npm run dev'}].slice(0,opts.panes??5);
  window.fx={calls:[],agents,recs,panes,sessions:opts.sessions||[{name:'default',running:true}]};
  remote=async(op,args={})=>{fx.calls.push({op,args});await new Promise(r=>setTimeout(r,30));
   if(op==='sessions')return{sessions:fx.sessions};
   if(op==='agents'||op==='status')return{agents:fx.agents};
   if(op==='panes')return{panes:fx.panes};
   if(op==='paneRead')return{text:'$ npm run dev\n\n  VITE v5.4.2  ready in 312 ms\n\n  ➜  Local:   http://localhost:5173/\n'};
   if(op==='hidden'){let ids=fx.hidden||[];if(args.add)ids=ids.filter(x=>!args.add.includes(x)).concat(args.add);if(args.remove)ids=ids.filter(x=>!args.remove.includes(x));fx.hidden=ids;return{ids};}
   if(op==='closeInfo')return{ch:false,focused:false,workspace_label:'',tab_label:'1',tab_panes:2};
   if(op==='account')return{ssh_user:'me',hostname:'ws'};
   if(op==='createInfo')return{kinds:[{kind:'codex',found:true},{kind:'claude',found:true},{kind:'ch',found:true}],home:'/home/me',
    workspaces:[{workspace_id:'w1',label:'stm32_host',focused:true,dirs:[{path:'/home/me/IterxAI/stm32_host',agents:7,panes:9}]},{workspace_id:'w2',label:'herdr-pocket',dirs:[{path:'/home/me/project/herdr-pocket',agents:4,panes:5}]}],
    dirs:[{path:'/home/me/IterxAI/stm32_host',source:'pane',agents:7,workspace_id:'w1'},{path:'/home/me/project/herdr-pocket',source:'pane',agents:4,workspace_id:'w2'},{path:'/mnt/E/project/ch-cli',source:'pane',agents:3,workspace_id:'w1'},{path:'/home/me/notes',source:'history',modified:now-D*2},{path:'/home/me/site',source:'history',modified:now-D*5},{path:'/mnt/E/project/dmimu_host_app',source:'history',modified:now-D*9}]};
   if(op==='create')return fx.created||{created:true,kind:args.kind,cwd:args.cwd,pane_id:'w1:p99',state:'ready',detected:true};
   if(op==='paneKey'||op==='paneRun'||op==='paneText')return{sent:true};
   if(op==='catalog'){let rows=fx.recs;const q=(args.query||'').toLowerCase();if(q)rows=rows.filter(x=>(x.title+' '+x.cwd+' '+x.thread).toLowerCase().includes(q));if(args.thread)rows=rows.filter(x=>x.thread===args.thread);const o=args.offset||0;return{records:rows.slice(o,o+100),total:rows.length,next:rows.length>o+100?o+100:null};}
   if(op==='history')return{messages:[],children:[],before:0,has_more:false};
   if(op==='read')return{text:'$ '};
   throw Error('fixture: unexpected op '+op);};
  try{localStorage.clear();}catch(_){}
  S.demo=false;S.device={id:'d1',name:'家里的电脑',user:'me',host:'frp.example.net',port:2223};S.agents=[];S.session='';S.records=[];
  // A few agents finished while nobody looked, one changed state a moment ago.
  S.unread.add('default/id2');S.unread.add('default/id7');
 },opts);
};
