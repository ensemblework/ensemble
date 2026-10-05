"""Writes the three Ensemble app-icon concepts as plain SVG files.
Canvas 1024x1024, macOS Big Sur grid: 824x824 tile inset 100px, radius 185."""
import math, pathlib, re
OUT = pathlib.Path(__file__).resolve().parent.parent / "app-icon" / "svg"

# Ensemble palette (from apps/hub-web/app/globals.css)
BG, SIDEBAR, PANEL, RAISED = "#141210", "#1b1815", "#221e1a", "#2b261f"
INK, MUTED = "#f3eee6", "#b7ae9f"
ACCENT, ACCENT_HI, ACCENT_LIGHT = "#7c6af7", "#917ff8", "#5346d6"
KIND = dict(people="#e7a08a", project="#7eb8c9", repo="#8fbf9f", task="#e0b15a", skill="#d4c07a", deliverable="#c9a4e0")

def tile_defs(uid):
    return f'''  <defs>
    <linearGradient id="{uid}-bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="{RAISED}"/>
      <stop offset="1" stop-color="{BG}"/>
    </linearGradient>
    <radialGradient id="{uid}-wash" cx="0.18" cy="0.05" r="0.9">
      <stop offset="0" stop-color="{ACCENT}" stop-opacity="0.34"/>
      <stop offset="0.6" stop-color="{ACCENT}" stop-opacity="0.04"/>
      <stop offset="1" stop-color="{ACCENT}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="{uid}-rim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.03"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.06"/>
    </linearGradient>
    <filter id="{uid}-shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.32"/>
    </filter>
  </defs>'''

def tile(uid):
    return f'''  <g filter="url(#{uid}-shadow)">
    <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#{uid}-bg)"/>
  </g>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#{uid}-wash)"/>
  <rect x="101.5" y="101.5" width="821" height="821" rx="183.5" fill="none" stroke="url(#{uid}-rim)" stroke-width="3"/>'''

def doc(uid, title, desc, extra_defs, body):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <title>{title}</title>
  <desc>{desc}</desc>
{tile_defs(uid)}
  <defs>
{extra_defs}
  </defs>
{tile(uid)}
{body}
</svg>
'''

# ── A · Thread ─────────────────────────────────────────────────────────────
# The in-app Mark (components/mark.tsx) blown up: two accent nodes (you, the agent)
# joined by one continuous thread through a shared midpoint (the workspace).
def concept_a():
    x1, y1, xm, ym, x2, y2 = 262, 672, 512, 512, 762, 352
    d = f"M{x1} {y1} C{x1+170} {y1} {xm-120} {ym} {xm} {ym} C{xm+120} {ym} {x2-170} {y2} {x2} {y2}"
    defs = f'''    <linearGradient id="a-thread" gradientUnits="userSpaceOnUse" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">
      <stop offset="0" stop-color="{ACCENT}"/>
      <stop offset="1" stop-color="#b4a9ff"/>
    </linearGradient>
    <radialGradient id="a-glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="{ACCENT}" stop-opacity="0.30"/>
      <stop offset="1" stop-color="{ACCENT}" stop-opacity="0"/>
    </radialGradient>'''
    body = f'''  <circle cx="{xm}" cy="{ym}" r="260" fill="url(#a-glow)"/>
  <path d="{d}" fill="none" stroke="url(#a-thread)" stroke-width="64" stroke-linecap="round"/>
  <circle cx="{x1}" cy="{y1}" r="74" fill="{ACCENT}"/>
  <circle cx="{x2}" cy="{y2}" r="74" fill="#b4a9ff"/>
  <circle cx="{xm}" cy="{ym}" r="62" fill="{BG}"/>
  <circle cx="{xm}" cy="{ym}" r="46" fill="{INK}"/>'''
    return doc("a", "Ensemble app icon: concept A, Thread",
               "Two accent nodes (you and your agent) joined by one thread through a shared point. Evolves the existing in-app Mark.",
               defs, body)

# ── B · Two voices (monogram) ────────────────────────────────────────────
# Two parallel strands that move together and form the mark: two parts, one line.
def concept_b():
    cx, top = 512, 300
    def u(r, bottom_y):
        return f"M{cx - r} {top} V{bottom_y - r} A{r} {r} 0 0 0 {cx + r} {bottom_y - r} V{top}"
    outer = u(196, 736)
    inner = u(86, 626)
    defs = f'''    <linearGradient id="b-outer" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9d8fff"/>
      <stop offset="1" stop-color="{ACCENT}"/>
    </linearGradient>'''
    body = f'''  <path d="{outer}" fill="none" stroke="url(#b-outer)" stroke-width="84" stroke-linecap="round"/>
  <path d="{inner}" fill="none" stroke="{INK}" stroke-width="64" stroke-linecap="round"/>'''
    return doc("b", "Ensemble app icon: concept B, Two voices",
               "A monogram made of two parallel strands, violet (the agent) and paper (you), moving as one.",
               defs, body)

# ── C · Shared board ───────────────────────────────────────────────────────
# The workspace itself: a three-column board where one card is yours (paper),
# one is the agent's (violet), and a thread links them across columns.
def concept_c():
    cols = [(236, 168), (428, 168), (620, 168)]  # x, width
    top, bottom = 250, 774
    defs = f'''    <linearGradient id="c-col" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.07"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0.025"/>
    </linearGradient>'''
    parts = []
    for x, w in cols:
        parts.append(f'  <rect x="{x}" y="{top}" width="{w}" height="{bottom - top}" rx="44" fill="url(#c-col)"/>')
    # cards
    parts.append(f'  <rect x="260" y="282" width="120" height="96" rx="26" fill="{INK}" fill-opacity="0.22"/>')
    parts.append(f'  <rect x="260" y="398" width="120" height="150" rx="26" fill="{INK}"/>')
    parts.append(f'  <rect x="452" y="282" width="120" height="120" rx="26" fill="{INK}" fill-opacity="0.22"/>')
    parts.append(f'  <rect x="644" y="282" width="120" height="176" rx="26" fill="{ACCENT}"/>')
    parts.append(f'  <rect x="644" y="478" width="120" height="96" rx="26" fill="{INK}" fill-opacity="0.22"/>')
    # thread from your card to agent card
    parts.append(f'  <path d="M320 548 C320 650 512 640 512 560 C512 470 704 520 704 458" fill="none" stroke="#b4a9ff" stroke-width="26" stroke-linecap="round"/>')
    parts.append(f'  <circle cx="512" cy="566" r="26" fill="{INK}"/>')
    return doc("c", "Ensemble app icon: concept C, Shared board",
               "A three-column task board: your card (paper) and the agent's card (violet) joined by one thread.",
               defs, "\n".join(parts))

for name, fn in [("ensemble-a-thread", concept_a), ("ensemble-b-two-voices", concept_b), ("ensemble-c-shared-board", concept_c)]:
    svg = fn()
    (OUT / f"{name}.svg").write_text(svg)
    flat = svg.replace('width="1024" height="1024" viewBox="0 0 1024 1024"', 'width="1024" height="1024" viewBox="100 100 824 824"')
    flat = re.sub(r'  <g filter="url\(#\w+-shadow\)">\n(.*?)\n  </g>', r'\1', flat, flags=re.S)
    (OUT / f"{name}-fullbleed.svg").write_text(flat)
    print("wrote", name)
