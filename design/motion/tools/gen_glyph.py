"""Generates the Ensemble Glyph keyframes (two strands, N points each) and the
standalone SMIL SVG. Shared by the JS engine (keyframes.json) and the SVG asset."""
import json, math, pathlib
N = 41
OUT = pathlib.Path(__file__).resolve().parent.parent / "components" / "glyph"
C = 24.0  # centre

def resample(pts, n=N):
    # arc-length resample a polyline to n points
    d = [0.0]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        d.append(d[-1] + math.hypot(x1 - x0, y1 - y0))
    L = d[-1]; out = []; j = 0
    for i in range(n):
        s = L * i / (n - 1)
        while j < len(d) - 2 and d[j + 1] < s: j += 1
        seg = d[j + 1] - d[j] or 1
        u = (s - d[j]) / seg
        (x0, y0), (x1, y1) = pts[j], pts[j + 1]
        out.append((x0 + (x1 - x0) * u, y0 + (y1 - y0) * u))
    return out

def u_path(r, top=9.0, cy=26.0, m=400):
    pts = []
    for i in range(m + 1):
        pts.append(None)
    # left side, arc, right side, parameterised by length
    side = cy - top; arc = math.pi * r; L = 2 * side + arc
    res = []
    for i in range(m + 1):
        s = L * i / m
        if s <= side: res.append((C - r, top + s))
        elif s <= side + arc:
            a = math.pi - (s - side) / r       # 180deg -> 0deg through the bottom
            res.append((C + r * math.cos(a), cy + r * math.sin(a)))
        else: res.append((C + r, cy - (s - side - arc)))
    return res

def normals(pts):
    ns = []
    for i in range(len(pts)):
        a = pts[max(0, i - 1)]; b = pts[min(len(pts) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]; L = math.hypot(dx, dy) or 1
        ns.append((-dy / L, dx / L))
    return ns

def braid(sign, amp=3.6, turns=4, phase=0.0):
    base = resample(u_path(8.5), 400)
    ns = normals(base); out = []
    for i, ((x, y), (nx, ny)) in enumerate(zip(base, ns)):
        t = i / (len(base) - 1)
        o = sign * amp * math.cos(math.pi * turns * t + phase)
        out.append((x - nx * o, y - ny * o))  # normal points inward on the left side; minus = outward for +sign
    return resample(out)

def circle(cx, cy, r, start_deg=240, ccw=True, turns=1.0):
    pts = []
    for i in range(400 + 1):
        a = math.radians(start_deg - (360 * turns * i / 400 if ccw else -360 * turns * i / 400))
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return resample(pts)

def star(rout, rin, rot_deg, start_deg=240, p=2.2):
    pts = []
    for i in range(400 + 1):
        a = math.radians(start_deg - 360 * i / 400)
        k = abs(math.cos(2 * (a - math.radians(rot_deg))))
        r = rin + (rout - rin) * k ** p
        pts.append((C + r * math.cos(a), C + r * math.sin(a)))
    return resample(pts)

def line(x0, y0, x1, y1):
    return resample([(x0, y0), (x1, y1)])

def poly(*pts):
    return resample(list(pts))

def slack(side):
    # a frayed, drooping half-strand
    s = 1 if side == "L" else -1
    pts = []
    for i in range(200 + 1):
        t = i / 200
        x = C - s * 12 + s * (6 * t ** 2) + s * 1.5 * math.sin(t * 9) * t
        y = 9 + 27 * t
        pts.append((x, y))
    return resample(pts)

K = {
  "u":      [resample(u_path(12)), resample(u_path(5.2))],
  "braid":  [braid(+1, amp=3.1, turns=5), braid(-1, amp=3.1, turns=5)],
  "rings":  [circle(19.5, 24, 8.5), circle(28.5, 24, 8.5)],
  "spark":  [star(18.5, 1.4, 90, p=4.5), star(11, 1.2, 45, p=4.5)],
  "merge":  [circle(24, 24, 7), circle(24, 24, 7)],
  "pause":  [line(18, 12.5, 18, 35.5), line(30, 12.5, 30, 35.5)],
  "check":  [poly((11.5, 25), (20, 33.5), (36.5, 15)), circle(24, 24, 18)],
  "fray":   [slack("L"), slack("R")],
}
data = {k: [[[round(x, 2), round(y, 2)] for x, y in s] for s in v] for k, v in K.items()}
(OUT / "keyframes.json").write_text(json.dumps(data, separators=(",", ":")))

def path_d(pts):
    # Catmull-Rom -> cubic Bezier (open curve). Same command structure for every keyframe.
    P = pts; d = f"M{P[0][0]:.2f} {P[0][1]:.2f}"
    for i in range(len(P) - 1):
        p0 = P[max(0, i - 1)]; p1 = P[i]; p2 = P[i + 1]; p3 = P[min(len(P) - 1, i + 2)]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f"C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}"
    return d

# Standalone SMIL asset: the working loop  u -> braid -> rings -> spark -> merge -> u
seq = ["u", "braid", "rings", "spark", "merge", "u"]
def values(idx):
    v = []
    for k in seq:
        v += [path_d(K[k][idx])] * 2  # hold pairs
    return ";".join(v[1:-1] + [v[-1]]) if False else ";".join(v)
# keyTimes: for 6 states with hold pairs -> 12 values
DUR = 7.2
kt = []; t = 0.0
hold, move = 0.35 / DUR, (DUR - 0.35 * 6) / 5 / DUR
for i in range(len(seq)):
    kt.append(t); t += hold; kt.append(min(t, 1.0)); t += move
kt[-1] = 1.0
kt = [round(x, 4) for x in kt]
spl = ";".join(["0 0 1 1" if i % 2 == 0 else ".65 0 .35 1" for i in range(len(kt) - 1)])
def anim(idx):
    return (f'<animate attributeName="d" dur="{DUR}s" repeatCount="indefinite" calcMode="spline" '
            f'keyTimes="{";".join(map(str, kt))}" keySplines="{spl}" values="{values(idx)}"/>')
svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" role="img" aria-label="Ensemble is working">
  <title>Ensemble Glyph: working loop (U, braid, rings, spark, merge)</title>
  <style>
    .agent {{ stroke: var(--u-agent, #7c6af7); }}
    .you   {{ stroke: var(--u-you, #f3eee6); }}
  </style>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path class="agent" stroke-width="5" d="{path_d(K['u'][0])}">{anim(0)}</path>
    <path class="you" stroke-width="3.8" d="{path_d(K['u'][1])}">{anim(1)}</path>
    <animateTransform attributeName="transform" type="rotate" dur="{DUR}s" repeatCount="indefinite"
      keyTimes="0;{kt[5]};{kt[8]};{round(kt[8]+0.002,4)};1" values="0 24 24;0 24 24;90 24 24;0 24 24;0 24 24"/>
  </g>
</svg>
'''
(OUT / "ensemble-glyph.svg").write_text(svg)
static = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48" role="img" aria-label="Ensemble">
  <title>Ensemble Glyph: static (reduced motion)</title>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path stroke="var(--u-agent, #7c6af7)" stroke-width="5" d="{path_d(K['u'][0])}"/>
    <path stroke="var(--u-you, #f3eee6)" stroke-width="3.8" d="{path_d(K['u'][1])}"/>
  </g>
</svg>
'''
(OUT / "ensemble-glyph-static.svg").write_text(static)
print("ok", len(json.dumps(data)))
