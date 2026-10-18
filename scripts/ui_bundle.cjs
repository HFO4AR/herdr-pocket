// Builds the same single-page HTML as MainActivity (keep the file lists in sync).
const fs=require('node:fs'),path=require('node:path');
const CSS=['vendor/xterm.css','app.css','chat.css','timeline.css','markdown.css','follow.css','answer.css','images.css','files.css','queue.css','dirpick.css','create.css','slash.css','rename.css','close.css','settings.css','keys.css','onboard.css','resume.css','hops.css','native.css','lists.css','help.css','find.css','terminals.css','glyphs.css','ansi.css','kids.css','bg.css','mode.css','foot.css','activity.css','tmux.css','hpanes.css','pickup.css','guard.css','sftp.css','layout.css'];
const JS=['markdown.js','ansi.js','timeline.js','images.js','files.js','answer.js','demo.js','follow.js','queue.js','dirpick.js','create.js','slash.js','rename.js','close.js','cache.js','settings.js','keys.js','hops.js','onboard.js','resume.js','native.js','glance.js','help.js','find.js','fileview.js','kids.js','bg.js','mode.js','foot.js','activity.js','app.js','tmux.js','hpanes.js','pickup.js','guard.js','sftp.js','layout.js'];
// A data: URL for page.goto. Chrome refuses URLs over 2 MiB, and encodeURIComponent triples every
// space, quote and bracket: only what a data URL cannot hold raw is escaped (%, #, line breaks and
// tabs, which the URL parser would drop, other control characters and everything non-ASCII).
function url(html){return 'data:text/html;charset=utf-8,'+html.replace(/[%#\x00-\x1f\x7f]|[^\x00-\x7f]+/g,encodeURIComponent);}
module.exports=function bundle(root){
 const ui=path.join(root,'app/src/main/assets/ui'),read=f=>fs.readFileSync(path.join(ui,f),'utf8');
 return read('index.html')
  .replace('/*BUNDLED_CSS*/',()=>CSS.map(read).join('\n'))
  .replace('/*TERMINAL_VENDOR*/',()=>read('vendor/xterm.js')+'\n'+read('vendor/addon-fit.js'))
  .replace('/*TERMINAL_APP*/',()=>read('terminals.js'))
  .replace('/*BUNDLED_JS*/',()=>JS.map(read).join('\n'));
};
module.exports.url=url;
