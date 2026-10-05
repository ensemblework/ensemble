#!/usr/bin/env python3
"""Build ensemble-motion-review.zip (rounds 1-3): offline, double-click index.html. Supersedes round2/tools/bundle.py."""
import re, shutil, zipfile, pathlib, html
ROOT = pathlib.Path('/workspace/ensemble-animations'); R2 = ROOT / 'round2'
OUT = ROOT / 'ensemble-motion-review.zip'
STAGE = pathlib.Path('/tmp/bundle/ensemble-motion-review')
if STAGE.parent.exists(): shutil.rmtree(STAGE.parent)
STAGE.mkdir(parents=True)
r2html = (R2 / 'index.html').read_text()
fonts = ''.join(re.findall(r'@font-face\{[^}]*\}', r2html))
assert fonts.count('@font-face') == 4
PILL = ('<a href="../index.html" style="position:fixed;left:16px;bottom:16px;z-index:9999;font:500 12px/1 Figtree,system-ui,sans-serif;'
        'color:#f3eee6;background:rgba(20,18,16,.86);border:1px solid rgba(243,238,230,.16);padding:9px 12px;border-radius:999px;'
        'text-decoration:none;backdrop-filter:blur(8px)">&larr; All rounds</a>')
# round 1: inject fonts so it renders offline with the brand faces
r1 = (ROOT / 'index.html').read_text()
r1 = r1.replace('<head>', '<head><style>' + fonts + '</style>', 1)
r1 = r1.replace('</body>', PILL + '</body>', 1)
(STAGE / 'round1').mkdir(); (STAGE / 'round1/index.html').write_text(r1)
shutil.copy(ROOT / 'PLAN.md', STAGE / 'round1/PLAN.md')
(STAGE / 'round1/media').mkdir()
for f in (ROOT / 'media').iterdir():
    if f.suffix in ('.mp4', '.png'): shutil.copy(f, STAGE / 'round1/media' / f.name)
shutil.copytree(ROOT / 'components', STAGE / 'round1/components')
# round 2
(STAGE / 'round2').mkdir()
r2 = r2html.replace('href="../index.html"', 'href="../round1/index.html"')
r2 = r2.replace('<button class="g-btn" id="g-replay"', '<a class="g-btn" href="../index.html" style="text-decoration:none;display:inline-flex;align-items:center">&larr; All rounds</a>\n    <button class="g-btn" id="g-replay"', 1)
assert 'All rounds' in r2
(STAGE / 'round2/index.html').write_text(r2)
shutil.copy(R2 / 'PLAN-round2.md', STAGE / 'round2/PLAN-round2.md')
shutil.copytree(R2 / 'media', STAGE / 'round2/media')
shutil.copytree(R2 / 'components', STAGE / 'round2/components')
# round 3 (minimal)
R3 = ROOT / 'round3-minimal'
(STAGE / 'round3-minimal').mkdir()
r3h = (R3 / 'index.html').read_text().replace('href="../index.html"', 'href="../round1/index.html"')
r3h = r3h.replace('<button class="g-btn" id="g-replay"', '<a class="g-btn" href="../index.html" style="text-decoration:none;display:inline-flex;align-items:center">&larr; All rounds</a>\n    <button class="g-btn" id="g-replay"', 1)
assert 'All rounds' in r3h and '../round1/index.html' in r3h
(STAGE / 'round3-minimal/index.html').write_text(r3h)
shutil.copy(R3 / 'SUITE.md', STAGE / 'round3-minimal/SUITE.md')
for d in ('media', 'components', 'compare'): shutil.copytree(R3 / d, STAGE / 'round3-minimal' / d)
# launcher
import sys, importlib.util
def load(p):
    spec = importlib.util.spec_from_file_location(p.stem + str(abs(hash(str(p)))), p); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
c2 = load(R2 / 'tools/cards.py'); c3 = load(R3 / 'tools/cards.py')
items2 = "<li>Brand loop: two ribbons</li>" + ''.join(f'<li>{html.escape(c["name"])}</li>' for c in c2.CARDS)
items3 = ''.join(f'<li>{html.escape(c["name"].split(" (")[0].replace(" · Tabs · Focus", " · Tabs"))}</li>' for c in c3.CARDS)
MARK = '<svg width="30" height="30" viewBox="100 100 824 824" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9d8fff"/><stop offset="1" stop-color="#7c6af7"/></linearGradient></defs><rect x="100" y="100" width="824" height="824" rx="185" fill="#2b261f"/><path d="M316 300 V540 A196 196 0 0 0 708 540 V300" fill="none" stroke="url(#g)" stroke-width="84" stroke-linecap="round"/><path d="M426 300 V540 A86 86 0 0 0 598 540 V300" fill="none" stroke="#f3eee6" stroke-width="64" stroke-linecap="round"/></svg>'
L = f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ensemble motion review</title><style>{fonts}
:root{{--bg:#141210;--card:#1c1916;--line:rgba(243,238,230,.1);--ink:#f3eee6;--mut:#b7ae9f;--v:#7c6af7;--v2:#b4a9ff}}
*{{box-sizing:border-box}}body{{margin:0;background:radial-gradient(1200px 600px at 50% -10%,rgba(124,106,247,.16),transparent 60%),var(--bg);color:var(--ink);font:15px/1.5 Figtree,system-ui,sans-serif;-webkit-font-smoothing:antialiased}}
main{{max-width:1280px;margin:0 auto;padding:60px 28px 80px}}
.brand{{display:flex;gap:12px;align-items:center;font-weight:600;letter-spacing:-.01em}}
h1{{font:500 50px/1.05 Fraunces,Georgia,serif;letter-spacing:-.025em;margin:26px 0 12px}}h1 em{{color:var(--v2)}}
.lede{{color:var(--mut);max-width:720px;margin:0 0 36px;font-size:16.5px}}
.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}}@media(max-width:1000px){{.grid{{grid-template-columns:1fr}}h1{{font-size:38px}}}}
.card{{background:var(--card);border:1px solid var(--line);border-radius:22px;overflow:hidden;display:flex;flex-direction:column;transition:transform .5s cubic-bezier(.2,1.4,.4,1),border-color .3s}}
.card:hover{{transform:translateY(-4px);border-color:rgba(157,143,255,.45)}}
.card.min:hover{{transform:translateY(-2px);transition:transform .6s cubic-bezier(.33,0,.2,1),border-color .4s}}
.card>a.hero{{display:block;aspect-ratio:16/8.4;background:#0f0d0c center/cover no-repeat;border-bottom:1px solid var(--line)}}
.body{{padding:18px 20px 20px;display:flex;flex-direction:column;gap:10px;flex:1}}
.k{{font:500 11px/1.3 "JetBrains Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--v2)}}
h2{{font:500 25px/1.1 Fraunces,Georgia,serif;margin:0;letter-spacing:-.015em}}p{{margin:0;color:var(--mut);font-size:14.5px}}
.row{{display:flex;flex-wrap:wrap;gap:8px;margin-top:auto;padding-top:8px}}
.btn{{font:500 13px/1 Figtree,sans-serif;color:var(--ink);text-decoration:none;border:1px solid var(--line);padding:10px 13px;border-radius:999px;background:rgba(243,238,230,.03)}}
.btn.p{{background:var(--v);border-color:var(--v);color:#fff}}.btn:hover{{border-color:var(--v2)}}
ul{{columns:2;column-gap:14px;margin:2px 0 0;padding-left:16px;color:var(--ink);font-size:12.8px;line-height:1.55}}li{{break-inside:avoid}}
footer{{margin-top:44px;color:var(--mut);font-size:13px;border-top:1px solid var(--line);padding-top:20px}}code{{font:12.5px "JetBrains Mono",monospace;color:var(--v2)}}
</style></head><body><main>
<div class="brand">{MARK}Ensemble motion review</div>
<h1>Two voices, <em>moving in sync.</em></h1>
<p class="lede">The motion system for Ensemble, in three rounds. Everything here works offline. Open a round, press <b>Replay</b> on any card, and use the light/dark toggles. Round 3 adds a <b>Minimal</b> style that users can choose instead of the Expressive one. Its gallery opens with a switcher that shows the same moment in each style, side by side.</p>
<div class="grid">
<section class="card"><a class="hero" href="round1/index.html" style="background-image:url(round1/media/screenshot-overview.png)" aria-label="Open round 1"></a><div class="body">
<span class="k">Round 1 · Expressive · foundation</span><h2>The motion system</h2>
<p>The Ensemble Glyph, the agent status line, streaming, tool stitches, the loom, skeletons, sync, errors and tokens: the core states of the agent at work.</p>
<div class="row"><a class="btn p" href="round1/index.html">Open round 1</a><a class="btn" href="round1/media/ensemble-animations-tour.mp4">Tour video</a><a class="btn" href="round1/PLAN.md">Plan</a></div></div></section>
<section class="card"><a class="hero" href="round2/index.html" style="background-image:url(round2/media/still-1-brand-loop.png)" aria-label="Open round 2"></a><div class="body">
<span class="k">Round 2 · Expressive · {len(c2.CARDS)+1} pieces</span><h2>Moments &amp; micro-interactions</h2>
<ul>{items2}</ul>
<div class="row"><a class="btn p" href="round2/index.html">Open round 2</a><a class="btn" href="round2/media/ensemble-motion-round2-tour.mp4">Tour video</a><a class="btn" href="round2/PLAN-round2.md">Plan addendum</a></div></div></section>
<section class="card min"><a class="hero" href="round3-minimal/index.html" style="background-image:url(round3-minimal/media/thumb-splash.png)" aria-label="Open round 3"></a><div class="body">
<span class="k">Round 3 · Minimal · {len(c3.CARDS)} slots × 2 flavours</span><h2>Minimal: Quiet &amp; Dot</h2>
<ul>{items3}</ul>
<div class="row"><a class="btn p" href="round3-minimal/index.html">Open round 3</a><a class="btn" href="round3-minimal/media/ensemble-motion-round3-minimal-tour.mp4">Tour video</a><a class="btn" href="round3-minimal/SUITE.md">Suite architecture</a></div></div></section>
</div>
<footer>Tip: add <code>?light</code> or <code>?reduced</code> to a round 2 or round 3 address to preview light mode or reduced motion. Standalone components are in <code>round*/components/</code>. Native-ready exports (springs.json, motion-themes.json, keyframe JSON, tray SVGs) are in <code>round2/components/</code> and <code>round3-minimal/components/</code>.</footer>
</main></body></html>'''
(STAGE / 'index.html').write_text(L)
(STAGE / 'README.txt').write_text('Ensemble motion review\n\nUnzip, then double-click index.html. Everything works offline in Chrome, Safari, Edge or Firefox.\n- round1/index.html : motion system (round 1)\n- round2/index.html : 17 new animations (round 2)\n- round3-minimal/index.html : Minimal style (Quiet + Dot) and the suite switcher (round 3)\n- */media : tour videos and stills\n- */PLAN*.md : notes and specs\n')
if OUT.exists(): OUT.unlink()
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in sorted(STAGE.rglob('*')):
        if f.is_file() and '__pycache__' not in f.parts: z.write(f, f.relative_to(STAGE.parent))
print(OUT, OUT.stat().st_size // 1024, 'KB')
