// Colored, read-only terminal screens: the chat 「终端」 tab and the confirm panel. The bridge sends
// the agent's screen with SGR color codes only (pocket_bridge.clean_ansi); this turns them into
// spans with inline colors. Text goes in as text nodes only (never HTML).
// Wide desktop panes (~230 columns) read badly on a phone as-is, so by default lines wrap with a
// hanging indent, padding is trimmed (a colored band stays a full-width band), and rule lines
// (──────) become one rule that fits the screen. 「原始宽度」 keeps the exact layout and scrolls.
// The 原始宽度 choice is per phone, kept in the per-device cache like the terminal font size
// (the WebView has no DOM storage).
const ANSI={raw:false,loaded:false,set:false};
const ANSI_RULE_CH='─━═┄┅┈┉╌╍╼╾⎯';
const ANSI_RULE=new RegExp('^['+ANSI_RULE_CH+']{3,}$');
const ANSI_LABELED=new RegExp('^(['+ANSI_RULE_CH+']{1,6}) (.*[^'+ANSI_RULE_CH+' ].*?) (['+ANSI_RULE_CH+']{3,})$');
// Bullets and markers whose continuation lines should hang under the text, not under the marker.
const ANSI_HANG=/^(\s*)(?:(?:[●•⎿└├│✻✶✢✳✽·*\-–+›❯>▸⏵✔✓✗✘☐☑□■◼◻]|\d{1,2}[.)])\s+)?/;

function ansiStrip(s){return String(s||'').replace(/\x1b\[[0-9;:]*m/g,'');}

// ── SGR → style state. States are immutable, so runs can share them. ──
const ANSI_RESET=Object.freeze({});
function ansiSgr(st,params){
 const p=params===''?['0']:params.split(';');const n={...st};
 for(let i=0;i<p.length;i++){
  const part=p[i];
  if(part.includes(':')){const sub=part.split(':').map(x=>x===''?0:+x);const k=sub[0];
   if(k===38||k===48){const c=sub[1]===5?ansiIndex(sub[2]):sub[1]===2&&sub.length>=5?sub.slice(-3):undefined;if(c!==undefined)n[k===38?'fg':'bg']=c;}
   else if(k===4)n.u=sub[1]>0;continue;}
  const c=part===''?0:+part;
  if(c===0){for(const k in n)delete n[k];}
  else if(c===1)n.b=true;else if(c===2)n.d=true;else if(c===3)n.i=true;else if(c===4)n.u=true;
  else if(c===7)n.v=true;else if(c===8)n.h=true;else if(c===9)n.s=true;
  else if(c===21||c===22){delete n.b;delete n.d;}else if(c===23)delete n.i;else if(c===24)delete n.u;
  else if(c===27)delete n.v;else if(c===28)delete n.h;else if(c===29)delete n.s;
  else if(c>=30&&c<=37)n.fg=c-30;else if(c>=90&&c<=97)n.fg=c-82;else if(c===39)delete n.fg;
  else if(c>=40&&c<=47)n.bg=c-40;else if(c>=100&&c<=107)n.bg=c-92;else if(c===49)delete n.bg;
  else if(c===38||c===48){const key=c===38?'fg':'bg';
   if(p[i+1]==='5'){const v=ansiIndex(+p[i+2]);if(v!==undefined)n[key]=v;i+=2;}
   else if(p[i+1]==='2'){n[key]=[+p[i+2]||0,+p[i+3]||0,+p[i+4]||0].map(x=>Math.min(255,x));i+=4;}}
  else if(c===58&&(p[i+1]==='5'||p[i+1]==='2'))i+=p[i+1]==='5'?2:4;}
 return Object.keys(n).length?Object.freeze(n):ANSI_RESET;}
// 0–15: the app palette (--term-ansi); 16–255: the xterm cube and grays, as given.
function ansiIndex(v){if(!(v>=0&&v<=255))return undefined;if(v<16)return v;
 if(v>=232){const g=8+(v-232)*10;return [g,g,g];}
 const L=[0,95,135,175,215,255],x=v-16;return [L[Math.floor(x/36)],L[Math.floor(x/6)%6],L[x%6]];}

// Lines of runs: [{t:text, s:state}]
function ansiLines(src){
 const lines=[];let cur=[],st=ANSI_RESET,last=0,m;const re=/\x1b\[([0-9;:]*)m/g;
 const push=t=>{const parts=t.replace(/\x1b/g,'').split('\n');parts.forEach((x,k)=>{if(k){lines.push(cur);cur=[];}if(x)cur.push({t:x,s:st});});};
 while((m=re.exec(src))){push(src.slice(last,m.index));st=ansiSgr(st,m[1]);last=re.lastIndex;}
 push(src.slice(last));lines.push(cur);return lines;}

// ── Colors ──
function ansiHex(h){h=String(h||'').trim().replace('#','');if(h.length===3)h=h.split('').map(x=>x+x).join('');const n=parseInt(h.slice(0,6),16);return isNaN(n)?null:[n>>16&255,n>>8&255,n&255];}
function ansiPalette(){const cs=getComputedStyle(document.documentElement);const tok=k=>cs.getPropertyValue(k).trim();
 const pal=tok('--term-ansi').split(/\s+/).map(ansiHex);
 return {pal,bg:ansiHex(tok('--terminal'))||[28,27,25],fg:ansiHex(tok('--terminal-ink'))||[236,235,230]};}
function ansiLum(c){const f=v=>{v/=255;return v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4);};return .2126*f(c[0])+.7152*f(c[1])+.0722*f(c[2]);}
function ansiContrast(a,b){const x=ansiLum(a),y=ansiLum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
function ansiMix(a,b,t){return a.map((v,i)=>Math.round(v+(b[i]-v)*t));}
// The card is dark in both themes: a color too dark to read on it is lifted toward the ink.
function ansiReadable(fg,bg,ink,min){let c=fg;for(let k=1;k<=10&&ansiContrast(c,bg)<min;k++)c=ansiMix(fg,ink,k/10);return c;}
function ansiColor(v,P){return v===undefined?undefined:typeof v==='number'?(P.pal[v]||P.fg):v;}
function ansiCss(c){return 'rgb('+c.join(',')+')';}
function ansiApply(node,s,P){
 if(s===ANSI_RESET)return;let fg=ansiColor(s.fg,P),bg=ansiColor(s.bg,P);
 if(s.v){const f=fg||P.fg,b=bg||P.bg;fg=b;bg=f;}
 const base=bg||P.bg;
 if(fg||s.d||bg){let c=fg||P.fg;if(s.d)c=ansiMix(c,base,.42);c=ansiReadable(c,base,P.fg,s.d?2.6:4);node.style.color=ansiCss(c);}
 if(bg)node.style.backgroundColor=ansiCss(bg);
 if(s.b)node.style.fontWeight='650';if(s.i)node.style.fontStyle='italic';
 const deco=[s.u&&'underline',s.s&&'line-through'].filter(Boolean).join(' ');if(deco)node.style.textDecoration=deco;
 if(s.h)node.style.color='transparent';}

// ── Lines ──
function ansiRuleNode(char,s,P,label){
 const n=el('div','ansi-rule'+(/[━]/.test(char)?' heavy':/[═]/.test(char)?' double':'')+(label!==undefined?' labeled':''));
 const c=ansiColor(s.fg,P)||P.fg;n.style.color=ansiCss(ansiReadable(s.d?ansiMix(c,P.bg,.42):c,P.bg,P.fg,1.8));
 if(label===undefined){n.setAttribute('role','separator');return n;}
 const line=()=>{const i=el('i','ansi-rule-seg');i.setAttribute('aria-hidden','true');return i;};
 n.append(line(),el('span','ansi-rule-label',label),line());return n;}
function ansiLine(runs,P){
 const text=runs.map(r=>r.t).join('');const trimmed=text.trim();
 const style=runs.find(r=>r.t.trim())?.s||ANSI_RESET;
 if(trimmed.length>=3&&ANSI_RULE.test(trimmed))return ansiRuleNode(trimmed[0],style,P);
 const lab=trimmed.match(ANSI_LABELED);if(lab)return ansiRuleNode(lab[1][0],style,P,lab[2]);
 const n=el('div','ansi-line');
 // Padding goes; the background it carried (an input box, a highlighted row) stays as a band.
 let end=text.replace(/\s+$/,'').length;const padRun=runs.findLast(r=>r.t.length);
 let band;if(padRun&&/\s$/.test(padRun.t)){const s=padRun.s;band=s.v?(ansiColor(s.fg,P)||P.fg):ansiColor(s.bg,P);}
 if(band){n.classList.add('band');n.style.backgroundColor=ansiCss(band);n.style.setProperty('--band-bg',ansiCss(band));}
 if(!end)return n;
 const hang=Math.min(16,(text.match(ANSI_HANG)||[''])[0].length);
 if(hang&&hang<end){n.style.paddingLeft=hang+'ch';n.style.textIndent=-hang+'ch';}
 let at=0;
 for(const r of runs){if(at>=end)break;const t=r.t.slice(0,end-at);at+=r.t.length;
  if(r.s===ANSI_RESET){n.append(t);continue;}const sp=el('span','',t);ansiApply(sp,r.s,P);n.append(sp);}
 return n;}

// Render `src` (bridge `ansi`) into `box`. opts.tail keeps the last N lines (the confirm panel).
function ansiRender(box,src,opts={}){
 const P=ansiPalette(),key=src+'\u0000'+(opts.tail||0)+P.bg+P.fg;
 if(box._ansi===key)return;box._ansi=key;
 let lines=ansiLines(src);
 while(lines.length&&!lines[lines.length-1].some(r=>r.t.trim()||(r.s.bg!==undefined)))lines.pop();
 if(opts.tail)lines=lines.slice(-opts.tail);
 const frag=document.createDocumentFragment();
 for(const runs of lines)frag.append(ansiLine(runs,P));
 box.classList.add('ansi');box.classList.toggle('raw',ANSI.raw&&!opts.tail);box.replaceChildren(frag);}
// One place that paints a read-only screen: colored when the read brought `ansi`, else plain text.
function screenPaint(box,text,ansi,last){
 if(!box)return;
 if(ansi){ansiRender(box,ansi,{tail:last});return;}
 box._ansi=null;box.classList.remove('ansi');box.classList.toggle('raw',ANSI.raw&&!last);box.textContent=last?tail(text,last):text;}
// 「原始宽度」: no wrapping, scroll sideways, exactly as the desktop pane lays it out.
function ansiRawToggle(target){
 paths.width=paths.width||'M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4';
 const b=btn('','term-card-wrap',()=>{ANSI.raw=!ANSI.raw;ANSI.set=true;cachePut('term:raw',{raw:ANSI.raw});sync();toast(ANSI.raw?'原始宽度：左右滑动查看':'自动换行');},'width');
 b.setAttribute('aria-label','原始宽度');b.title='原始宽度';
 const sync=()=>{b.setAttribute('aria-pressed',String(ANSI.raw));b.classList.toggle('on',ANSI.raw);const n=target();if(n)n.classList.toggle('raw',ANSI.raw);};
 if(!ANSI.loaded){ANSI.loaded=true;cacheGet('term:raw').then(v=>{if(typeof v?.raw==='boolean'&&!ANSI.set){ANSI.raw=v.raw;if(b.isConnected)sync();}});}
 sync();return b;}
