"""Comparison sheet: each concept large (400px), plus 128/64/32/16 previews,
on the app's dark (#141210) and light (#f4f1ea) surfaces."""
import io, pathlib, cairosvg
from PIL import Image, ImageDraw, ImageFont
ROOT = pathlib.Path(__file__).resolve().parent.parent
SVG = ROOT / "app-icon" / "svg"
FONT = "/usr/share/fonts/truetype/sand-box/google/Figtree/Figtree-VariableFont_wght.ttf"
def font(sz, w=600):
    f = ImageFont.truetype(FONT, sz)
    try: f.set_variation_by_axes([w])
    except Exception: pass
    return f
def render(path, px):
    # render at the exact target size (what an OS would do from a sized asset)
    return Image.open(io.BytesIO(cairosvg.svg2png(url=str(path), output_width=px, output_height=px))).convert("RGBA")

CONCEPTS = [
    ("ensemble-a-thread", "A · Thread", "You + agent joined by one thread (evolves the in-app Mark)"),
    ("ensemble-b-two-voices", "B · Two voices", "Two parallel strands form the mark: two parts, one line"),
    ("ensemble-c-shared-board", "C · Shared board", "Task board; your card and the agent's card threaded"),
]
import sys
rec = sys.argv[1] if len(sys.argv) > 1 else None
COLW, PAD, BIG = 520, 60, 400
W = PAD * 2 + COLW * 3
H = 1120
sheet = Image.new("RGBA", (W, H), "#141210")
d = ImageDraw.Draw(sheet)
d.text((PAD, 40), "Ensemble · app icon concepts", font=font(40, 700), fill="#f3eee6")
d.text((PAD, 92), "Large: macOS-grid master (400px). Small: full-bleed tile at 128 / 64 / 32 / 16 px, 1:1 pixels, on the app's dark and light surfaces", font=font(20, 450), fill="#b7ae9f")
# light strip background
LIGHT_Y = 880
d.rectangle([0, LIGHT_Y - 20, W, H], fill="#f4f1ea")
for i, (slug, title, blurb) in enumerate(CONCEPTS):
    x0 = PAD + i * COLW
    big = render(SVG / f"{slug}.svg", BIG)
    sheet.alpha_composite(big, (x0 + (COLW - BIG) // 2 - 20, 150))
    tx = x0 + 20
    t = title + ("  · recommended" if rec == slug else "")
    d.text((tx, 560), t, font=font(28, 700), fill="#9d8fff" if rec == slug else "#f3eee6")
    d.text((tx, 600), blurb, font=font(17, 450), fill="#b7ae9f")
    for yy, bgc in [(660, None), (LIGHT_Y, None)]:
        x = tx
        for px in (128, 64, 32, 16):
            im = render(SVG / f"{slug}-fullbleed.svg", px)
            sheet.alpha_composite(im, (x, yy + (128 - px) // 2 + 20))
            d.text((x + px // 2 - 12, yy + 154), f"{px}", font=font(15, 500), fill="#8f877b" if yy == 660 else "#625b51")
            x += px + 36
sheet.convert("RGB").save(ROOT / "sheets" / "app-icon-comparison.png")
print("ok", W, H)
