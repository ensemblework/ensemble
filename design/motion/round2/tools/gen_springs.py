"""Physical springs -> CSS linear() easings + JSON for native (SwiftUI / Reanimated / Compose).
Each spring: mass 1, stiffness k, damping c; animates 0 -> 1 from rest."""
import json, math, pathlib
R = pathlib.Path(__file__).resolve().parent.parent
SPRINGS = {
    # name: (stiffness, damping, note)
    "gentle": (120, 20, "settles softly, barely overshoots; entrances, cards unfolding"),
    "soft":   (170, 18, "one small overshoot; lifts, tabs, knobs"),
    "bouncy": (260, 14, "playful double bounce; celebrations, badges, beads landing"),
    "snappy": (420, 30, "fast and firm; presses, toggles, micro-interactions"),
    "pluck":  (300, 7,  "string being plucked; threads that wobble then settle"),
}
def solve(k, c, m=1.0, dt=1/600):
    x, v, t, out = 0.0, 0.0, 0.0, []
    still = 0
    while t < 4:
        a = (-k * (x - 1) - c * v) / m
        v += a * dt; x += v * dt; t += dt
        out.append((t, x))
        still = still + 1 if abs(x - 1) < 0.001 and abs(v) < 0.01 else 0
        if still > 30: break
    return out
css, meta = [":root {"], {}
for name, (k, c, note) in SPRINGS.items():
    s = solve(k, c)
    T = s[-1][0]
    n = max(48, int(T * 45))
    pts = []
    for i in range(n + 1):
        tt = T * i / n
        j = min(range(len(s)), key=lambda q: abs(s[q][0] - tt)) if i else 0
        pts.append(0 if i == 0 else round(s[j][1], 4))
    pts[-1] = 1
    css.append(f"  /* {name}: k={k} c={c} ≈ {round(T*1000)}ms; {note} */")
    css.append(f"  --spring-{name}: linear({', '.join(str(p) for p in pts)});")
    css.append(f"  --spring-{name}-dur: {round(T*1000)}ms;")
    zeta = c / (2 * math.sqrt(k))
    meta[name] = {"stiffness": k, "damping": c, "mass": 1, "durationMs": round(T * 1000),
                  "dampingRatio": round(zeta, 3), "swiftUI": f".spring(response: {round(2*math.pi/math.sqrt(k),3)}, dampingFraction: {round(zeta,3)})",
                  "reanimated": {"stiffness": k, "damping": c, "mass": 1}, "note": note}
css.append("}")
css.append("/* Browsers without linear(): fall back to close cubic-beziers. */")
css.append("@supports not (transition-timing-function: linear(0, 1)) { :root {")
css.append("  --spring-gentle: cubic-bezier(.22,1,.36,1); --spring-soft: cubic-bezier(.34,1.3,.64,1); --spring-bouncy: cubic-bezier(.34,1.6,.64,1);")
css.append("  --spring-snappy: cubic-bezier(.2,1.2,.4,1); --spring-pluck: cubic-bezier(.34,1.8,.64,1); } }")
(R / "components/core").mkdir(parents=True, exist_ok=True)
(R / "components/core/springs.css").write_text("\n".join(css) + "\n")
(R / "components/core/springs.json").write_text(json.dumps(meta, indent=2))
print({k: v["durationMs"] for k, v in meta.items()})
