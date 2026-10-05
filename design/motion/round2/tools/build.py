"""Assembles round2/index.html: one self-contained file (fonts, CSS, JS, SVG inlined; works offline from file://)."""
import pathlib, base64, sys
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from cards import SECTIONS, HERO, CARDS, TOUR, HIGHLIGHTS
R = pathlib.Path(__file__).resolve().parent.parent
C = R / "components"
R1 = R.parent / "components"
FONTS = [("Figtree", "figtree", "normal", "300 900"), ("Fraunces", "fraunces", "normal", "100 900"),
         ("Fraunces", "fraunces-italic", "italic", "100 900"), ("JetBrains Mono", "jetbrains-mono", "normal", "100 800")]
def fontface():
    out = []
    for fam, f, style, w in FONTS:
        b = base64.b64encode((R / "assets/fonts" / f"{f}.woff2").read_bytes()).decode()
        out.append(f'@font-face{{font-family:"{fam}";font-style:{style};font-weight:{w};font-display:swap;src:url(data:font/woff2;base64,{b}) format("woff2");}}')
    return "\n".join(out)
IDS = [HERO["id"]] + [c["id"] for c in CARDS]
css_files = [R1 / "tokens.css", C / "core/springs.css", C / "core/core.css"] + [C / "tray/tray-icon.css"] + [C / i / f"{i}.css" for i in IDS if (C / i / f"{i}.css").exists()] + [R / "gallery/gallery.css"]
js_files = [C / "core/core.js"] + [C / i / f"{i}.js" for i in IDS if (C / i / f"{i}.js").exists()] + [R / "gallery/gallery.js"]
ICON_REPLAY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>'
ICON_THEME = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>'
def stage(i):
    p = C / i / f"{i}.html"
    return p.read_text() if p.exists() else f'<div style="display:grid;place-items:center;height:100%;color:var(--faint)">{i}</div>'
def card(c, hero=False):
    dwell = f' data-dwell="{c["dwell"]}"' if c.get("dwell") else ""
    return f'''<article class="card" id="p-{c["id"]}" data-piece="{c["id"]}" data-theme="dark" style="--span:{c["span"]};--h:{c["h"]}px"{dwell}>
  <header><span class="card-no">{c["no"]}</span><h3>{c["name"]}</h3>
    <div class="card-tools"><button class="c-btn c-theme" title="Toggle light / dark" aria-label="Toggle light or dark theme for this card">{ICON_THEME}</button>
    <button class="c-btn c-replay" title="Replay" aria-label="Replay {c["name"]}">{ICON_REPLAY}<span>Replay</span></button></div></header>
  <div class="stage">{stage(c["id"])}</div>
  <footer><dt>Where</dt><dd>{c["where"]}</dd><dt>Idea</dt><dd>{c["idea"]}</dd><dt>Reduced</dt><dd>{c["reduced"]}</dd><dt>Easing</dt><dd><code>{c["ease"]}</code></dd></footer>
</article>'''
MARK = '<svg viewBox="100 100 824 824"><defs><linearGradient id="gm-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b261f"/><stop offset="1" stop-color="#141210"/></linearGradient><linearGradient id="gm-o" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9d8fff"/><stop offset="1" stop-color="#7c6af7"/></linearGradient></defs><rect x="100" y="100" width="824" height="824" rx="185" fill="url(#gm-bg)"/><path d="M316 300 V540 A196 196 0 0 0 708 540 V300" fill="none" stroke="url(#gm-o)" stroke-width="84" stroke-linecap="round"/><path d="M426 300 V540 A86 86 0 0 0 598 540 V300" fill="none" stroke="#f3eee6" stroke-width="64" stroke-linecap="round"/></svg>'
import json
springs = json.loads((C / "core/springs.json").read_text())
toks = "".join(f'<div class="tok" title="click to replay"><b>spring-{k}</b><p>{v["note"]}</p><div class="lane"><i style="--d:{v["durationMs"]}ms;--e:var(--spring-{k})"></i></div><small>k {v["stiffness"]} · c {v["damping"]} · ζ {v["dampingRatio"]} · {v["durationMs"]} ms</small></div>' for k, v in springs.items())
secs = []
for sid, title, desc in SECTIONS:
    cs = "\n".join(card(c) for c in CARDS if c["sec"] == sid)
    secs.append(f'<section class="g-sec" id="s-{sid}"><header><h2>{title}</h2><p>{desc}</p></header><div class="g-grid">{cs}</div></section>')
nav = "".join(f'<a href="#s-{sid}">{t}</a>' for sid, t, _ in SECTIONS) + '<a href="#s-tokens">Springs</a>'
html = f'''<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ensemble · motion round 2</title>
<style>
{fontface()}
{chr(10).join(f"/* ── {p.relative_to(R.parent)} ── */" + chr(10) + p.read_text() for p in css_files)}
</style>
</head>
<body data-tour="{TOUR}" data-tour-highlights="{HIGHLIGHTS}">
<div class="g-top"><div class="g-wrap">
  <div class="g-brand">{MARK}<span>Ensemble motion <small>· round 2</small></span></div>
  <nav class="g-nav">{nav}</nav>
  <div class="g-ctl">
    <button class="g-btn" id="g-replay" title="Replay every visible piece">Replay all</button>
    <button class="g-btn" id="g-theme" aria-pressed="false" title="Switch every card to light">Light cards</button>
    <button class="g-btn" id="g-reduce" aria-pressed="false" title="Preview the reduced-motion fallbacks">Reduce motion</button>
  </div>
</div></div>
<main class="g-wrap">
  <div class="g-intro">
    <h1>Two voices, <em>moving in sync</em>.</h1>
    <div><p>Round 2 of the Ensemble motion system: 17 new pieces for celebrations, arrivals, collaboration, touch, voice, recovery, native tray icons and brand reveals. Everything is CSS/SVG plus a little vanilla JS, driven by real springs, and every piece has a reduced-motion fallback.</p>
      <div class="g-chips"><span class="g-chip">agent #7c6af7</span><span class="g-chip">you #f3eee6</span><span class="g-chip">5 spring tokens</span><span class="g-chip">transform + opacity</span><span class="g-chip">prefers-reduced-motion</span></div></div>
  </div>
  <div class="g-hero">{card(HERO, True)}</div>
  {"".join(secs)}
  <section class="g-sec" id="s-tokens"><header><h2>Springs</h2><p>The five motion tokens behind every piece. Click one to replay it. They're exported as CSS <code>linear()</code> easings and as <code>springs.json</code> for SwiftUI, Reanimated and Compose.</p></header>
  <div class="g-tokens">{toks}</div></section>
  <div class="g-foot"><span>Ensemble motion round 2 · Sep 2026</span><span>Round 1 (placement map + agent-working system): <a href="../index.html">../index.html</a></span><span>Fonts: Figtree, Fraunces, JetBrains Mono (SIL OFL), embedded.</span></div>
</main>
{chr(10).join(f"<script>/* {p.relative_to(R.parent)} */" + chr(10) + p.read_text() + "</script>" for p in js_files)}
</body>
</html>
'''
(R / "index.html").write_text(html)
print("round2/index.html", len(html) // 1024, "KB")
