'use strict';
// /status and /usage as one readable card.
//  · Claude Code 2.1.268 draws /status, /usage, /config and /stats as one panel with tabs
//    (Status · Config · Usage · Stats); the screen only ever shows the tab in front, so the 「命令输出」
//    card used to show one tab and a row of keys. Now, when the phone itself sent /status or /usage
//    and its first read finds that panel with Claude idle and nothing else waiting, the bridge op
//    `panelTour` walks the tabs (→ only; ↓ only to scroll Status / Usage; Esc at the end; every key
//    checked against a re-read, see docs/PROTOCOL.md) and the card lists every tab as rows.
//    That is the only time the phone presses keys on its own, and only because of that command.
//  · Codex /status is one screen already: its rows are read from the command card's screen.
// Rows: "Key:   value" (continued on the next indented line), two-column settings ("Auto-compact
// true"), usage bars ("27% used" / "83% left" with its reset time), short headings; anything else
// stays as text, and the terminal's own text is one tap away (终端原文).
const PANEL_NAMES={Status:'状态',Config:'设置',Usage:'用量',Stats:'统计'};
const PANEL_COMMANDS=['status','usage'];
// The panel's tab row: "Settings  Status   Config   Usage   Stats".
function panelSeen(text){return String(text||'').split('\n').some(l=>{const w=l.trim().split(/\s{2,}/);return w.length>=3&&w[0]==='Settings'&&w.includes('Status');});}
function panelWanted(card){return card.provider==='claude'&&PANEL_COMMANDS.includes(card.name)&&card.state==='sent'&&!card.tour;}
// After the card's first read (slashCapture): walk the panel when it is there and nothing is in the way.
function panelAfterCapture(card){
 if(!card.tourChance)return;card.tourChance=false;
 if(!panelWanted(card)||!panelSeen(card.screen))return;
 if(card.menu||!['idle','done'].includes(card.status||'')){card.tour='skipped';card.tourError=card.menu?'屏幕上有个选择框在等你，没去翻面板。':'Agent 现在不是空闲状态，没去翻面板。';slashPaint(card);return;}
 panelTour(card);}
async function panelTour(card){
 const c=S.chat,a=c?.agent;if(!a||c.stale||card.key!==draftKey())return;
 card.tour='running';card.tourError='';slashPaint(card);
 try{
  const r=await remote('panelTour',{session:S.session,target:a.pane_id,identity:a.identity,id:uuid(),command:card.name});
  card.sections=(Array.isArray(r?.tabs)?r.tabs:[]).filter(t=>t&&typeof t.tab==='string'&&typeof t.text==='string').map(t=>({tab:t.tab,text:t.text,more:!!t.more}));
  card.tour='done';card.tourStopped=typeof r?.stopped==='string'?r.stopped:'';
  if(r?.closed){card.panel=false;card.closed=true;card.menu=null;}
 }catch(e){card.tour='failed';card.tourError='没读全：'+(e.message||e)+'。不会自动重来，用下面的键自己看，或先看一眼终端。';}
 finally{if(card.tour==='running')card.tour='failed';slashPaint(card);if(!S.demo)setTimeout(()=>refreshStatus(),300);}
 // Still open (it stopped half-way, or the request failed): one read so the card's keys match the screen.
 if(S.chat===c&&(card.tour==='failed'||card.panel))await slashCapture(card,{after:300});}

// ─── Rows ───────────────────────────────────────────────────────────────────
const PANEL_SKIP=[/^[╭╰│]/,/^⌕/,/^Overview\s{2,}Models$/,/^Less\b.*\bMore$/,/^All time · Last 7 days/,/^((Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*){4,}$/];
const PANEL_HEAT=/[·░▒▓█]{6,}/;
const PANEL_KV=/^([A-Za-z][\w .()\/'+-]{0,44}?):\s+(\S.*)$/;
function panelRows(text){
 const rows=[];let last=null,bar=null,heat=false;const lines=String(text||'').split('\n');
 lines.forEach((raw,i)=>{
  const line=raw.trim();if(!line){last=null;return;}
  if(PANEL_SKIP.some(re=>re.test(line)))return;
  const more=line.match(/^↓\s*(\d+) more below$/);if(more){rows.push({note:'还有 '+more[1]+' 项没显示，要在终端里往下翻'});last=null;return;}
  const pct=line.match(/(\d{1,3}(?:\.\d+)?)%\s*(used|left)\b/i);
  // A value that wrapped (the next line, no key of its own): under the value column, or back at
  // the left edge when the pane is narrow ("Usage: 0 input, … 0 cache" / "write").
  if(last&&last.col&&!pct&&!PANEL_KV.test(line)&&(raw.length-raw.trimStart().length>=last.col-1||!/\S\s{3,}\S/.test(line))){last.v+=' '+line;return;}
  if(pct){const before=line.slice(0,pct.index).replace(/[\[\]█▉▊▋▌▍▎▏░▒▓■□\s]+$/,'').replace(/:$/,'').trim();
   const after=line.slice(pct.index+pct[0].length).replace(/^[\s·,]+/,'').replace(/^\((.*)\)$/,'$1').trim();
   const prev=rows.at(-1);const label=before||(prev&&prev.h!==undefined?(rows.pop(),prev.h):'');
   bar={bar:true,label,pct:Math.min(100,+pct[1]),word:pct[2].toLowerCase(),note:after};rows.push(bar);last=null;return;}
  if(PANEL_HEAT.test(line)&&!line.includes(':')){heat=true;return;}
  if(/^resets?\b/i.test(line)&&bar&&rows.at(-1)===bar&&!bar.note){bar.note=line;return;}
  // Several "Key: value" on one line (Stats: "Sessions: 31        Longest session: 1d 1h").
  const parts=line.split(/\s{3,}/);
  if(parts.length>1&&parts.every(p=>PANEL_KV.test(p))){parts.forEach(p=>{const m=p.match(PANEL_KV);rows.push({k:m[1],v:m[2]});});last=null;return;}
  const kv=line.match(PANEL_KV);
  if(kv){const r={k:kv[1],v:kv[2],col:raw.indexOf(kv[2])};rows.push(r);last=r;return;}
  // Two columns (Config: "Auto-compact            true").
  const two=line.match(/^(\S.*?\S)\s{3,}(\S.*)$/);
  if(two){rows.push({k:two[1],v:two[2]});last=null;return;}
  const next=lines.slice(i+1).find(x=>x.trim());
  // A short title over the rows below it ("Session", "Current week (all models)").
  const after=i>0&&lines[i-1].trim();
  if(!after&&next!==undefined&&line.length<=40&&line.split(/\s+/).length<=6&&!/[.!?~。·\/\d]|http/.test(line)){rows.push({h:line});last=null;return;}
  // A sentence that wrapped onto this line joins the one above it.
  const prev=rows.at(-1);if(after&&prev&&prev.t!==undefined){prev.t+=' '+line;return;}
  rows.push({t:line});last=null;});
 if(heat)rows.push({note:'活跃度热力图只在终端里看得到'});
 return rows;}
// Codex /status: the rows between the echoed "/status" and the composer ("› …").
function panelCodexText(screen){
 const lines=String(screen||'').split('\n');let at=lines.findIndex(l=>/^\s*\/status\s*$/.test(l));if(at<0)at=-1;
 const out=[];for(const l of lines.slice(at+1)){if(/^\s*›\s/.test(l))break;out.push(l);}
 while(out.length&&!out.at(-1).trim())out.pop();return out.join('\n');}

// ─── View ───────────────────────────────────────────────────────────────────
function panelRowsView(rows){
 const box=el('div','panel-rows');
 for(const r of rows){
  if(r.h!==undefined){box.append(el('div','panel-h',r.h));continue;}
  if(r.note!==undefined&&!r.bar){box.append(el('p','panel-note',r.note));continue;}
  if(r.t!==undefined){box.append(el('p','panel-text',r.t));continue;}
  if(r.bar){const row=el('div','panel-bar');const top=el('div','panel-bar-top');top.append(el('span','panel-k',r.label||'用量'),el('span','panel-pct',r.pct+'% '+(r.word==='left'?'剩余':'已用')));
   const track=el('div','panel-track');track.setAttribute('role','meter');track.setAttribute('aria-valuemin','0');track.setAttribute('aria-valuemax','100');track.setAttribute('aria-valuenow',String(r.pct));track.setAttribute('aria-label',(r.label||'用量')+' '+r.pct+'% '+(r.word==='left'?'剩余':'已用'));
   const fill=el('div','panel-fill'+(r.word==='left'?' left':''));fill.style.width=r.pct+'%';track.append(fill);row.append(top,track);
   if(r.note)row.append(el('div','panel-reset',r.note.replace(/^resets?\s*/i,'重置：')));box.append(row);continue;}
  const row=el('div','panel-kv');row.append(el('span','panel-k',r.k),el('span','panel-v',r.v));box.append(row);}
 return box;}
function panelSectionText(text){return String(text||'').split('\n').map(l=>l.replace(/^ {1,3}/,'')).join('\n').trim();}
function panelCopy(card){
 if(card.sections?.length)return card.sections.map(s=>'【'+(PANEL_NAMES[s.tab]||s.tab)+' '+s.tab+'】\n'+panelSectionText(s.text)).join('\n\n');
 return panelSectionText(panelCodexText(card.screen));}
// The card body for a walked panel (or Codex /status); null when the plain screen view fits better.
function panelBody(card){
 const codex=card.provider==='codex'&&card.name==='status'&&card.screen&&!card.panel&&!card.menu;
 if(!card.sections?.length&&!codex)return null;
 const box=el('div','panel-view');
 if(card.sections?.length){
  const nav=el('div','panel-index');nav.append(el('span','',card.sections.length+' 个标签都读到了：'+card.sections.map(s=>PANEL_NAMES[s.tab]||s.tab).join(' · ')));box.append(nav);
  for(const s of card.sections){
   const rows=panelRows(s.text),open=s.tab!=='Config'&&s.tab!=='Stats';
   const sec=el('details','panel-section');sec.dataset.tab=s.tab;if(open)sec.open=true;
   const sum=el('summary','panel-summary');sum.append(el('span','panel-name',PANEL_NAMES[s.tab]||s.tab),el('span','panel-en',s.tab===PANEL_NAMES[s.tab]?'':s.tab),el('span','panel-count',rows.filter(r=>r.k!==undefined||r.bar).length+' 项'));sec.append(sum);
   if(rows.length)sec.append(panelRowsView(rows));else sec.append(el('pre','slash-out',panelSectionText(s.text)||'（这个标签是空的）'));
   if(s.more&&!rows.some(r=>r.note&&/往下翻/.test(r.note)))sec.append(el('p','panel-note','画面没显示完，剩下的要在终端里往下翻'));
   box.append(sec);}
 }else{const rows=panelRows(panelCodexText(card.screen));if(!rows.length)return null;box.append(panelRowsView(rows));}
 if(card.tourStopped)box.append(el('p','slash-error',card.tourStopped+'。'+(card.panel?'面板还开着，用下面的键处理。':'')));
 const raw=el('details','panel-raw');raw.append(el('summary','','终端原文'));
 const pre=el('pre','slash-screen',card.sections?.length?card.sections.map(s=>'── '+s.tab+' ──\n'+s.text).join('\n\n'):card.screen);pre.tabIndex=0;pre.setAttribute('aria-label','终端原文');raw.append(pre);box.append(raw);
 return box;}
