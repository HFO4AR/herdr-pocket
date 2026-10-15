'use strict';
// 帮助与反馈. Short in-app help (设置 → 帮助与反馈, and 「怎么回事」 on error banners) plus a
// diagnostic summary for bug reports.
// Every sentence describes behaviour that exists in this build; keep it in step with the code and
// SECURITY.md. Text nodes only; `code` spans are split on backticks, never parsed as HTML.
// Privacy: the diagnostic summary carries versions, states, counts and error CODES only. It never
// includes device names, host names, user names, paths, message text, keys or fingerprints, and it
// is only copied / handed to the browser when the person taps a button.
// Loaded before app.js: only declarations plus the two small wrappers below at top level.

// ─── Content ────────────────────────────────────────────────────────────────
// A part body: 'text' → paragraph, ['a','b'] → bullet list, {cmd} → command with a copy button.
const HELP=[
 {id:'start',title:'开始使用',parts:[
  {id:'start-need',h:'需要准备什么',body:[
   ['一台装了 Herdr 的电脑，开着 SSH（含 SFTP），装有 Python 3.9 或更新版本。','Herdr 要用你 SSH 登录的同一个用户运行。','Android 8.0 或更新的手机。','手机能访问到电脑：同一个 Wi-Fi 填局域网 IP；不在一起可以用 Tailscale，或者 frp 这类 TCP 转发（填转发出来的地址和端口）。']]},
  {id:'start-add',h:'添加电脑',body:[
   '「设备」页点「添加第一台设备」（之后是右上角的 +）。填名称、主机地址、端口和 SSH 用户名；直接粘贴 `user@host:port` 会自动拆开。',
   '登录方式选「密码」或「密钥」。勾选「记住密码」后，密码用 Android Keystore 加密存在这台手机上；不勾就每次连接时输入。']},
  {id:'start-fingerprint',h:'第一次连接：核对指纹',body:[
   '第一次连一台电脑会弹出「核对电脑指纹」。在电脑的终端里运行下面的命令（弹窗里也能复制），输出里的 SHA256:… 要和手机上一字不差，再点「信任并连接」。',
   {cmd:'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'},
   '以后指纹变了，App 会直接拒绝连接，也不会自动重连。只有确定电脑那边换过密钥（重装系统、换机器），才在「电脑指纹变了」里选「重新核对」。']},
  {id:'start-bridge',h:'安装桥接程序',body:[
   '连上后 App 会请你在电脑上装一个小的桥接程序，用来读取会话、转发你发的消息。它随 App 一起发布、开源，用 Python 运行。',
   ['经 SFTP 放进 `~/.herdr-pocket`，按内容的 SHA-256 命名，传完回读校验。','不用 sudo，不重启 Herdr，不开放新端口。','App 更新后会提示换成配套的新版本；「设备」页的「更新桥接程序」可以随时重装。'],
   '提示「电脑上还差 Python」或「Python 太旧」时，先在电脑上装好 Python 3.9+ 再连。']}]},
 {id:'chat',title:'和 Agent 对话',parts:[
  {id:'chat-send',h:'发消息',body:[
   '「会话」里点一个 Agent 打开对话，写好点发送。手机上回车是换行；接了实体键盘可以按 Ctrl+Enter 发送。',
   '发出去的消息会先显示在下面，等对话记录里出现后合并。发送结果不确定（比如中途断网）时草稿会留着，App 不会自动重发，先看一眼再决定。',
   '长按一条消息可以复制全文、引用回复或选择文字。']},
  {id:'chat-queue',h:'排队和「立即发送」',body:[
   'Agent 正在执行或等你确认时，发送按钮会变成「排队」。排队的消息等它停下后按顺序一条一条发出去。',
   ['只在 App 在前台、这段对话开着的时候发；后台不会发送任何东西。','每条排队消息可以「删掉」「修改」或「立即发送」。','「立即发送」先给 Agent 发 Esc 打断当前这一轮，等 Herdr 报告它停下再发；20 秒内没停下就不发。','排队只存在这次运行的内存里，退出 App 就没了。'],
  ]},
  {id:'chat-stop',h:'中断',body:[
   '执行中时，输入框上方的状态条右边有「中断」。它发送 Esc：Claude Code 和 Codex 都会停下当前这一轮，不会退出。',
   '要按 Ctrl+C 或方向键，在「更多操作 → 终端按键」里。Enter 可能就是批准当前操作，先看清终端。']},
  {id:'chat-answer',h:'回答提问卡片',body:[
   'Agent 问你问题或要你批准时，输入框上方会出现一张卡片。点选项再提交，App 会移动光标、核对屏幕上那一行，再按 Enter。',
   '卡片和终端里看到的不一样时，点「用按键操作」，直接用 ↑ ↓ Enter Esc。']},
  {id:'chat-slash',h:'斜杠命令',body:[
   '在输入框开头打 /，会列出这个 Agent 的命令：内置命令，加上你自己的命令、skills 和 prompts。点一下或回车插入。',
   '命令的输出大多不进对话记录，所以发出后 App 会读一会儿终端画面，放进「命令输出」卡片。命令弹出面板或选择器时，卡片里给出需要的按键；面板开着的时候，其他消息会先等着。']},
  {id:'chat-files',h:'图片和文件',body:[
   '输入框左边的 + 可以从相册选、拍照或选文件。一条消息最多 4 张图片、4 个文件，单个文件不超过 25 MB。',
   ['图片在手机上转正、压到长边 2048 px，去掉拍摄地点等 EXIF 信息。','都经 SFTP 传到电脑的 `~/.herdr-pocket/uploads/`，消息后面附上路径交给 Agent；14 天后自动清理。','上传或准备失败时整条消息都不发，草稿还在。']]},
  {id:'chat-share',h:'从别的应用分享',body:[
   '在其他应用里分享文字、图片或文件，选 Herdr Pocket，再选「发给哪个 Agent」。内容会放进那段对话的草稿和附件里，不会自动发送。还没连上电脑时，会先等连接好。']}]},
 {id:'ch',title:'远程会话（ch）',parts:[
  {id:'ch-what',h:'是什么',body:[
   '有的窗格里跑的是 ch：Agent 实际在另一台电脑上，Herdr 这边只看到一条 SSH 连接。这样的会话在列表里标着「远端」。',
   'App 经同一条 SSH 路由去那台电脑只读地取对应的对话记录（不转发、严格校验指纹），所以打开和刷新会慢一些，列表上也没有一行预览。']},
  {id:'ch-send',h:'发送、新建和关闭',body:[
   ['消息照常发；图片会变成 `ch-file://` 地址，文件先复制到那台电脑的同一个上传目录，复制失败就不发。','窗格 SSH 到别的电脑、但不是 ch 时，App 不知道怎么把图片和文件送过去，会直接拒绝。','「新建」里选「Claude · ch」，App 在新窗格里运行 `ch new`。','关闭时选「只关本机窗格」，远端的 Claude 会话继续运行，之后可以用 `ch resume` 接回；结束 Agent 会结束远端会话。']]}]},
 {id:'sessions',title:'新建和关闭会话',parts:[
  {id:'sessions-new',h:'新建',body:[
   '「会话」页右上角的「新建」：选 Codex、Claude 或 Claude · ch，选目录（这台手机最近用过的排在前面），选放进已有工作区的新标签页还是新工作区，还可以顺手写第一条消息。',
   '不会抢走电脑上的焦点。结果不确定时 App 不会自己重试，回列表刷新看看。']},
  {id:'sessions-close',h:'关闭',body:[
   '在列表里左滑或长按一行，或者在对话里点「更多操作 → 关闭会话」。有两种：',
   ['「结束 Agent，保留终端」：Agent 空闲时，用它自己的退出命令退出，窗格留下。','「关闭整个窗格」：窗格里的进程都会结束。'],
   '两种都要确认一次，不会自动重试。历史记录不会被删除；「从列表移除」只是在 App 里藏起来，可以在「已隐藏」里放回。']},
  {id:'sessions-switch',h:'多个 Herdr 会话',body:[
   '电脑上的 Herdr 开了多个会话时，「会话」页上方可以切换。列表、终端和新建都在当前会话里。']}]},
 {id:'alerts',title:'后台提醒',parts:[
  {id:'alerts-how',h:'怎么工作',body:[
   '切到后台时，App 启动一个带常驻通知的前台服务，每 20 秒只读查询一次 Agent 状态。有 Agent 做完或等你确认时发通知，点通知直接打开它。',
   ['通知里只有 Agent 标题和状态，没有消息内容。','后台只读，从不发送任何输入；排队的消息要回到前台才发。','回到 App、断开设备、连续 5 次查询失败或 8 小时后自动停止，通知上也能停。'],
   '在「设置 → 提醒与隐私」里开关。系统通知被关掉时，设置页会提示，点「打开系统通知」。']}]},
 {id:'keys',title:'密钥登录',parts:[
  {id:'keys-make',h:'这台手机的密钥',body:[
   '「设备」页的「登录密钥」：生成一把 Ed25519 密钥，或导入已有私钥（带密码的也行，密码只用一次、不保存）。',
   '私钥用 Android Keystore 加密存在手机上，不显示、不导出，页面只拿得到公钥。所有电脑用的是这台手机的同一把密钥。']},
  {id:'keys-install',h:'装到电脑上',body:[
   '已经能用密码连上时，在连接卡片上点「装公钥」。确认要写入的那一行后，App 把它追加到电脑的 `~/.ssh/authorized_keys`（不重复写，`~/.ssh` 700、文件 600，别的行不动），再用密钥试登一次。成功后可以改成密钥登录并删掉保存的密码。',
   '也可以复制安装命令，自己在电脑上执行。']},
  {id:'keys-fail',h:'电脑不接受密钥',body:[
   ['确认公钥那一行在 `~/.ssh/authorized_keys` 里。','`~/.ssh` 是 700、`authorized_keys` 是 600，家目录别人不能写。','电脑的 SSH 不允许密钥登录时，改回密码。'],
   '要撤销某台电脑，删掉它 `authorized_keys` 里那一行；「重新生成」会让所有电脑上的旧公钥一起失效。']}]},
 {id:'update',title:'更新',parts:[
  {id:'update-how',h:'在 App 里更新',body:[
   '打开 App 时最多每 12 小时查一次 GitHub 上有没有新版本，不发送任何设备信息；有新版本时「设置」上会有个小点。',
   '「设置 → 更新 → 下载并安装」：App 核对发布的 SHA-256、包名、版本号和签名，都对才交给系统安装程序，你再确认一次。第一次要允许 Herdr Pocket「安装未知应用」。',
   '自动检查可以在设置里关掉；也可以从 GitHub 的 Releases 页手动下载 APK。电脑上的桥接程序会在下次连接时提示更新。']}]},
 {id:'privacy',title:'隐私与安全',parts:[
  {id:'privacy-read',h:'会读什么',body:[
   ['Herdr 的会话、窗格状态，需要时读窗格的终端画面。','当前 SSH 用户 `~/.codex/sessions` 和 `~/.claude/projects` 下的对话记录：只读，按需分页。','ch 远端窗格：经同一条路由，只读那台电脑上对应的记录。']]},
  {id:'privacy-store',h:'手机上存什么',body:[
   ['设备资料、勾选保存的密码、登录私钥：AES-GCM 加密，密钥在 Android Keystore 里。','会话列表、历史目录和最近看过的对话（每段最近 80 条）的缓存：同样加密，按设备分开，总共最多 32 MB，可在「设置」里清除。','草稿和排队的消息只在内存里。Android 备份是关的。']]},
  {id:'privacy-host',h:'电脑上存什么',body:[
   ['`~/.herdr-pocket`：桥接程序，和你发的图片、文件（14 天后清理）。','`~/.local/state/herdr-pocket`：请求回执，只存哈希，不存消息正文。']]},
  {id:'privacy-never',h:'从不碰的',body:[
   ['Codex / Claude 的登录凭据和配置文件。','隐藏推理、系统和开发者消息。','不会自动批准确认，不会重发结果未知的操作，不擅自新建或恢复 Agent。','除了你的电脑，只连 GitHub 检查和下载更新。界面全部打包在 APK 里，不加载网页；没有统计和广告。'],
   '「防截图」默认关闭，可以在「设置」里打开。完整说明见项目主页的 SECURITY.md。']}]},
 {id:'faq',title:'常见问题',faq:true,parts:[
  {id:'faq-connect',h:'连不上',body:[
   '横幅标题就是原因：',
   ['「密码不对」：点「重新输入密码」。','「找不到这台电脑」「连不上，超时了」「手机到不了这台电脑」：查地址和端口；同一个 Wi-Fi 吗？Tailscale 开着吗？','「端口没开」：电脑上 SSH 服务没启动，或端口填错了。','「转发通了，电脑没回应」：frp 等转发那头的电脑或 SSH 没开。','「这台电脑不让用密码登录」：改用密钥登录。'],
   '锁屏或切网断开后，App 会用保存的密码或密钥、已信任的指纹悄悄重连；失败时点「重试」。已经发出去但结果不确定的消息不会重发。']},
  {id:'faq-queue',h:'消息一直在排队',body:[
   ['排队的消息要等 Agent 停下（不在执行，也不在等确认），而且 App 在前台、这段对话开着。','看气泡上的说明：「已暂停」点「继续」；「处理完确认再发」先回答提问卡片。','急的话点「立即发送」，它会先打断 Agent。','窗格里换了一段对话（/clear、/resume）时排队会暂停，看一眼再点「继续」。','「结果未知」的不会自动重发：删掉，或者复制出来再发。']]},
  {id:'faq-images',h:'图片或文件发不出去',body:[
   '提示「没发出去：…」说明 Agent 什么都没收到，草稿还在，处理好直接再发。',
   ['电脑上 `~/.herdr-pocket` 写不进去（磁盘满、权限不对）。','窗格 SSH 到了别的电脑，但不是 ch。','单个文件超过 25 MB。','有的相册（比如 MIUI 的）会要照片权限，这时 App 才会请求，允许就行。']]},
  {id:'faq-history',h:'历史和窗格对不上',body:[
   '列表上标着「历史未关联」，或者对话不是这个窗格的内容时：「更多操作 → 选择其他历史记录」挑一段，确认「关联当前 Agent」。这只是在 App 里对应起来，不会恢复或新建会话。',
   '刚开的会话还没写出记录文件，稍等会自动出现。在终端里 /clear、/resume 之后，App 会跟上并标出新会话。']},
  {id:'faq-subagent',h:'看不到子 Agent',body:[
   '子 Agent 来自对话记录里的父子信息：在对话右上角「切换 Agent」里能看到这段对话的子 Agent，「历史」页也能按「子 Agent」筛选。',
   '记录还没写出来时看不到，刷新一下。子 Agent 只读，不能直接给它发消息。']},
  {id:'faq-oem',h:'小米等手机：通知不来、后台被杀',body:[
   '一些系统的省电策略会杀掉后台服务或拦下通知。可以在系统设置里：',
   ['允许 Herdr Pocket 发通知。','省电策略选「无限制」，打开「自启动」（MIUI / HyperOS 的叫法）。','在最近任务里把 App 锁住。'],
   'App 被系统杀掉后，连接、草稿和排队的消息会丢，保存的设备和密码不受影响，重新打开再连就行。']},
  {id:'faq-herdr',h:'提示 Herdr 没找到或没在运行',body:[
   ['「电脑上没找到 Herdr」：桥接程序在这个 SSH 用户的 PATH 和 `~/.local/bin` 里找 `herdr`。装在别处的话，在 `~/.local/bin` 放一个链接。','「Herdr 没在运行」：在电脑上打开 Herdr，至少开一个会话。','Herdr 要用你 SSH 登录的同一个用户运行。'],
   '处理好后点横幅上的「重新检查」。']}]}];

// Error codes from the native layer (ConnectErrors.kt) → the part that explains them.
const HELP_TOPIC={hostkey_new:'start-fingerprint',hostkey_changed:'start-fingerprint',python_missing:'start-bridge',python_old:'start-bridge',install_failed:'start-bridge',key_rejected:'keys-fail',key_method:'keys-fail',key_missing:'keys-make'};
function helpTopicFor(code){return HELP_TOPIC[code]||'faq-connect';}

// ─── Recent error codes (for the diagnostic summary) ────────────────────────
// Only the operation name and the native error code are kept, never the message: messages can
// name hosts, users or paths. Both are checked against a strict pattern before they are stored.
const HELP_ERR=[];
function helpNote(op,code){
 const o=/^[A-Za-z]{1,24}$/.test(op||'')?op:'other',c=/^[a-z0-9_]{1,32}$/.test(code||'')?code:'';
 const last=HELP_ERR.at(-1);if(last&&last.op===o&&last.code===c){last.n++;last.at=Date.now();return;}
 HELP_ERR.push({op:o,code:c,n:1,at:Date.now()});if(HELP_ERR.length>8)HELP_ERR.shift();}
// Function declarations are hoisted across the bundle, so these wrap app.js / onboard.js versions.
{const base=rpc;rpc=function(op,args={},progress){return base(op,args,progress).catch(e=>{helpNote(op==='remote'?args?.op:op,e?.code);throw e;});};}
{const base=netEvent;netEvent=function(e){if(e&&['reconnect_failed','hostkey_changed'].includes(e.type))helpNote('reconnect',e.type);return base(e);};}

// ─── Help sheet ─────────────────────────────────────────────────────────────
function helpIcons(){if(paths.help)return;Object.assign(paths,{help:'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01',bug:'M8 9h8v6a4 4 0 0 1-8 0zM9 9V7a3 3 0 0 1 6 0v2M4 13h4M16 13h4M5 8l3 2M19 8l-3 2M5 19l3-2M19 19l-3-2'});}
// `x` → <code>x</code>; everything else stays plain text.
function helpText(node,text){String(text).split('`').forEach((s,i)=>{if(!s)return;node.append(i%2?el('code','help-code',s):document.createTextNode(s));});return node;}
function helpBody(box,body){
 for(const b of body){
  if(typeof b==='string')box.append(helpText(el('p'),b));
  else if(Array.isArray(b)){const ul=el('ul','help-list');b.forEach(t=>ul.append(helpText(el('li'),t)));box.append(ul);}
  else if(b.cmd){const row=el('div','ob-cmd help-cmd');row.append(el('code','',b.cmd),ib('copy','复制命令',()=>copyText(b.cmd)));box.append(row);}}}
function helpPart(p,faq){
 if(faq){const d=el('details','help-faq');d.id='help-'+p.id;const s=el('summary');s.append(el('span','grow',p.h),icon('down'));d.append(s);const b=el('div','help-body');helpBody(b,p.body);d.append(b);return d;}
 const n=el('div','help-part');n.id='help-'+p.id;n.append(el('h4','',p.h));helpBody(n,p.body);return n;}
// Scroll inside the sheet (not the page behind it) and mark the target for a moment.
function helpJump(box,id){
 const n=box.querySelector('#help-'+CSS.escape(id));if(!n)return;
 if(n.tagName==='DETAILS')n.open=true;
 // The sheet head sticks to the top: land just below it.
 const head=box.querySelector('.sheet-head')?.offsetHeight||0;
 const top=n.getBoundingClientRect().top-box.getBoundingClientRect().top+box.scrollTop-head-8;
 // Short hops glide; long ones jump at once (a smooth scroll over thousands of px takes seconds).
 const still=Math.abs(top-box.scrollTop)>box.clientHeight*1.5||document.documentElement.classList.contains('reduce-motion')||matchMedia('(prefers-reduced-motion: reduce)').matches;
 box.scrollTo({top,behavior:still?'auto':'smooth'});
 n.classList.remove('help-hit');void n.offsetWidth;n.classList.add('help-hit');
 const focus=n.tagName==='DETAILS'?n.querySelector('summary'):n.querySelector('h3,h4');if(focus){focus.tabIndex=-1;focus.focus({preventScroll:true});}}
function helpOpen(topic){
 helpIcons();const box=sheet('帮助');box.classList.add('help-sheet');
 const lead=el('div','help-lead');lead.append(el('p','','Herdr Pocket 通过 SSH 连到运行 Herdr 的电脑，在手机上看 Agent 在做什么、回它的消息。下面是常用操作和常见问题。'));box.append(lead);
 const toc=el('nav','help-toc');toc.setAttribute('aria-label','目录');
 HELP.forEach(s=>{const b=btn(s.title,'help-toc-item',()=>helpJump(box,s.id));toc.append(b);});
 toc.append(btn('反馈问题','help-toc-item accent',()=>helpJump(box,'feedback')));box.append(toc);
 for(const s of HELP){const sec=el('section','help-section');sec.id='help-'+s.id;sec.append(el('h3','',s.title));s.parts.forEach(p=>sec.append(helpPart(p,s.faq)));box.append(sec);}
 const fb=el('section','help-section help-feedback');fb.id='help-feedback';fb.append(el('h3','','反馈问题'));
 fb.append(el('p','','遇到问题可以在 GitHub 上提一个 issue。App 会生成一段诊断信息（版本、连接状态、最近的错误代码和数量），先给你看，你决定要不要附上。'));
 fb.append(el('p','help-note','诊断信息不含主机地址、用户名、路径、消息内容、密钥或指纹。'));
 const acts=el('div','help-actions');acts.append(btn('生成诊断信息','primary',()=>helpFeedback(),'bug'),btn('项目主页','secondary',()=>rpc('openUrl',{url:'https://github.com/HFO4AR/herdr-pocket'}).catch(error),'globe'));fb.append(acts);box.append(fb);
 box.append(el('p','fine center help-end','Herdr Pocket '+((typeof SET!=='undefined'&&SET.prefs?.version)||S.version||'')+' · MIT 开源'));
 if(topic)requestAnimationFrame(()=>helpJump(box,topic));
 return box;}

// ─── Diagnostics ────────────────────────────────────────────────────────────
function helpWithin(p,ms){return Promise.race([p,new Promise((_,no)=>setTimeout(()=>no(new Error('timeout')),ms))]);}
function helpUa(re){const m=String(navigator.userAgent||'').match(re);return m?m[1]:'未知';}
// Everything here is a version, a fixed state word or a number. Nothing typed by the person or
// reported by the computer as free text is copied in.
async function helpDiagnostics(){
 const p=(typeof SET!=='undefined'&&SET.prefs)||{};const lines=[];const add=(k,v)=>lines.push(k+'：'+v);
 lines.push('Herdr Pocket 诊断信息');
 add('App',(p.version||S.version||'未知')+(p.versionCode?' ('+p.versionCode+')':''));
 add('Android',helpUa(/Android\s+([\d.]+)/));add('WebView','Chrome '+helpUa(/Chrome\/(\d+)/));
 const state=S.demo?'离线演示':S.device?'已连接':S.loading?'正在连接':'未连接';
 add('连接',state+(S.device&&!S.demo?' · '+(S.device.auth==='key'?'密钥登录':'密码登录'):'')+(S.net?' · 重连状态 '+S.net:''));
 if(S.device&&!S.demo){
  try{const h=await helpWithin(remote('hello'),8000);add('桥接程序',String(h.version||'未知').slice(0,24)+' · 协议 '+(Number(h.protocol)||'?')+' · Python '+String(h.python||'?').slice(0,12));}catch(_){add('桥接程序','读取失败');}
  try{const d=await helpWithin(remote('doctor'),8000);add('Herdr',d.herdr===false?'没找到':d.error?'读取出错':'已安装 · 运行中的会话 '+(Number(d.running)||0)+' · 版本未知');}catch(_){add('Herdr','读取失败');}}
 else{add('桥接程序','未连接，无法读取');add('Herdr','未连接，无法读取');}
 const ag=S.agents||[],isCh=a=>typeof closeIsCh==='function'&&closeIsCh(a);
 const count=f=>ag.filter(f).length;
 add('在线 Agent',ag.length+'（Codex '+count(a=>a.agent==='codex')+'，Claude '+count(a=>a.agent==='claude')+'，ch 远端 '+count(isCh)+'；执行中 '+count(a=>a.agent_status==='working')+'，等确认 '+count(a=>a.agent_status==='blocked')+'）');
 add('历史未关联',count(a=>a.history_ref&&!['matched','pending'].includes(a.history_ref.status)));
 const c=S.chat;add('当前对话',!c?'无':c.agent?(isCh(c.agent)?'ch 远端':'本机')+' · '+(c.agent.agent||'agent')+(c.stale?' · 已变化':''):c.record?((c.record.remote?'ch 远端':'本机')+' · 历史只读'+(c.record.parent?' · 子 Agent':'')):'无');
 let queued=0;if(typeof Q!=='undefined')for(const q of Q.values())queued+=q.items.length;
 add('数量','保存的设备 '+(S.devices||[]).length+' · 排队消息 '+queued+' · 未确认发送 '+(S.outbox||[]).filter(o=>o.state!=='sent').length+' · 已加载历史 '+(S.records||[]).length);
 add('设置','后台提醒 '+(S.alerts!==false?'开':'关')+' · 系统通知 '+(p.notifications===false?'关':'开')+' · 主题 '+(p.theme||'?')+' · 字号 '+(p.textZoom||100)+'% · 防截图 '+(p.secureScreen?'开':'关'));
 add('最近错误代码',HELP_ERR.length?HELP_ERR.map(e=>e.op+(e.code?':'+e.code:'')+(e.n>1?' ×'+e.n:'')+' ('+ago(Date.now()-e.at)+'前)').join('，'):'无');
 return lines.join('\n');}
const HELP_ISSUE='https://github.com/HFO4AR/herdr-pocket/issues/new';
async function helpFeedback(){
 helpIcons();const box=sheet('反馈问题');box.classList.add('help-sheet','help-fb-sheet');
 box.append(el('p','muted','下面是可以附上的诊断信息，先看一眼。复制后去 GitHub 新建 issue，粘贴进去，再写上发生了什么、怎么复现。'));
 const pre=el('pre','help-diag','正在收集…');pre.setAttribute('aria-label','诊断信息');pre.tabIndex=0;box.append(pre);
 box.append(el('p','help-note','不含主机地址、用户名、路径、消息内容、密钥或指纹。截图前也记得遮掉这些。'));
 const row=el('div','sheet-actions help-fb-actions');
 const go=btn('复制并打开 GitHub','primary',async()=>{await copyText(pre.textContent);rpc('openUrl',{url:HELP_ISSUE}).catch(error);},'globe');
 const copy=btn('只复制','secondary',()=>copyText(pre.textContent),'copy');
 copy.disabled=go.disabled=true;row.append(go,copy);box.append(row);
 box.append(btn('返回帮助','link-btn help-back',()=>helpOpen('feedback')));
 const text=await helpDiagnostics();if(!pre.isConnected)return;pre.textContent=text;copy.disabled=go.disabled=false;}
