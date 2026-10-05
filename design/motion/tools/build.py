"""Assembles the self-contained demo: components + demo chrome -> index.html."""
import pathlib, re, json
R = pathlib.Path(__file__).resolve().parent.parent
C = R / "components"
css = [C / "tokens.css"] + sorted(p for p in C.glob("*/*.css")) + [R / "demo" / "demo.css"]
js = [C / "glyph/keyframes.js", C / "glyph/ensemble-glyph.js", C / "status-line/status-line.js", C / "stream/stream.js",
      C / "thread-progress/thread-progress.js", C / "terminal-glyph/terminal-glyph.js", R / "demo/demo.js"]
body = (R / "demo/body.html").read_text()
body = re.sub(r"\{\{SVG:([^}]+)\}\}", lambda m: (C / m.group(1)).read_text(), body)
glob_js = "window.ENSEMBLE_GLYPH_SMIL=%s;window.ENSEMBLE_SPLASH_SVG=%s;window.ENSEMBLE_GRAPH_SVG=%s;" % (
    json.dumps((C / "glyph/ensemble-glyph.svg").read_text()), json.dumps((C / "splash/splash.svg").read_text()),
    json.dumps((C / "skeleton/graph-skeleton.svg").read_text()))
html = f"""<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ensemble · motion system</title>
<style>
{chr(10).join(f"/* ── {p.relative_to(R)} ── */" + chr(10) + p.read_text() for p in css)}
</style>
</head>
<body>
{body}
<script>{glob_js}</script>
{chr(10).join(f"<script>/* {p.relative_to(R)} */" + chr(10) + p.read_text() + "</script>" for p in js)}
</body>
</html>
"""
(R / "index.html").write_text(html)
print("index.html", len(html) // 1024, "KB")
