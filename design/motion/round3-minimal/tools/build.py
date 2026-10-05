"""Assembles round3-minimal/index.html (self-contained, works offline) + compare/expressive-r1.html, compare/expressive-r2.html."""
import pathlib, base64, sys, json, re
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from cards import SECTIONS, CARDS, HIGHLIGHTS
R = pathlib.Path(__file__).resolve().parent.parent
C = R / "components"; ROOT = R.parent
FONTS = [("Figtree", "figtree", "normal", "300 900"), ("Fraunces", "fraunces", "normal", "100 900"),
         ("Fraunces", "fraunces-italic", "italic", "100 900"), ("JetBrains Mono", "jetbrains-mono", "normal", "100 800")]
FF = "\n".join(f'@font-face{{font-family:"{fam}";font-style:{st};font-weight:{w};font-display:swap;src:url(data:font/woff2;base64,{base64.b64encode((R/"assets/fonts"/f"{f}.woff2").read_bytes()).decode()}) format("woff2");}}' for fam, f, st, w in FONTS)
IDS = [c["id"] for c in CARDS]
css = [C/"core/tokens.css", C/"core/suite.css", C/"core/minimal.css"] + [C/i/f"{i}.css" for i in IDS] + [R/"gallery/gallery.css"]
js = [C/"core/u2-core.js", C/"core/motion.js"] + [C/i/f"{i}.js" for i in IDS] + [R/"gallery/gallery.js"]
def split(i):
    q, d = (C/i/f"{i}.html").read_text().split("<!--dot-->")
    return q.strip(), d.strip()
I_REPLAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>'
I_THEME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>'
I_CMP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><rect x="3" y="5" width="7" height="14" rx="1.5"/><rect x="14" y="5" width="7" height="14" rx="1.5"/></svg>'
def pane(theme, slot, lab, html):
    return f'<div class="pane" data-motion-theme="{theme}" data-motion-slot="{slot}"><span class="pane-lab">{lab}</span>{html}</div>'
def card(c):
    q, d = split(c["id"])
    return f'''<article class="card" id="p-{c["id"]}" data-piece="{c["id"]}" data-slot="{c["slot"]}" data-theme="dark" style="--span:{c["span"]};--h:{c["h"]}px">
  <header><span class="card-no">{c["no"]}</span><h3>{c["name"]}</h3><code class="slot">{c["slot"]}</code>
    <div class="card-tools"><button class="c-btn c-cmp" data-cmp="{c["id"]}" title="Compare with Expressive" aria-label="Compare {c["name"]} across themes">{I_CMP}<span>Compare</span></button>
    <button class="c-btn c-theme" title="Toggle light / dark" aria-label="Toggle light or dark for this card">{I_THEME}</button>
    <button class="c-btn c-replay" title="Replay" aria-label="Replay {c["name"]}">{I_REPLAY}<span>Replay</span></button></div></header>
  <div class="stage duo">{pane("minimal-quiet", c["slot"], "Quiet", q)}{pane("minimal-dot", c["slot"], "Dot", d)}</div>
  <footer><dt>Where</dt><dd>{c["where"]}</dd><dt>Quiet</dt><dd>{c["quiet"]}</dd><dt>Dot</dt><dd>{c["dot"]}</dd><dt>Reduced</dt><dd>{c["reduced"]}</dd><dt>Tokens</dt><dd><code>{c["tokens"]}</code></dd></footer>
</article>'''
MARK = '<svg viewBox="100 100 824 824" aria-hidden="true"><rect x="100" y="100" width="824" height="824" rx="185" fill="#2b261f"/><path d="M316 300 V540 A196 196 0 0 0 708 540 V300" fill="none" stroke="#9d8fff" stroke-width="40" stroke-linecap="round"/><path d="M426 300 V540 A86 86 0 0 0 598 540 V300" fill="none" stroke="#f3eee6" stroke-width="40" stroke-linecap="round"/></svg>'
themes = json.loads((C/"core/motion-themes.json").read_text())["themes"]
def tsum(k):
    t = themes[k]; return f'loop {t["dur-loop"]/1000:g} s · amp {t["amp"]} px · stroke {t["stroke"]} · overshoot {"yes" if t["overshoot"] else "no"}'
secs = []
for sid, title, desc in SECTIONS:
    cs = "\n".join(card(c) for c in CARDS if c["sec"] == sid)
    secs.append(f'<section class="g-sec" id="s-{sid}"><header><h2>{title}</h2><p>{desc}</p></header><div class="g-grid">{cs}</div></section>')
nav = '<a href="#s-suite">Suite</a>' + "".join(f'<a href="#s-{sid}">{t}</a>' for sid, t, _ in SECTIONS)
slotchips = "".join(f'<button class="sl" data-id="{c["id"]}" aria-pressed="false">{c["name"].split(" (")[0].split(" · Tabs")[0]}</button>' for c in CARDS)
cmpdata = {c["id"]: {"slot": c["slot"], "cmp": c["cmp"], "name": c["name"], "q": split(c["id"])[0], "d": split(c["id"])[1]} for c in CARDS}
radios = "".join(f'<label class="rd"><input type="radio" name="mt" value="{k}"{" checked" if k=="minimal-quiet" else ""}><span><b>{themes[k]["label"]}</b><small>{themes[k]["note"]}</small></span></label>' for k in ["expressive", "minimal-quiet", "minimal-dot"])
html = f'''<!doctype html>
<html lang="en" data-motion-theme="minimal-quiet">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ensemble · motion round 3 · Minimal</title>
<style>
{FF}
{chr(10).join(f"/* ── {p.relative_to(ROOT)} ── */" + chr(10) + p.read_text() for p in css)}
</style></head>
<body data-tour-highlights="{HIGHLIGHTS}" data-show="both">
<div class="g-top"><div class="g-wrap">
  <div class="g-brand">{MARK}<span>Ensemble motion <small>· round 3 · Minimal</small></span></div>
  <nav class="g-nav">{nav}</nav>
  <div class="g-ctl">
    <div class="seg" role="group" aria-label="Show flavour"><button data-show="both" aria-pressed="true">Both</button><button data-show="quiet" aria-pressed="false">Quiet</button><button data-show="dot" aria-pressed="false">Dot</button></div>
    <button class="g-btn" id="g-replay">Replay all</button>
    <button class="g-btn" id="g-theme" aria-pressed="false">Light cards</button>
    <button class="g-btn" id="g-reduce" aria-pressed="false">Reduce motion</button>
  </div></div></div>
<main class="g-wrap">
  <div class="g-intro"><h1>Less, but still <em>in sync</em>.</h1>
    <div><p>A calm motion style for people who want less movement and less ornament. It covers the same 16 moments as the Expressive style, so users can switch between them. There are two flavours. <b>Quiet</b> uses hairline strokes and one violet accent. <b>Dot</b> uses only the two dots, you and the agent. There is no confetti, no sparks and no overshoot. Movement travels 4 px at most and loops take about 3 s. The mark, the two strands and the thread are all still there.</p>
    <div class="g-chips"><span class="g-chip">16 slots × 2 flavours</span><span class="g-chip">data-motion-theme</span><span class="g-chip">--m-* tokens</span><span class="g-chip">1–1.5 px lines</span><span class="g-chip">no overshoot</span><span class="g-chip">reduced-motion overlay</span></div></div></div>

  <section class="g-sec" id="s-suite"><header><h2>The suite</h2><p>Each moment is a named slot. A style fills every slot, and switching styles changes one attribute. Pick a slot to see it in all three styles side by side.</p></header>
  <div class="suite">
    <aside class="st-set"><div class="m-cap">Settings · Appearance · Motion</div>{radios}
      <label class="rd sm"><input type="checkbox" id="st-reduce"><span><b>Reduce motion</b><small>An overlay on any style: loops go still, and everything else is a short crossfade.</small></span></label>
      <pre class="st-code" id="st-code"></pre></aside>
    <div class="cmp"><div class="cmp-slots">{slotchips}</div>
      <div class="cmp-cols">
        <div class="cmp-col" data-col="expressive"><div class="cmp-h"><b>Expressive</b><span>rounds 1–2</span><small>{tsum("expressive")}</small></div><div class="cmp-stage"><iframe class="cmp-if" title="Expressive preview" loading="lazy"></iframe><div class="cmp-ref m-mono"></div></div></div>
        <div class="cmp-col" data-col="minimal-quiet"><div class="cmp-h"><b>Minimal · Quiet</b><span>round 3</span><small>{tsum("minimal-quiet")}</small></div><div class="cmp-stage" data-theme="dark"><div class="pane" data-motion-theme="minimal-quiet"></div></div></div>
        <div class="cmp-col" data-col="minimal-dot"><div class="cmp-h"><b>Minimal · Dot</b><span>round 3</span><small>{tsum("minimal-dot")}</small></div><div class="cmp-stage" data-theme="dark"><div class="pane" data-motion-theme="minimal-dot"></div></div></div>
      </div><div class="cmp-foot m-mono" id="cmp-foot"></div></div>
  </div></section>
  {"".join(secs)}
  <div class="g-foot"><span>Ensemble motion round 3 · Minimal · Sep 2026</span><span>Architecture: <code>SUITE.md</code> · tokens: <code>components/core/motion-themes.json</code></span><span>Round 1: <a href="../index.html">../index.html</a> · Round 2: <a href="../round2/index.html">../round2/index.html</a></span></div>
</main>
<script>window.__CMP = {json.dumps(cmpdata)};</script>
{chr(10).join(f"<script>/* {p.relative_to(ROOT)} */" + chr(10) + p.read_text() + "</script>" for p in js)}
</body></html>
'''
(R/"index.html").write_text(html)
print("round3-minimal/index.html", len(html)//1024, "KB")

# ── Expressive preview pages (copies of rounds 1-2 with a "solo" view; the originals are untouched)
SOLO_R1 = '''<style>body.solo header.top,body.solo #toc,body.solo .sec,body.solo .sec-h .where,body.solo .sec-h .idea{display:none!important}
body.solo .sec.solo-on{display:block!important;margin:0;border:0;background:none}body.solo .wrap{padding:10px 12px;max-width:none}body.solo .sec-h{border:0;padding:6px 8px 10px}
html,body{overflow-x:hidden}</style><script>(function(){const go=()=>{const id=location.hash.slice(1)||"s-glyph";document.body.classList.add("solo");
document.querySelectorAll(".sec").forEach(s=>s.classList.toggle("solo-on",s.id===id));document.body.style.zoom=Math.min(1,innerWidth/820);scrollTo(0,0)};
addEventListener("DOMContentLoaded",go);addEventListener("hashchange",go);addEventListener("resize",go)})();</script>'''
SOLO_R2 = '''<style>body.solo .g-top,body.solo .g-intro,body.solo .g-sec>header,body.solo .g-foot,body.solo #s-tokens,body.solo .card>footer{display:none!important}
body.solo .card,body.solo .g-hero{display:none}body.solo .card.solo-on{display:flex;grid-column:1/-1}body.solo .g-hero:has(.solo-on){display:block;margin:0}
body.solo .g-sec{margin:0}body.solo .g-sec:not(:has(.solo-on)){display:none}body.solo .g-wrap{padding:10px 12px;max-width:none}body.solo .card{box-shadow:none}
html,body{overflow-x:hidden}</style><script>(function(){const go=()=>{const id=location.hash.slice(1)||"p-confetti";document.body.classList.add("solo");
document.querySelectorAll(".card").forEach(c=>c.classList.toggle("solo-on",c.id===id));document.body.style.zoom=Math.min(1,innerWidth/(id==="p-tray"||id==="p-reveals"||id==="p-microa"?980:720));scrollTo(0,0);
const c=document.getElementById(id);setTimeout(()=>c&&c.__mount&&c.__mount(),60)};addEventListener("load",go);addEventListener("hashchange",go)})();</script>'''
(R/"compare").mkdir(exist_ok=True)
r1 = (ROOT/"index.html").read_text()
r1 = r1.replace("<head>", "<head><style>" + FF + "</style>", 1).replace("</head>", SOLO_R1 + "</head>", 1)
(R/"compare/expressive-r1.html").write_text(r1)
r2 = (ROOT/"round2/index.html").read_text().replace("</head>", SOLO_R2 + "</head>", 1)
(R/"compare/expressive-r2.html").write_text(r2)
print("compare pages written")
