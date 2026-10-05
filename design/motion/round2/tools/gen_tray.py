"""Menu-bar / tray icon: one markup builder -> gallery snippet (tray.html) + standalone animated SVGs (svg/*.svg)."""
import pathlib
R = pathlib.Path(__file__).resolve().parent.parent / "components/tray"
CSS = (R / "tray-icon.css").read_text()
O = "M6.5 4.5v7.5a5.5 5.5 0 0 0 11 0V4.5"
I = "M10 4.5v7.5a2 2 0 0 0 4 0V4.5"
STATES = [("idle", "Idle"), ("working", "Working"), ("syncing", "Syncing"), ("needs", "Needs you"), ("listening", "Listening"),
          ("paused", "Paused"), ("done", "Done"), ("error", "Error"), ("offline", "Offline")]
def icon(state, variant="color", size=22, light=False, cls=""):
    extra = " on-light" if light else ""
    return (f'<svg class="ut {variant} {state}{extra} {cls}" width="{size}" height="{size}" viewBox="0 0 24 24" aria-hidden="true">'
            f'<path class="o" d="{O}"/><path class="i" d="{I}"/>'
            f'<circle class="bead" r="1.7" fill="{"currentColor" if variant == "mono" else "#ffffff"}"><animateMotion dur="1.4s" repeatCount="indefinite" path="{O}" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines=".45 0 .55 1"/></circle>'
            f'<circle class="ping" cx="20.2" cy="4.2" r="2.6"/><circle class="badge" cx="20.2" cy="4.2" r="2.8"/>'
            f'<g class="tick"><circle cx="19.6" cy="4.6" r="3.6"/><path d="M17.9 4.7l1.2 1.1 2.2-2.4"/></g></svg>')
cells = []
for st, name in STATES:
    cells.append(f'''<div class="tr-cell"><div class="tr-name">{name}</div><div class="tr-row">
      <span class="tr-chip dk">{icon(st, "color", 22)}</span><span class="tr-chip dk mono-w">{icon(st, "mono", 22)}</span>
      <span class="tr-chip lt">{icon(st, "mono", 22, True)}</span><span class="tr-chip dk sm">{icon(st, "color", 16)}</span></div></div>''')
bar = lambda cls, variant, light: f'''<div class="tr-bar {cls}"><b>Ensemble</b><span>File</span><span>View</span><span class="tr-sp"></span>
  <span class="tr-live">{icon("working", variant, 18, light, "tr-cyc")}</span><span class="tr-state">Working</span>
  <svg class="tr-sys" viewBox="0 0 24 24" width="16" height="16"><path d="M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="19.5" r="1.3" fill="currentColor"/></svg>
  <svg class="tr-sys" viewBox="0 0 28 14" width="24" height="12"><rect x="1" y="1" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" stroke-opacity=".5" stroke-width="1.2"/><rect x="3" y="3" width="16" height="8" rx="2" fill="currentColor"/><rect x="25.2" y="4.5" width="1.8" height="5" rx="1" fill="currentColor" fill-opacity=".5"/></svg>
  <span class="tr-clock">Wed 30 Sep 15:42</span></div>'''
html = f'''<div class="tr">
  {bar("dk", "mono", False)}
  {bar("lt", "mono", True)}
  <div class="tr-grid">{"".join(cells)}</div>
  <div class="tr-key"><span>colour · dark bar</span><span>template · dark</span><span>template · light</span><span>16 px</span></div>
</div>'''
(R / "tray.html").write_text(html)
for st, _ in STATES:
    for variant in ("color", "mono"):
        body = icon(st, variant, 22).replace('<svg class="ut', f'<svg xmlns="http://www.w3.org/2000/svg" class="ut', 1)
        body = body.replace('aria-hidden="true">', f'aria-hidden="true"><style>{CSS}</style>', 1)
        if variant == "mono": body = body.replace('<svg ', '<svg color="#000000" ', 1)
        (R / "svg" / f"ensemble-tray-{st}{'' if variant == 'color' else '-template'}.svg").write_text(body)
print("tray:", len(STATES), "states")
