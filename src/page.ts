/**
 * The status page: the connectors around the hub and the calls passing through.
 * The full map (links as lit lines, the brain as the orb) grows from this.
 */
export function statusPage(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hyperlink</title>
<style>
:root{--bg:#14110f;--panel:#1d1915;--line:#3a322a;--text:#efe6da;--muted:#a3968a;--accent:#e8b04b;--ok:#7fbf7f;--bad:#e07a6a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:20px 24px;border-bottom:1px solid var(--line)}
.orb{width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#fff3d1,var(--accent) 45%,#8a5a12);box-shadow:0 0 18px var(--accent)}
h1{font-size:18px;margin:0}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;padding:20px 24px}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px}
.row{display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--line)}.row:first-of-type{border-top:0}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:var(--muted)}.running{background:var(--ok)}.failed{background:var(--bad)}.starting{background:var(--accent)}
small{color:var(--muted)}code{color:var(--accent)}
</style></head><body>
<header><div class="orb" aria-hidden="true"></div><h1>Hyperlink</h1><small id="sum"></small></header>
<main><section><h2>Connectors</h2><div id="connectors"><small>Loading…</small></div></section>
<section><h2>Activity</h2><div id="activity"><small>Nothing has passed through yet.</small></div></section></main>
<script>
const token=${JSON.stringify(token)};const get=p=>fetch(p,{headers:{authorization:'Bearer '+token}}).then(r=>r.json());
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function draw(){try{const s=await get('/api/status');document.getElementById('sum').textContent=s.connectors.length+' connectors · '+s.tools+' tools';
document.getElementById('connectors').innerHTML=s.connectors.length?s.connectors.map(c=>'<div class="row"><span><span class="dot '+c.state+'"></span>'+esc(c.name)+' <small>'+c.kind+'</small></span><small>'+(c.problem?esc(c.problem):c.state+' · '+c.tools+' tools')+'</small></div>').join(''):'<small>No connectors yet. Add one: <code>hyperlink add &lt;name&gt; -- &lt;command&gt;</code></small>';
const a=await get('/api/activity?limit=30');if(a.activity.length)document.getElementById('activity').innerHTML=a.activity.map(e=>'<div class="row"><span><span class="dot '+(e.ok?'running':'failed')+'"></span>'+esc(e.connector)+' · '+esc(e.tool)+'</span><small>'+e.ms+' ms · '+new Date(e.at).toLocaleTimeString()+'</small></div>').join('')}catch(e){document.getElementById('sum').textContent='Hyperlink is not answering.'}}
draw();setInterval(draw,3000);
</script></body></html>`
}
