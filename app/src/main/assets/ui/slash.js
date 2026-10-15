'use strict';
// Slash commands.
//  · Typing "/" at the start of the composer lists the agent's commands (built-in lists below, read
//    from the installed Claude Code 2.1.268 and Codex 0.162.1 builds, plus the user's own commands,
//    skills and prompts by name from the bridge `commands` op). Tap or Enter inserts it.
//  · A slash command's output is drawn by the TUI and mostly never reaches the transcript (Codex
//    records none; Claude logs only some, and /status, /model, /resume… open a panel first). So
//    after sending one, the app reads the pane's screen (read-only) until it settles and keeps it in
//    a 「命令输出」 card for this run. An open panel or picker gets the keys it needs (Esc, ↑ ↓ Enter);
//    while it stays open, normal sends and the queue wait, so a message never lands in a picker.
//  · Claude transcript rows <command-name>/<local-command-stdout> render as one command card.
// Sending keeps every existing rule: fresh UUID per request, nothing is replayed after an unknown outcome.
const SLASH_BUILTIN={
 claude:[
  ['help','查看帮助和全部命令'],['clear','清空上下文开新会话，旧的可以 /resume'],['compact','压缩上下文，把前面的对话总结一下'],
  ['resume','恢复之前的对话',1],['rewind','把代码或对话退回到之前某一步',1],['model','切换模型',1],['effort','设置推理强度',1],
  ['status','版本、模型、账号和连接状态',1],['usage','费用、套餐额度和用量',1],['context','看看上下文占了多少'],['diff','查看还没提交的改动',1],
  ['config','打开设置',1],['permissions','管理工具的允许和拒绝规则',1],['memory','编辑 CLAUDE.md 记忆',1],['init','生成 CLAUDE.md 项目说明'],
  ['plan','进入计划模式，或查看当前计划'],['goal','设个目标，停下前它会自查'],['btw','顺便问个小问题，不打断主线'],['recap','现在生成一句话会话回顾'],
  ['rename','给这段对话改个名'],['branch','从这里分出一段新对话'],['fork','派一个带着完整上下文的后台 Agent'],['copy','复制 Claude 最后一条回复'],
  ['export','把对话导出到文件或剪贴板',1],['tasks','查看和管理后台运行的任务',1],['agents','管理子 Agent 配置',1],['skills','列出可用技能',1],
  ['mcp','管理 MCP 服务器',1],['hooks','查看工具事件的钩子配置',1],['plugin','管理插件',1],['reload-plugins','让刚改的插件在本会话生效'],
  ['reload-skills','重新加载磁盘上新增或改过的技能'],['add-dir','添加一个工作目录'],['cd','把会话移到另一个目录'],['ide','管理 IDE 集成',1],
  ['security-review','安全审查当前分支待提交的改动'],['insights','生成一份会话分析报告'],['theme','切换主题',1],['tui','切换终端界面渲染方式',1],
  ['statusline','设置状态栏'],['keybindings','打开快捷键配置文件'],['voice','开关语音模式'],['background','把会话转到后台，空出终端'],
  ['stop','停止这个后台会话，记录和 worktree 保留'],['loops','查看、新建和删除循环任务',1],['release-notes','看更新说明',1],
  ['version','查看本会话的版本'],['update','切到最新版本，对话继续'],['feedback','反馈问题给 Anthropic',1],['privacy-settings','查看和修改隐私设置',1],
  ['login','登录 Anthropic 账号',1],['logout','退出 Anthropic 账号'],['exit','退出 Claude Code']],
 codex:[
  ['model','选择模型和推理强度',1],['permissions','设置 Codex 能做什么',1],['status','当前配置和 token 用量'],['review','审查当前改动，找出问题',1],
  ['new','开一段新对话'],['resume','恢复保存的对话',1],['fork','从当前对话分叉',1],['init','生成 AGENTS.md 项目说明'],
  ['compact','总结对话，免得上下文超限'],['recap','现在总结一下这段对话'],['plan','切到计划模式'],['goal','设定或查看长任务的目标'],
  ['diff','查看 git 改动（含未跟踪文件）'],['mention','引用一个文件'],['usage','查看账号用量'],['mcp','列出 MCP 工具'],
  ['skills','用技能提升特定任务的表现',1],['agents','打开 Agent 指挥中心',1],['subagents','切换本会话的子 Agent',1],['side','开一段临时的旁支对话'],
  ['copy','复制最后一条回复'],['export','把对话导出为 Markdown'],['rename','给这段对话改个名',1],['archive','归档这段会话'],
  ['delete','永久删除这段会话',1],['worktree','在新的 worktree 里开始或继续对话',1],['ps','列出后台终端'],['stop','停掉所有后台终端'],
  ['clear','清屏并开新对话'],['cd','切换工作目录'],['pwd','显示当前工作目录'],['statusline','设置状态栏显示什么',1],
  ['title','设置终端标题显示什么',1],['theme','选择代码高亮主题',1],['experimental','开关实验功能',1],['memories','设置记忆的使用和生成',1],
  ['hooks','查看和管理生命周期钩子',1],['keymap','修改快捷键',1],['vim','开关 Vim 编辑模式'],['raw','切换原始滚动模式，方便复制'],
  ['plugins','浏览插件',1],['apps','管理应用',1],['import','从 Claude Code 导入设置和对话',1],['feedback','把日志发给维护者',1],
  ['rollout','显示对话记录文件的路径'],['debug-config','显示配置来源，排查用'],['logout','退出 Codex 登录'],['quit','退出 Codex']]};
const SLASH_KIND={command:'自定义',skill:'技能',prompt:'提示词'};
const SL={custom:new Map(),cards:new Map(),seq:0};// custom: agentKey → {list,at,loading}; cards: draftKey → [card]
function slashProvider(a){return a?.agent==='codex'?'codex':'claude';}
function slashList(a){
 const built=SLASH_BUILTIN[slashProvider(a)].map(([name,desc,panel])=>({name,desc,panel:!!panel,kind:''}));
 const own=(a&&SL.custom.get(agentKey(a))?.list||[]).filter(c=>!built.some(b=>b.name===c.name)).map(c=>({name:c.name,desc:(c.scope==='project'?'项目':'个人')+SLASH_KIND[c.kind]+(c.kind==='skill'?'':'命令'),kind:c.kind,panel:false}));
 return built.concat(own);}
// The bridge adds the user's own commands once per agent (and again after five minutes).
function slashLoad(a){
 if(!a||S.demo)return;const k=agentKey(a),hit=SL.custom.get(k);if(hit&&(hit.loading||Date.now()-hit.at<300000))return;
 SL.custom.set(k,{list:hit?.list||[],at:Date.now(),loading:true});
 remote('commands',{session:S.session,target:a.pane_id,identity:a.identity}).then(r=>{SL.custom.set(k,{list:Array.isArray(r?.commands)?r.commands.filter(c=>c&&typeof c.name==='string'):[],at:Date.now()});slashRefresh();})
  .catch(()=>{SL.custom.set(k,{list:hit?.list||[],at:Date.now()});});}
function slashName(text){const m=String(text||'').match(/^\/([A-Za-z][\w.:-]{0,63})(?:\s|$)/);return m?m[1]:'';}
// A slash command: a known command name, or a single bare "/word" (not a path like /tmp/x.png).
function slashIs(text,a){const t=String(text||'').trim();if(!t||t.length>2000||t.includes('\n'))return false;const name=slashName(t);if(!name)return false;
 return slashList(a).some(c=>c.name===name)||/^\/[a-z][\w.:-]{0,40}$/i.test(t);}

// ─── Suggestions ────────────────────────────────────────────────────────────
// Prefix matches first, then anywhere in the name, then in the Chinese description.
function slashMatches(a,query){
 const q=query.toLowerCase();const list=slashList(a);if(!q)return list;
 const score=c=>c.name.toLowerCase().startsWith(q)?0:c.name.toLowerCase().includes(q)?1:c.desc.toLowerCase().includes(q)?2:9;
 return list.map((c,i)=>({c,i,s:score(c)})).filter(x=>x.s<9).sort((x,y)=>x.s-y.s||x.i-y.i).map(x=>x.c);}
function slashToken(input){const v=input.value;const m=v.match(/^\/([^\s\/]*)$/);return m&&input.selectionStart===v.length?m[1]:null;}
function slashSuggest(compose,input){
 const a=S.chat?.agent;const q=a&&!S.chat.stale?slashToken(input):null;
 if(q===null){slashClose(compose);return;}
 slashLoad(a);const items=slashMatches(a,q);const st=compose.slash||(compose.slash={active:0});
 if(st.query!==q){st.active=0;st.query=q;}st.items=items;st.active=Math.min(st.active,Math.max(0,items.length-1));
 let pop=compose.parentNode?.querySelector('.slash-pop');
 if(!pop){pop=el('div','slash-pop');pop.id='slash-pop';pop.setAttribute('role','listbox');pop.setAttribute('aria-label','可用命令');
  // Keep the keyboard up: tapping a row must not blur the textarea first.
  pop.addEventListener('pointerdown',e=>e.preventDefault());pop.addEventListener('mousedown',e=>e.preventDefault());compose.before(pop);}
 pop.replaceChildren();
 const head=el('div','slash-head');head.append(el('span','',providerName(a.agent)+' 命令'),el('span','slash-count',items.length?items.length+' 个':''));pop.append(head);
 if(!items.length)pop.append(el('p','slash-empty','没有匹配的命令，照样可以直接发出去'));
 items.forEach((c,i)=>{const b=btn('','slash-item'+(i===st.active?' active':''),()=>slashPick(compose,input,c));b.id='slash-opt-'+i;b.setAttribute('role','option');b.setAttribute('aria-selected',String(i===st.active));b.tabIndex=-1;
  const name=el('span','slash-name','/'+c.name);const desc=el('span','slash-desc',c.desc);b.append(name,desc);if(c.kind)b.append(el('span','slash-tag',SLASH_KIND[c.kind]||''));pop.append(b);});
 input.setAttribute('aria-expanded','true');input.setAttribute('aria-controls','slash-pop');
 if(items.length)input.setAttribute('aria-activedescendant','slash-opt-'+st.active);else input.removeAttribute('aria-activedescendant');
 pop.querySelector('.slash-item.active')?.scrollIntoView({block:'nearest'});}
function slashClose(compose){const pop=compose?.parentNode?.querySelector('.slash-pop');if(pop)pop.remove();if(compose)compose.slash=null;
 const input=compose?.querySelector('textarea');if(input){input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}}
function slashRefresh(){const compose=document.querySelector('#composer .composer');const input=compose?.querySelector('textarea');if(compose?.slash&&input)slashSuggest(compose,input);}
function slashPick(compose,input,c){
 input.value='/'+c.name+' ';input.focus();input.selectionStart=input.selectionEnd=input.value.length;
 slashClose(compose);input.dispatchEvent(new Event('input'));}
// Arrow keys move, Enter or Tab inserts, Esc closes. Returns true when the key was handled.
function slashKeydown(e,compose,input){
 const st=compose.slash;if(!st||!document.getElementById('slash-pop'))return false;
 if(e.key==='Escape'){e.preventDefault();slashClose(compose);return true;}
 if(!st.items?.length)return false;
 if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();st.active=(st.active+(e.key==='ArrowDown'?1:-1)+st.items.length)%st.items.length;slashSuggest(compose,input);return true;}
 if((e.key==='Enter'&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey)||e.key==='Tab'){e.preventDefault();slashPick(compose,input,st.items[st.active]);return true;}
 return false;}

// ─── Output cards ───────────────────────────────────────────────────────────
function slashCards(key=draftKey()){return SL.cards.get(key)||[];}
function slashCard(key,text){const a=S.chat?.agent;const card={id:'s'+(++SL.seq),key,text:text.trim(),name:slashName(text),at:Date.now(),state:'sending',reason:'',screen:'',menu:null,panel:false,capturing:false,done:false,error:'',readAt:0,
  info:slashList(a).find(c=>c.name===slashName(text))||null};
 if(!SL.cards.has(key))SL.cards.set(key,[]);const list=SL.cards.get(key);list.push(card);if(list.length>12)list.shift();return card;}
function slashDrop(card){const list=SL.cards.get(card.key);if(list){const i=list.indexOf(card);if(i>=0)list.splice(i,1);}}
// The latest card shows a panel or picker that is still open (as of its last read).
function slashPanelCard(key=draftKey()){const last=slashCards(key).filter(c=>c.state==='sent').at(-1);return last&&last.panel?last:null;}
function slashPanelOpen(key){return !!slashPanelCard(key);}
// Before a normal send: re-read the screen if the last command left a panel open; refuse while it still is.
async function slashHold(a,key){
 const card=slashPanelCard(key);if(!card)return false;
 if(!card.capturing)await slashCapture(card,{quick:true});
 if(!card.panel)return false;
 toast('上一条命令的面板还开着，先在卡片里点 Esc 关掉再发');S.stick=true;paintTimeline();return true;}
const SLASH_PANEL=/\besc(ape)?\b\s*(to|·|:)?\s*(cancel|close|exit|go back|dismiss|back|clear)|enter to (select|confirm|continue|apply|save)|↑\s*\/?\s*↓|arrow keys|tab to (cycle|switch|change)|space to (toggle|select)|type to (search|filter)/i;
function slashPanel(text,menu){if(menu)return true;const tail=String(text||'').replace(/\s+$/,'').split('\n').slice(-16).join('\n');return SLASH_PANEL.test(tail);}
// The part of the screen from the command's own echo down; the last 40 lines when the echo is gone.
function slashExcerpt(text,cmd){return slashCut(text,cmd).text;}
function slashCut(text,cmd){
 const lines=String(text||'').replace(/\s+$/,'').split('\n');const name=slashName(cmd);let at=-1;
 if(name){const re=new RegExp('^[\\s›❯>│▌]*\\/'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(\\s|$)');for(let i=lines.length-1;i>=0;i--)if(re.test(lines[i])){at=i;break;}}
 const out=(at>=0?lines.slice(at):lines.slice(-40));return {text:out.slice(-160).join('\n'),found:at>=0};}
const slashSleep=ms=>new Promise(r=>setTimeout(r,ms));
// Read-only screen capture until the screen stops changing (about 1–7 s).
async function slashCapture(card,opts={}){
 const c=S.chat,a=c?.agent;if(!a||c.stale||card.capturing||card.key!==draftKey())return;
 card.capturing=true;card.error='';slashPaint(card);
 const started=Date.now(),limit=opts.quick?2500:7000;let prev=null;
 try{
  if(!opts.quick)await slashSleep(opts.after??600);
  while(S.chat===c){
   let r;try{r=await remote('read',{session:S.session,target:a.pane_id,identity:a.identity,menu:true});}catch(e){card.error='读屏失败：'+(e.message||e);break;}
   if(S.chat!==c)break;
   // Closing a panel (Claude /status) leaves nothing of it on screen: keep what it showed.
   const cut=slashCut(r.text,card.text),panel=slashPanel(r.text,r.menu);
   if(!panel&&!cut.found&&(card.panel||card.closed)&&card.screen){card.closed=true;}else{card.screen=cut.text;card.closed=false;}
   card.menu=r.menu||null;card.panel=panel;card.status=r.agent_status||'';card.readAt=Date.now();
   if(typeof applyReadStatus==='function')applyReadStatus(r.agent_status);slashPaint(card);
   if(prev!==null&&r.text===prev&&Date.now()-started>1200)break;
   if(opts.quick&&prev===null&&card.panel===false)break;
   if(Date.now()-started>limit)break;prev=r.text;await slashSleep(700);}
 }finally{card.capturing=false;card.done=true;slashPaint(card);}}
async function slashKey(card,key,label){
 const a=S.chat?.agent;if(!a||S.chat.stale||card.busy)return;card.busy=true;slashPaint(card);
 try{await remote('key',{session:S.session,target:a.pane_id,identity:a.identity,key,id:uuid()});if(S.demo){toast('演示：未发送按键');return;}toast('已发送 '+label);card.busy=false;await slashCapture(card,{after:450});}
 catch(e){toast('按键未确认：'+(e.message||e)+'。不会自动重发。');}
 finally{card.busy=false;slashPaint(card);if(!S.demo)setTimeout(()=>refreshStatus(),300);}}
// Redraw one card in place (no full timeline render while a capture is polling).
function slashPaint(card){const n=document.querySelector('[data-slash="'+card.id+'"]');if(!n){if(card.key===draftKey()&&slashCards(card.key).includes(card))paintTimeline();return;}
 const box=n.querySelector('.slash-screen');const top=box?box.scrollTop:0,stuck=box?box.scrollHeight-box.scrollTop-box.clientHeight<24:true;
 const next=slashCardView(card,n.classList.contains('in-turn'));n.replaceWith(next);const nb=next.querySelector('.slash-screen');if(nb)nb.scrollTop=stuck?nb.scrollHeight:top;}
function slashStateText(card){
 if(card.state==='sending')return '发送中…';if(card.state==='rejected')return '没发出去';if(card.state==='failed')return '发送未确认';
 if(card.capturing&&!card.screen)return '正在读终端画面…';if(card.panel)return card.menu?'等你选':'面板开着';if(card.capturing)return '正在更新…';
 return card.closed?'面板已关':card.readAt?'读于 '+clock(card.readAt/1000):'已发送';}
function slashCardView(card,inTurn){
 const box=el('section','slash-card'+(inTurn?' in-turn':'')+(card.panel?' panel':'')+(card.state==='failed'||card.state==='rejected'?' failed':''));box.dataset.slash=card.id;box.setAttribute('aria-label','命令输出 '+card.text);
 if(!inTurn){const head=el('div','slash-card-head');const ic=el('span','notice-icon');ic.append(icon('terminal'));const t=el('span','grow slash-card-title');t.append(el('span','slash-card-kicker','命令输出 · '),el('code','slash-cmd',card.text));
  const st=el('span','slash-state',slashStateText(card));if(card.capturing||card.state==='sending')st.prepend(el('span','spinner mini'));head.append(ic,t,st);box.append(head);
  if(card.info?.desc)box.append(el('p','slash-desc-line',card.info.desc));}
 else{const row=el('div','slash-screen-head');row.append(el('span','grow','终端画面 · '+slashStateText(card)));if(card.capturing)row.prepend(el('span','spinner mini'));box.append(row);}
 if(card.state==='failed'||card.state==='rejected'){box.append(el('p','slash-error',card.reason+(card.state==='failed'?'。不会自动重发，先看一眼终端。':'。可以再发一次。')));
  box.append(slashActions(card,false));return box;}
 if(card.state==='sending')return box;
 const pre=el('pre','slash-screen',card.screen||(card.capturing?'正在读终端画面…':'（没读到画面，点刷新再试）'));pre.tabIndex=0;pre.setAttribute('aria-label','命令输出内容');box.append(pre);
 if(card.error)box.append(el('p','slash-error',card.error));
 if(card.panel){const hint=el('p','slash-hint',card.menu?'它在等你选。用下面的键操作，Esc 取消。':'这个命令打开了一个面板，看完点 Esc 关掉；没关上之前，新消息先不发。');box.append(hint);
  const keys=el('div','slash-keys');const k=(t,key,cls)=>{const b=btn(t,cls||'secondary small',()=>slashKey(card,key,t));b.disabled=!!card.busy||!S.chat?.agent||S.chat.stale;return b;};
  keys.append(k('Esc 关闭','esc','primary small'));
  // A numbered picker needs ↑ ↓ Enter; other panels may also page sideways (Claude /status tabs).
  if(card.menu)keys.append(k('↑','up'),k('↓','down'),k('Enter','enter'));
  else if(/↑|↓|←|→|arrow|enter to|tab to/i.test(card.screen.split('\n').slice(-16).join('\n')))keys.append(k('↑','up'),k('↓','down'),k('←','left'),k('→','right'),k('Enter','enter'));
  box.append(keys);}
 box.append(slashActions(card,true));return box;}
function slashActions(card,ok){const row=el('div','slash-actions');
 if(ok){const r=btn('刷新','link-btn',()=>slashCapture(card,{after:0}),'refresh');r.disabled=card.capturing||!S.chat?.agent||S.chat.stale;row.append(r);if(card.screen)row.append(btn('复制','link-btn',()=>copyText(card.screen),'copy'));}
 row.append(btn('收起','link-btn',()=>{slashDrop(card);paintTimeline();},'close'));return row;}

// ─── Timeline ───────────────────────────────────────────────────────────────
// A transcript command (Claude) claims the card sent within two minutes of it; the rest sit by time.
function slashMatch(turns){
 const cards=slashCards();cards.forEach(c=>{c.turn='';});
 for(const turn of turns){if(!turn.command)continue;const at=toDate(turn.command.m.timestamp)?.getTime()||0;
  const card=cards.find(c=>!c.turn&&c.state==='sent'&&'/'+c.name===turn.command.name&&Math.abs(c.at-at)<120000);if(card)card.turn=turn.id;}}
function slashBefore(list,start){const t=start?start.getTime():Infinity;for(const c of slashCards()){if(c.turn||c.placed||c.at>=t)continue;c.placed=true;list.append(slashCardView(c,false));}}
function slashRest(list){for(const c of slashCards()){if(c.turn||c.placed)continue;list.append(slashCardView(c,false));}slashCards().forEach(c=>{c.placed=false;});}
// Claude's own record of a command: "/model" with what it printed ("Set model to …").
function slashCommandRow(turn){
 const cmd=turn.command;const box=el('section','slash-card logged');box.dataset.id=cmd.m.id;
 const head=el('div','slash-card-head');const ic=el('span','notice-icon');ic.append(icon('terminal'));const t=el('span','grow slash-card-title');t.append(el('span','slash-card-kicker','命令 · '),el('code','slash-cmd',(cmd.name+' '+(cmd.args||'')).trim()));
 head.append(ic,t,el('span','notice-time',clock(cmd.m.timestamp)));box.append(head);
 const out=cmd.out.map(o=>o.text).join('\n').trim();
 if(out){const pre=el('pre','slash-out'+(cmd.out.some(o=>o.err)?' err':''),out);box.append(pre);
  const row=el('div','slash-actions');row.append(btn('复制','link-btn',()=>copyText(out),'copy'));box.append(row);}
 else if(!turn.entries.length)box.append(el('p','slash-desc-line',cmd.done?'没有输出':'输出只显示在终端里'));
 const card=slashCards().find(c=>c.turn===turn.id);if(card)box.append(slashCardView(card,true));
 return box;}
