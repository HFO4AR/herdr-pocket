'use strict';
// Terminal keys for all three terminal kinds (terminals.js): the phone's own SSH shell and a live
// tmux attach (xterm.js over a PTY: raw bytes), a Herdr pane (bridge paneKey) and a tmux pane
// snapshot (bridge tmuxSend key). Loaded before app.js: only declarations at top level.
//  · Key names: optional modifiers in the order ctrl+, alt+, shift+, then a named key or one
//    printable ASCII character ("ctrl+shift+left", "alt+x", "shift+tab", "f5", "|"). The bridge
//    parses the same names (pocket_bridge.term_key) and maps them per backend; the tables here
//    mirror it so a combination that cannot be sent is greyed out with the reason instead of being
//    sent wrong. tests/fixtures/term_keys.json pins both sides (bytes, Herdr and tmux arguments).
//  · Bytes follow xterm: CSI 1;m X for modified cursor / Home / End / F1–F4, CSI n;m ~ for the tilde
//    keys, CSI 27;m;k ~ for modified Enter / Tab / Esc (what Herdr itself sends), Esc prefix for Alt,
//    C0 codes for Ctrl. The cursor keys follow the application cursor mode the shell asked for.
//  · Ctrl / Alt / Shift on the bar latch: one tap holds the modifier for the next key, a double tap
//    locks it until tapped again. They apply to the bar's keys, the direct keyboard (soft keys and a
//    hardware keyboard, whose own modifiers are used as they are) and a one-character line.
//  · The bar: Ctrl Alt Shift pinned at the start, then pages of keys sized to the width (two rows when
//    the screen is tall enough, one with the soft keyboard up or in landscape), swiped sideways.
//    Which keys show and their order are per phone and computer (per-device cache, 「自定义按键」).
const TK_BASES=['esc','tab','enter','backspace','space','up','down','left','right','home','end','insert','delete','pageup','pagedown','f12','f11','f10','f9','f8','f7','f6','f5','f4','f3','f2','f1'];
const TK_RE=new RegExp('^(ctrl\\+)?(alt\\+)?(shift\\+)?('+TK_BASES.join('|')+'|[!-~])$');
const TK_LETTER={up:'A',down:'B',right:'C',left:'D',home:'H',end:'F'};
const TK_SS3={f1:'P',f2:'Q',f3:'R',f4:'S'};
const TK_TILDE={insert:2,delete:3,pageup:5,pagedown:6,f5:15,f6:17,f7:18,f8:19,f9:20,f10:21,f11:23,f12:24};
const TK_CTRL={'@':'\x00','[':'\x1b','\\':'\x1c',']':'\x1d','^':'\x1e','_':'\x1f','/':'\x1f','?':'\x7f'};
const TK_TMUX={up:'Up',down:'Down',left:'Left',right:'Right',home:'Home',end:'End',insert:'IC',delete:'DC',pageup:'PPage',pagedown:'NPage'};
for(let i=1;i<=12;i++)TK_TMUX['f'+i]='F'+i;
const TK_MODS=['ctrl','alt','shift'];
const TK_NO_CODE='这个组合键在终端里没有对应的按键码，发不出去';

function tkParse(name){const m=typeof name==='string'&&name.match(TK_RE);return m?{ctrl:!!m[1],alt:!!m[2],shift:!!m[3],base:m[4]}:null;}
function tkName(p){return (p.ctrl?'ctrl+':'')+(p.alt?'alt+':'')+(p.shift?'shift+':'')+p.base;}
const tkAlpha=c=>/^[a-z]$/i.test(c);
// The bytes a key sends; null when it has no encoding (pocket_bridge.term_key_bytes).
function tkBytes(name,app){
 const p=tkParse(name);if(!p)return null;const {ctrl,alt,shift,base}=p,m=1+(shift?1:0)+(alt?2:0)+(ctrl?4:0);
 if(TK_LETTER[base]){const x=TK_LETTER[base];return m===1?(app?'\x1bO':'\x1b[')+x:'\x1b[1;'+m+x;}
 if(TK_SS3[base])return m===1?'\x1bO'+TK_SS3[base]:'\x1b[1;'+m+TK_SS3[base];
 if(TK_TILDE[base])return m===1?'\x1b['+TK_TILDE[base]+'~':'\x1b['+TK_TILDE[base]+';'+m+'~';
 if(base==='enter'||base==='tab'||base==='esc'){const plain={enter:'\r',tab:'\t',esc:'\x1b'}[base],code={enter:13,tab:9,esc:27}[base];
  if(m===1)return plain;if(m===3)return '\x1b'+plain;if(base==='tab'&&m===2)return '\x1b[Z';return '\x1b[27;'+m+';'+code+'~';}
 const esc=alt?'\x1b':'';
 if(base==='backspace')return esc+(ctrl?'\x08':'\x7f');
 if(base==='space')return esc+(ctrl?'\x00':' ');
 let c=shift&&tkAlpha(base)?base.toUpperCase():base;
 if(ctrl){if(tkAlpha(c))c=String.fromCharCode(c.toUpperCase().charCodeAt(0)-64);else if(c in TK_CTRL)c=TK_CTRL[c];else return null;}
 return esc+c;}
// Herdr pane arguments after the pane id (pocket_bridge.herdr_key_args).
function tkHerdrArgs(name){
 const data=tkBytes(name);if(data===null)return null;const {ctrl,alt,shift,base}=tkParse(name);
 // Herdr's names follow the pane's cursor-key mode; where Herdr differs from xterm (ctrl+tab, ctrl+alt+
 // shift+backspace, modified F3) the bytes go in as text.
 if(['up','down','left','right','enter','esc','space'].includes(base)||/^f\d+$/.test(base)&&!(base==='f3'&&(ctrl||alt||shift))
  ||base==='backspace'&&!(ctrl&&alt&&shift)||base==='tab'&&!(ctrl&&!shift))return ['send-keys',name];
 if(data==='\x00'||data==='\x1b\x00')return ['send-keys',(alt?'ctrl+alt+':'ctrl+')+'space'];
 return ['send-text',data];}
function tkTmuxLiteral(t){return t.endsWith(';')?t.slice(0,-1)+'\\;':t;}
// tmux send-keys arguments after -t <pane> (pocket_bridge.tmux_key_args).
function tkTmuxArgs(name){
 const data=tkBytes(name);if(data===null)return null;const {ctrl,alt,shift,base}=tkParse(name);const mods=(ctrl?'C-':'')+(alt?'M-':'');
 if(TK_TMUX[base])return [mods+(shift?'S-':'')+TK_TMUX[base]];
 const plain={enter:'Enter',esc:'Escape',space:'Space'};
 if(plain[base]&&!shift&&!ctrl)return [mods+plain[base]];
 if(base==='space'&&ctrl)return [mods+'Space'];
 if(base==='tab'&&!ctrl)return alt&&shift?['-l','--',data]:[(alt?'M-':'')+(shift?'BTab':'Tab')];
 if(base==='backspace')return ctrl||alt?[mods+(ctrl?'h':'BSpace')]:['BSpace'];
 if(base.length===1&&tkAlpha(base)&&(ctrl||alt))return [mods+(ctrl?base.toLowerCase():shift?base.toUpperCase():base)];
 if('@[\\]^_/?'.includes(base)&&base.length===1&&ctrl&&!alt)return ['C-'+base];
 if(data.includes('\x00'))return null;
 return ['-l','--',tkTmuxLiteral(data)];}
// Which way a terminal takes keys: raw bytes (xterm over a PTY), Herdr or tmux names.
function tkKind(entry){return entry.kind==='ssh'||entry.kind==='attach'?'xterm':entry.kind==='tmux'?'tmux':'herdr';}
// '' when the key can be sent to this terminal, else why not (shown as the key's tooltip and toast).
function tkWhy(kind,name){
 if(!tkParse(name))return TK_NO_CODE;
 if(kind==='xterm')return tkBytes(name)===null?TK_NO_CODE:'';
 if(kind==='tmux')return tkTmuxArgs(name)===null?(tkBytes(name)===null?TK_NO_CODE:'tmux 里发不出这个组合键'):'';
 return tkHerdrArgs(name)===null?TK_NO_CODE:'';}
// A key from the bar or the keyboard plus the latched modifiers.
function tkWith(name,mods){const p=tkParse(name);if(!p)return name;for(const k of TK_MODS)if(mods&&mods[k])p[k]=true;return tkName(p);}
// Raw bytes the xterm sent (soft / hardware keyboard) back to a key name, so a latched modifier can be
// added. null: not one key (a paste, several characters).
const TK_SEQ={'\x1b[A':'up','\x1b[B':'down','\x1b[C':'right','\x1b[D':'left','\x1bOA':'up','\x1bOB':'down','\x1bOC':'right','\x1bOD':'left',
 '\x1b[H':'home','\x1b[F':'end','\x1bOH':'home','\x1bOF':'end','\x1b[1~':'home','\x1b[4~':'end','\x1b[2~':'insert','\x1b[3~':'delete','\x1b[5~':'pageup','\x1b[6~':'pagedown',
 '\x1bOP':'f1','\x1bOQ':'f2','\x1bOR':'f3','\x1bOS':'f4','\x1b[15~':'f5','\x1b[17~':'f6','\x1b[18~':'f7','\x1b[19~':'f8','\x1b[20~':'f9','\x1b[21~':'f10','\x1b[23~':'f11','\x1b[24~':'f12',
 '\x1b[Z':'shift+tab','\r':'enter','\t':'tab','\x7f':'backspace','\x08':'ctrl+backspace','\x1b':'esc',' ':'space'};
function tkDecode(data){
 if(TK_SEQ[data])return TK_SEQ[data];
 if(data.length===1){const c=data.charCodeAt(0);if(c>=0x21&&c<=0x7e)return tkAlpha(data)&&data===data.toUpperCase()?'shift+'+data.toLowerCase():data;
  if(c>=1&&c<=26)return 'ctrl+'+String.fromCharCode(c+96);}
 if(data.length===2&&data[0]==='\x1b'){const k=tkDecode(data[1]);if(k&&!k.startsWith('alt'))return tkWith(k,{alt:true});}
 return null;}
// A hardware keyboard's keydown (catcher of a pane snapshot): a key name, or null to let it type.
const TK_DOM={Enter:'enter',Tab:'tab',Escape:'esc',Backspace:'backspace',Delete:'delete',Insert:'insert',Home:'home',End:'end',PageUp:'pageup',PageDown:'pagedown',ArrowUp:'up',ArrowDown:'down',ArrowLeft:'left',ArrowRight:'right'};
function tkFromEvent(e,mods){
 let base=TK_DOM[e.key]||(/^F([1-9]|1[0-2])$/.test(e.key)?e.key.toLowerCase():'');
 const ctrl=e.ctrlKey,alt=e.altKey||e.metaKey,latched=mods&&TK_MODS.some(k=>mods[k]);
 if(!base){if(e.key===' '&&(ctrl||alt||latched))base='space';
  else if(e.key.length===1&&/[!-~]/.test(e.key)&&(ctrl||alt||latched)){base=tkAlpha(e.key)?e.key.toLowerCase():e.key;
   return tkWith(tkName({ctrl,alt,shift:tkAlpha(e.key)&&e.key!==e.key.toLowerCase(),base}),mods);}
  else return null;}
 return tkWith(tkName({ctrl,alt,shift:e.shiftKey,base}),mods);}

// ─── The key catalogue ───────────────────────────────────────────────────────
// [id, label, key name, accessible name, tooltip]
const TK_KEYS=[
 // The first page holds what typing needs most: Esc Tab Enter ⌫ and the arrows.
 ['esc','Esc','esc'],['tab','Tab','tab'],['enter','Enter','enter'],['bksp','⌫','backspace','退格'],
 ['up','↑','up','上'],['down','↓','down','下'],['left','←','left','左'],['right','→','right','右'],
 ['c-c','^C','ctrl+c','Ctrl+C','中断当前命令'],['c-d','^D','ctrl+d','Ctrl+D','结束输入 / 退出 shell'],['c-z','^Z','ctrl+z','Ctrl+Z','挂起到后台'],
 ['c-l','^L','ctrl+l','Ctrl+L','清屏'],['c-r','^R','ctrl+r','Ctrl+R','搜索历史命令'],['c-a','^A','ctrl+a','Ctrl+A','跳到行首'],['c-e','^E','ctrl+e','Ctrl+E','跳到行尾'],
 ['c-u','^U','ctrl+u','Ctrl+U','删到行首'],['c-k','^K','ctrl+k','Ctrl+K','删到行尾'],['c-w','^W','ctrl+w','Ctrl+W','删前一个词'],['c-b','^B','ctrl+b','Ctrl+B','tmux 前缀键'],
 ['home','Home','home'],['end','End','end'],['pgup','PgUp','pageup','Page Up'],['pgdn','PgDn','pagedown','Page Down'],['del','Del','delete','Delete'],['ins','Ins','insert','Insert'],
 ...'|~/-_:;`\\[]{}<>=&*!$'.split('').map(c=>['ch'+c.charCodeAt(0),c,c]),
 ...Array.from({length:12},(_,i)=>['f'+(i+1),'F'+(i+1),'f'+(i+1)])];
const TK_BY=new Map(TK_KEYS.map(k=>[k[0],k]));
const TK_DEFAULT=TK_KEYS.map(k=>k[0]);
const TK={order:TK_DEFAULT.slice(),hidden:new Set(),loaded:false,set:false,layout:null,dev:null};
addEventListener('resize',()=>{const f=TK.layout;if(f)requestAnimationFrame(f);});
// Kept per computer (that device's encrypted cache). Switching computers reloads, so each can have
// its own bar; no computer (demo) shows the defaults.
function tkPrefs(){const dev=cacheDevice();if(TK.loaded&&TK.dev===dev)return;TK.loaded=true;TK.dev=dev;TK.set=false;
 if(!dev){TK.order=TK_DEFAULT.slice();TK.hidden=new Set();return;}
 cacheGet('term:keys',dev).then(v=>{if(TK.dev!==dev||TK.set)return;
  if(v&&Array.isArray(v.order))tkApplyPrefs(v);else{TK.order=TK_DEFAULT.slice();TK.hidden=new Set();}
  if(T.view)tkRepaint(T.view,true);}).catch(()=>{});}
function tkApplyPrefs(v){const known=v.order.filter(id=>TK_BY.has(id));
 // Keys added in a later version go to the end, shown.
 TK.order=[...new Set(known.concat(TK_DEFAULT.filter(id=>!known.includes(id))))];
 TK.hidden=new Set((Array.isArray(v.hidden)?v.hidden:[]).filter(id=>TK_BY.has(id)));}
function tkSave(){TK.set=true;cachePut('term:keys',{order:TK.order,hidden:[...TK.hidden]});}
function tkVisible(){return TK.order.filter(id=>!TK.hidden.has(id)).map(id=>TK_BY.get(id));}

// ─── Modifiers ────────────────────────────────────────────────────────────────
// entry.mods[k]: 0 off, 1 for the next key, 2 locked.
function tkMods(entry){if(!entry.mods)entry.mods={ctrl:0,alt:0,shift:0};return entry.mods;}
function tkLatched(entry){const m=tkMods(entry);return TK_MODS.some(k=>m[k]);}
function tkModTap(entry,k){
 const m=tkMods(entry),now=performance.now(),last=entry.modTap?.[k]||0;entry.modTap={...entry.modTap,[k]:now};
 m[k]=m[k]===0?1:m[k]===1&&now-last<400?2:0;tkPaintMods(entry);
 if(m[k]===1&&entry.kind!=='ssh'&&entry.kind!=='attach'&&!entry.catching)toast(TK_LABEL[k]+' 按下了：再按一个键');}
// After a key went out: one-shot modifiers drop, locked ones stay.
function tkUsed(entry){const m=tkMods(entry);let changed=false;for(const k of TK_MODS)if(m[k]===1){m[k]=0;changed=true;}if(changed)tkPaintMods(entry);}
const TK_LABEL={ctrl:'Ctrl',alt:'Alt',shift:'Shift'};
function tkPaintMods(entry){
 if(T.view!==entry)return;const m=tkMods(entry);
 for(const k of TK_MODS){const b=document.getElementById('tk-'+k);if(!b)continue;b.classList.toggle('on',m[k]===1);b.classList.toggle('locked',m[k]===2);
  b.setAttribute('aria-pressed',String(!!m[k]));b.dataset.state=['off','once','locked'][m[k]];
  b.title=TK_LABEL[k]+(m[k]===2?'：已锁定，再点一下松开':m[k]===1?'：只管下一个键，连点两下锁定':'：点一下只管下一个键，连点两下锁定');}
 tkPaintKeys(entry);}
// Grey out what this terminal cannot take with the modifiers as they are now.
function tkPaintKeys(entry){
 const kind=tkKind(entry),m=tkMods(entry);
 for(const b of document.querySelectorAll('.tk-pager .key[data-key]')){const why=tkWhy(kind,tkWith(b.dataset.key,m));
  b.classList.toggle('off',!!why);if(why){b.setAttribute('aria-disabled','true');b.title=why;}else{b.removeAttribute('aria-disabled');b.title=b.dataset.tip||'';}}}

// ─── Sending ─────────────────────────────────────────────────────────────────
// One key (bar, direct keyboard, a one-character line) with the latched modifiers.
function tkPress(entry,name,{latched=true}={}){
 if(latched)name=tkWith(name,tkMods(entry));
 const why=tkWhy(tkKind(entry),name);if(why){toast(why);return false;}
 if(latched)tkUsed(entry);
 if(entry.ended||entry.paused){toast('终端不可输入，请查看状态或刷新');return false;}
 if(tkKind(entry)==='xterm'){const app=!!entry.term?.modes?.applicationCursorKeysMode;sendShell(entry,tkBytes(name,app));return true;}
 tkQueue(entry,{key:name});return true;}
// Pane input in order: typed text joins the text waiting behind a send in flight (one paneText for a
// burst of typing), keys go one by one. Each send has its own UUID; an unconfirmed one pauses input.
function tkQueue(entry,item){
 const q=entry.tq||(entry.tq=[]);const last=q[q.length-1];
 if(item.text!==undefined&&last&&last.text!==undefined&&!last.busy&&(last.text+item.text).length<=4000)last.text+=item.text;else q.push(item);
 tkDrain(entry);}
async function tkDrain(entry){
 if(entry.draining)return;entry.draining=true;
 try{while(entry.tq.length){const item=entry.tq[0];item.busy=true;
  if(entry.paused||entry.ended){entry.tq.length=0;break;}
  try{await sendPane(entry,item.key!==undefined?'paneKey':'paneText',item.key!==undefined?{key:item.key}:{text:item.text});entry.fast=performance.now();}
  catch(e){entry.tq.length=0;if(!entry.paused)toast(e.message||String(e));break;}
  entry.tq.shift();}}
 finally{entry.draining=false;}
 if(T.view===entry&&typeof pollSoon==='function')pollSoon(entry);}

// ─── The bar ─────────────────────────────────────────────────────────────────
function tkBar(entry){
 tkPrefs();const bar=el('div','terminal-keys tk-bar');bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','终端按键');
 const mods=el('div','tk-mods');
 for(const k of TK_MODS){const b=btn(k==='shift'?'⇧':TK_LABEL[k],'key mod-key',()=>{tkHaptic();tkModTap(entry,k);});b.id='tk-'+k;b.setAttribute('aria-label',TK_LABEL[k]);
  b.addEventListener('mousedown',e=>e.preventDefault());mods.append(b);}
 const edit=btn('','key tk-edit',()=>tkEditSheet(),'edit');edit.setAttribute('aria-label','自定义按键');edit.title='自定义按键';edit.addEventListener('mousedown',e=>e.preventDefault());mods.append(edit);
 const pager=el('div','tk-pager');const dots=el('div','tk-dots');dots.setAttribute('aria-hidden','true');
 bar.append(mods,pager,dots);
 let shape='';const layout=()=>{if(!bar.isConnected)return;const w=pager.clientWidth;if(!w)return;
  const rows=innerHeight>=600&&!(innerWidth>innerHeight&&innerHeight<560)?2:1,cols=Math.max(3,Math.floor((w+6)/(48+6)));
  const s=rows+'x'+cols+':'+TK.order.join()+'/'+[...TK.hidden].join();if(s===shape)return;shape=s;
  bar.classList.toggle('two-rows',rows===2);tkFill(entry,pager,dots,rows,cols);};
 bar._layout=()=>{shape='';layout();};
 new ResizeObserver(()=>requestAnimationFrame(layout)).observe(pager);
 // Rows follow the window height (soft keyboard up / down, rotation), which the pager's own width misses.
 TK.layout=layout;
 let tick=0;pager.addEventListener('scroll',()=>{cancelAnimationFrame(tick);tick=requestAnimationFrame(()=>tkDots(entry,pager,dots));},{passive:true});
 requestAnimationFrame(()=>{layout();tkPaintMods(entry);});
 return bar;}
function tkHaptic(){if(typeof haptic==='function')haptic('tick');}
function tkFill(entry,pager,dots,rows,cols){
 const keys=tkVisible(),per=rows*cols,pages=Math.max(1,Math.ceil(keys.length/per));
 const first=entry.tkFirst||0;pager.replaceChildren();
 for(let p=0;p<pages;p++){const page=el('div','tk-page');page.style.gridTemplateColumns='repeat('+cols+',minmax(0,1fr))';page.style.gridTemplateRows='repeat('+rows+',44px)';
  for(const [id,label,name,aria,tip] of keys.slice(p*per,(p+1)*per)){
   const b=btn(label,'key'+(name==='enter'?' enter-key':label.length===1?' char-key':/^\^/.test(label)?' combo-key':''),()=>{tkHaptic();tkPress(entry,name);});
   b.dataset.key=name;b.dataset.id=id;if(aria)b.setAttribute('aria-label',aria);b.dataset.tip=tip?(aria||label)+'：'+tip:'';if(tip)b.title=b.dataset.tip;
   b.addEventListener('mousedown',e=>e.preventDefault());page.append(b);}
  pager.append(page);}
 dots.replaceChildren(...Array.from({length:pages>1?pages:0},()=>el('i')));
 // Stay on the page that holds the key you were looking at.
 const at=Math.min(pages-1,Math.floor(first/per));pager.scrollLeft=at*pager.clientWidth;tkDots(entry,pager,dots);tkPaintKeys(entry);}
function tkDots(entry,pager,dots){const w=pager.clientWidth||1,at=Math.round(pager.scrollLeft/w);
 [...dots.children].forEach((d,i)=>d.classList.toggle('on',i===at));
 const page=pager.children[at];const id=page?.firstElementChild?.dataset.id;if(id)entry.tkFirst=tkVisible().findIndex(k=>k[0]===id);}
function tkRepaint(entry,relayout){if(T.view!==entry)return;const bar=document.querySelector('.tk-bar');if(bar&&relayout)bar._layout?.();tkPaintMods(entry);}

// ─── 自定义按键 ───────────────────────────────────────────────────────────────
function tkEditSheet(){
 const entry=T.view;const box=sheet('自定义按键');box.classList.add('tk-sheet');
 box.append(el('p','fine','选哪些键出现在按键栏、按什么顺序排。只存在这台手机上，每台电脑分开记。Ctrl、Alt、Shift 一直在最左边。'));
 const list=el('div','tk-edit-list');list.setAttribute('role','list');box.append(list);
 const paint=()=>{list.replaceChildren();TK.order.forEach((id,i)=>{const [,label,name,aria]=TK_BY.get(id);
  const row=el('div','tk-edit-row'+(TK.hidden.has(id)?' hidden-key':''));row.setAttribute('role','listitem');
  const cap=el('span','tk-edit-cap',label);const what=el('span','grow tk-edit-name',aria&&aria!==label?aria:name);
  const sw=el('input');sw.type='checkbox';sw.checked=!TK.hidden.has(id);sw.setAttribute('aria-label','显示 '+(aria||label));
  sw.onchange=()=>{if(sw.checked)TK.hidden.delete(id);else TK.hidden.add(id);changed();};
  const up=ib('send','往前移 '+(aria||label),()=>move(i,-1));up.disabled=i===0;
  const dn=ib('down','往后移 '+(aria||label),()=>move(i,1));dn.disabled=i===TK.order.length-1;
  const lab=el('label','tk-edit-show');lab.append(sw);row.append(lab,cap,what,up,dn);list.append(row);});};
 const changed=()=>{tkSave();paint();if(entry)tkRepaint(entry,true);};
 const move=(i,d)=>{const j=i+d;if(j<0||j>=TK.order.length)return;const o=TK.order.slice();[o[i],o[j]]=[o[j],o[i]];TK.order=o;changed();
  requestAnimationFrame(()=>list.children[j]?.querySelector(d<0?'button':'button:last-child')?.focus());};
 const row=el('div','sheet-actions');row.append(btn('恢复默认','secondary',()=>{TK.order=TK_DEFAULT.slice();TK.hidden=new Set();changed();}),btn('完成','primary',closeSheet));
 box.append(row);paint();}

// ─── Direct keyboard for pane snapshots (Herdr / tmux) ─────────────────────────
// A hidden text field takes the keyboard: hardware keys with their real modifiers, soft-keyboard text
// (IME composition is committed first), Backspace and Enter. The field keeps two placeholder
// characters so a soft keyboard's Backspace on "empty" still arrives as an edit.
const TK_PAD='\u200b\u200b';
function tkCatcher(entry,surface){
 const c=el('textarea','tk-catch');c.setAttribute('aria-label','直接键盘输入');c.setAttribute('aria-hidden','true');c.tabIndex=-1;c.setAttribute('autocapitalize','off');c.setAttribute('autocomplete','off');c.setAttribute('autocorrect','off');c.spellcheck=false;c.value=TK_PAD;
 const reset=()=>{c.value=TK_PAD;c.setSelectionRange(TK_PAD.length,TK_PAD.length);};
 const text=t=>{if(!t)return;if(tkLatched(entry)&&[...t].length===1&&/^[!-~ ]$/.test(t)){tkPress(entry,t===' '?'space':tkAlpha(t)&&t!==t.toLowerCase()?'shift+'+t.toLowerCase():t);return;}
  if(entry.ended||entry.paused){toast('终端不可输入，请查看状态或刷新');return;}tkQueue(entry,{text:t});};
 c.addEventListener('keydown',e=>{if(e.isComposing||e.keyCode===229)return;const name=tkFromEvent(e,tkMods(entry));if(!name)return;e.preventDefault();tkPress(entry,name,{latched:false});tkUsed(entry);});
 c.addEventListener('beforeinput',e=>{if(e.isComposing||e.inputType==='insertCompositionText')return;
  const t=e.inputType;
  if(t==='insertText'||t==='insertReplacementText'){e.preventDefault();text(e.data||e.dataTransfer?.getData('text/plain')||'');}
  else if(t==='insertFromPaste'){e.preventDefault();text(e.dataTransfer?.getData('text/plain')||'');}
  else if(t==='deleteContentBackward'){e.preventDefault();tkPress(entry,'backspace');}
  else if(t==='deleteContentForward'){e.preventDefault();tkPress(entry,'delete');}
  else if(t==='insertLineBreak'||t==='insertParagraph'){e.preventDefault();tkPress(entry,'enter');}
  else if(t.startsWith('delete')||t.startsWith('insert')||t.startsWith('history')||t.startsWith('format'))e.preventDefault();});
 c.addEventListener('compositionend',e=>{text(e.data||'');reset();});
 c.addEventListener('input',()=>{if(c.value!==TK_PAD&&!c.matches(':focus-within')||c.value.length>8)reset();});
 c.addEventListener('focus',()=>{entry.catching=true;surface.classList.add('catching');reset();tkKbdState(entry);});
 c.addEventListener('blur',()=>{entry.catching=false;surface.classList.remove('catching');tkKbdState(entry);});
 return c;}
function tkKbdState(entry){const b=document.getElementById('term-kbd');if(!b)return;const on=entry.kind==='ssh'||entry.kind==='attach'?!!entry.focused:!!entry.catching;
 b.classList.toggle('on',on);b.setAttribute('aria-pressed',String(on));}
// 直接键盘 on / off: the xterm itself, or the catcher of a snapshot.
function tkKbdToggle(entry){
 if(entry.kind==='ssh'||entry.kind==='attach'){if(entry.focused)entry.term.blur();else entry.term.focus();return;}
 const c=document.querySelector('.tk-catch');if(!c)return;if(document.activeElement===c)c.blur();else{c.focus({preventScroll:true});toast('直接键盘：按的键直接发到窗格');}}
// Bytes from the xterm (soft keyboard, hardware keyboard, paste) with the bar's modifiers added.
function tkXtermData(entry,data){
 if(!tkLatched(entry))return data;const name=tkDecode(data);
 if(!name){tkUsed(entry);toast('修饰键只对单个按键有效，这次按原样发了');return data;}
 const full=tkWith(name,tkMods(entry));const bytes=tkBytes(full,!!entry.term?.modes?.applicationCursorKeysMode);tkUsed(entry);
 if(bytes===null){toast(TK_NO_CODE);return '';}
 return bytes;}
