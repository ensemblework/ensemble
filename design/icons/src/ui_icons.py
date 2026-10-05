"""Ensemble UI icon set. 24x24 grid, 2px live-area padding, 1.75 stroke,
round caps + joins, fill none, currentColor. One SVG per icon."""
import math, pathlib
OUT = pathlib.Path(__file__).resolve().parent.parent / "ui-icons" / "svg"
SW = 1.75

def f(v):  # tidy numbers
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s == "-0" else s

def arc_pt(cx, cy, r, deg):
    a = math.radians(deg)
    return cx + r * math.cos(a), cy + r * math.sin(a)

def dot(cx, cy, r=1.1):
    return f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r)}" fill="currentColor" stroke="none"/>'

def gear():
    # 8 rounded teeth: outer radius 9.25, root radius 7, centre hole r 3
    cx = cy = 12; n = 8; ro, ri = 9.25, 7.1
    pts = []
    for i in range(n):
        base = i * 360 / n
        for off, r in ((-22.5 + 5, ri), (-9.5, ro), (9.5, ro), (22.5 - 5, ri)):
            pts.append(arc_pt(cx, cy, r, base + off - 90))
    d = "M" + " L".join(f"{f(x)} {f(y)}" for x, y in pts) + " Z"
    return f'<path d="{d}"/><circle cx="12" cy="12" r="3"/>'

def sun():
    rays = []
    for i in range(8):
        x1, y1 = arc_pt(12, 12, 6.75, i * 45 - 90)
        x2, y2 = arc_pt(12, 12, 9.25, i * 45 - 90)
        rays.append(f"M{f(x1)} {f(y1)} L{f(x2)} {f(y2)}")
    return f'<circle cx="12" cy="12" r="3.75"/><path d="{" ".join(rays)}"/>'

def refresh():
    # two 150deg arcs on r=8 (clockwise), each ending in an L-shaped arrowhead
    return ('<path d="M4 12 A8 8 0 0 1 18.93 8 M18.93 3.75 V8 H14.68"/>'
            '<path d="M20 12 A8 8 0 0 1 5.07 16 M5.07 20.25 V16 H9.32"/>')

def octagon_x():
    pts = [arc_pt(12, 12, 9.4, 22.5 + i * 45) for i in range(8)]
    d = "M" + " L".join(f"{f(x)} {f(y)}" for x, y in pts) + " Z"
    return f'<path d="{d}"/><path d="M9.25 9.25 L14.75 14.75 M14.75 9.25 L9.25 14.75"/>'

def graph():
    # Engineer Graph: centre node + three satellites, edges trimmed to the rims
    c = (12, 13); rc = 2.5
    sats = [((5.5, 5.5), 2.25), ((18.5, 5.5), 2.25), ((12, 20.25), 1.75)]
    out = [f'<circle cx="{c[0]}" cy="{c[1]}" r="{rc}"/>']
    for (x, y), r in sats:
        out.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="{f(r)}"/>')
        dx, dy = x - c[0], y - c[1]; L = math.hypot(dx, dy); ux, uy = dx / L, dy / L
        gap = 1.4
        out.append(f'<path d="M{f(c[0]+ux*(rc+gap))} {f(c[1]+uy*(rc+gap))} L{f(x-ux*(r+gap))} {f(y-uy*(r+gap))}"/>')
    return "".join(out)

ICONS = {
  # ── navigation (sidebar rail) ────────────────────────────────────────────
  "today":      '<rect x="3.5" y="4.75" width="17" height="16" rx="2.75"/><path d="M3.5 9.75 H20.5 M8 2.75 V6.25 M16 2.75 V6.25"/>' + dot(8.25, 14.5, 1.35),
  "board":      '<rect x="3" y="3.5" width="18" height="17" rx="2.75"/><path d="M9 3.5 V20.5 M15 3.5 V20.5"/>',
  "needs-me":   '<path d="M3 13.5 H7.5 L9 16 H15 L16.5 13.5 H21"/><path d="M5.6 5.2 A2.75 2.75 0 0 1 8.2 3.5 H15.8 A2.75 2.75 0 0 1 18.4 5.2 L21 13.5 V17.75 A2.75 2.75 0 0 1 18.25 20.5 H5.75 A2.75 2.75 0 0 1 3 17.75 V13.5 Z"/><path d="M9.25 8.75 L11.25 10.75 L14.75 7.25"/>',
  "runs":       '<path d="M2.75 12 H6.5 L9 5 L15 19 L17.5 12 H21.25"/>',
  "context":    graph(),
  "skills":     '<path d="M12 6.75 C10 5.1 7.25 4.5 3.5 4.75 V18.5 C7.25 18.25 10 18.85 12 20.25 C14 18.85 16.75 18.25 20.5 18.5 V4.75 C16.75 4.5 14 5.1 12 6.75 Z M12 6.75 V20.25"/>',
  "workspace":  '<rect x="3" y="7" width="18" height="13.5" rx="2.75"/><path d="M8.75 7 V5.25 A1.75 1.75 0 0 1 10.5 3.5 H13.5 A1.75 1.75 0 0 1 15.25 5.25 V7 M3 12.75 H21"/>',
  "code":       '<path d="M8 7 L3 12 L8 17 M16 7 L21 12 L16 17 M13.75 4.5 L10.25 19.5"/>',
  "metrics":    '<path d="M3.5 3.5 V17.75 A2.75 2.75 0 0 0 6.25 20.5 H20.5 M8.5 16 V12 M13 16 V7 M17.5 16 V10"/>',
  "meetings":   '<rect x="3.5" y="4.75" width="17" height="16" rx="2.75"/><path d="M3.5 9.75 H20.5 M8 2.75 V6.25 M16 2.75 V6.25 M9 15 L11 17 L15 13"/>',
  "recap":      '<path d="M3.5 6.25 L5 7.75 L8 4.75 M3.5 12.75 L5 14.25 L8 11.25 M12 6.25 H20.5 M12 12.75 H20.5 M12 19.25 H20.5 M4 19.25 H7.5"/>',
  "completed":  '<path d="M2.75 12.5 L7 16.75 L16.5 7.25 M13.5 15.25 L15 16.75 L21.25 10.5"/>',
  "trash":      '<path d="M3.75 6.5 H20.25 M9.25 6.5 V4.75 A1.25 1.25 0 0 1 10.5 3.5 H13.5 A1.25 1.25 0 0 1 14.75 4.75 V6.5 M5.75 6.5 L6.75 18.6 A2.1 2.1 0 0 0 8.85 20.5 H15.15 A2.1 2.1 0 0 0 17.25 18.6 L18.25 6.5 M10 10.75 V16.25 M14 10.75 V16.25"/>',
  "connect":    '<path d="M9 2.75 V7 M15 2.75 V7 M6.5 7 H17.5 V10.75 A5.5 5.5 0 0 1 6.5 10.75 Z M12 16.25 V21.25"/>',
  "settings":   gear(),
  # ── top bar ─────────────────────────────────────────────────────────────
  "menu":       '<path d="M4 6.5 H20 M4 12 H20 M4 17.5 H20"/>',
  "search":     '<circle cx="10.75" cy="10.75" r="6.75"/><path d="M15.75 15.75 L20.5 20.5"/>',
  "ask":        '<path d="M11 3.5 C11.55 8.3 13.2 9.95 18 10.5 C13.2 11.05 11.55 12.7 11 17.5 C10.45 12.7 8.8 11.05 4 10.5 C8.8 9.95 10.45 8.3 11 3.5 Z M18.5 15.5 V20.5 M16 18 H21"/>',
  "notifications": '<path d="M6 10 A6 6 0 0 1 18 10 V14.25 L19.75 17.25 H4.25 L6 14.25 Z M9.75 20.25 A2.4 2.4 0 0 0 14.25 20.25"/>',
  "undo":       '<path d="M8.5 14 L4 9.5 L8.5 5 M4 9.5 H14.25 A5.5 5.5 0 0 1 14.25 20.5 H11"/>',
  "redo":       '<path d="M15.5 14 L20 9.5 L15.5 5 M20 9.5 H9.75 A5.5 5.5 0 0 0 9.75 20.5 H13"/>',
  "fetch":      refresh(),
  "peek-panel": '<rect x="3" y="4" width="18" height="16" rx="2.75"/><path d="M14.5 4 V20"/>',
  "theme-light": sun(),
  "theme-dark": '<path d="M20.25 14.4 A8.5 8.5 0 1 1 9.6 3.75 A6.75 6.75 0 0 0 20.25 14.4 Z"/>',
  # ── agent & ownership ───────────────────────────────────────────────────
  "agent":      '<rect x="4" y="8" width="16" height="12" rx="3.25"/><path d="M12 8 V5 M2.25 12.75 V15.25 M21.75 12.75 V15.25"/>' + dot(12, 3.75, 1.25) + dot(9, 13.75, 1.3) + dot(15, 13.75, 1.3),
  "you":        '<circle cx="12" cy="8" r="4.25"/><path d="M4.5 20.5 A7.5 7.5 0 0 1 19.5 20.5"/>',
  "pause":      '<rect x="6.25" y="5" width="3.25" height="14" rx="1.1"/><rect x="14.5" y="5" width="3.25" height="14" rx="1.1"/>',
  "resume":     '<path d="M7.5 5.2 A1 1 0 0 1 9 4.35 L19.1 11.15 A1 1 0 0 1 19.1 12.85 L9 19.65 A1 1 0 0 1 7.5 18.8 Z"/>',
  "stop":       '<rect x="5.5" y="5.5" width="13" height="13" rx="2.25"/>',
  "stop-all":   octagon_x(),
  # ── common actions ──────────────────────────────────────────────────────
  "add":        '<path d="M12 5 V19 M5 12 H19"/>',
  "close":      '<path d="M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5"/>',
  "approve":    '<path d="M4.75 12.5 L9.5 17.25 L19.25 7.5"/>',
  "chevron-right": '<path d="M9.5 6 L15.5 12 L9.5 18"/>',
  "open-external": '<path d="M14 3.75 H20.25 V10 M20.25 3.75 L11.5 12.5 M18 13.75 V17.75 A2.75 2.75 0 0 1 15.25 20.5 H6.25 A2.75 2.75 0 0 1 3.5 17.75 V8.75 A2.75 2.75 0 0 1 6.25 6 H10.25"/>',
  "copy":       '<rect x="8.5" y="8.5" width="12" height="12" rx="2.75"/><path d="M15.5 8.5 V6.25 A2.75 2.75 0 0 0 12.75 3.5 H6.25 A2.75 2.75 0 0 0 3.5 6.25 V12.75 A2.75 2.75 0 0 0 6.25 15.5 H8.5"/>',
  "terminal":   '<rect x="3" y="4" width="18" height="16" rx="2.75"/><path d="M7.25 9.25 L10 12 L7.25 14.75 M12.5 15 H16.75"/>',
  "branch":     '<circle cx="6.5" cy="5.5" r="2.25"/><circle cx="6.5" cy="18.5" r="2.25"/><circle cx="17.5" cy="6.5" r="2.25"/><path d="M6.5 7.75 V16.25 M17.5 8.75 C17.5 13.25 6.5 11.5 6.5 16.25"/>',
  "drag":       dot(9, 6, 1.35) + dot(15, 6, 1.35) + dot(9, 12, 1.35) + dot(15, 12, 1.35) + dot(9, 18, 1.35) + dot(15, 18, 1.35),
  # ── brand ───────────────────────────────────────────────────────────────
  # Filled Two-voices mark. Written verbatim so a rebuild cannot restore the dot–curve mark.
  "ensemble":     "",
}

ENSEMBLE_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">'
    "<title>ensemble</title>"
    '<path d="M3 2H6V13A6 6 0 0 0 18 13V2H21V13A9 9 0 0 1 3 13Z"/>'
    '<path d="M7 2H10V13A2 2 0 0 0 14 13V2H17V13A5 5 0 0 1 7 13Z"/>'
    "</svg>\n"
)

GROUPS = [
  ("Navigation", ["today","board","needs-me","runs","context","skills","workspace","code","metrics","meetings","recap","completed","trash","connect","settings"]),
  ("Top bar", ["menu","search","ask","notifications","undo","redo","fetch","peek-panel","theme-light","theme-dark"]),
  ("Agent & ownership", ["agent","you","pause","resume","stop","stop-all"]),
  ("Actions", ["add","close","approve","chevron-right","open-external","copy","terminal","branch","drag"]),
  ("Brand", ["ensemble"]),
]

def svg(name, body):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" '
            f'fill="none" stroke="currentColor" stroke-width="{SW}" stroke-linecap="round" stroke-linejoin="round">'
            f'<title>{name}</title>{body}</svg>\n')

if __name__ == "__main__":
    assert sorted(ICONS) == sorted(n for _, g in GROUPS for n in g)
    for old in OUT.glob("*.svg"): old.unlink()
    for name, body in ICONS.items():
        (OUT / f"{name}.svg").write_text(ENSEMBLE_SVG if name == "ensemble" else svg(name, body))
    print(len(ICONS), "icons")
