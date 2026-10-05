"""Contact sheets for the UI icon set: light + dark, grouped and labelled.
Each cell: icon at 48px (2x) plus 1:1 previews at 24px and 16px."""
import io, pathlib, sys, cairosvg
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from ui_icons import GROUPS, OUT as SVGDIR
ROOT = SVGDIR.parent.parent
FONT = "/usr/share/fonts/truetype/sand-box/google/Figtree/Figtree-VariableFont_wght.ttf"
MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
def font(sz, w=500, path=FONT):
    ft = ImageFont.truetype(path, sz)
    try: ft.set_variation_by_axes([w])
    except Exception: pass
    return ft
def icon(name, px, color):
    src = (SVGDIR / f"{name}.svg").read_text().replace("currentColor", color)
    return Image.open(io.BytesIO(cairosvg.svg2png(bytestring=src.encode(), output_width=px, output_height=px))).convert("RGBA")

THEMES = {
  "dark":  dict(bg="#141210", panel="#221e1a", ink="#f3eee6", muted="#b7ae9f", faint="#8f877b", accent="#7c6af7", line="#2e2924"),
  "light": dict(bg="#f4f1ea", panel="#fffcf7", ink="#1c1915", muted="#5a534c", faint="#625b51", accent="#5346d6", line="#e2dccf"),
}
COLS, CW, CH, PAD = 9, 150, 150, 48
def build(theme):
    t = THEMES[theme]
    rows = sum((len(g) + COLS - 1) // COLS for _, g in GROUPS)
    W = PAD * 2 + COLS * CW
    H = 150 + len(GROUPS) * 50 + rows * (CH + 12) + 40
    im = Image.new("RGBA", (W, H), t["bg"]); d = ImageDraw.Draw(im, "RGBA")
    d.text((PAD, 36), f"Ensemble · UI icons · {theme}", font=font(34, 700), fill=t["ink"])
    d.text((PAD, 82), "24×24 grid · 1.75 stroke · round caps & joins · currentColor. Each cell: 48px (2×), then 24px and 16px at 1:1; accent = active nav state.",
           font=font(17, 450), fill=t["muted"])
    y = 140
    for gname, names in GROUPS:
        d.text((PAD, y), gname.upper(), font=font(15, 700), fill=t["faint"]); y += 34
        for i, n in enumerate(names):
            if i and i % COLS == 0: y += CH + 12
            x = PAD + (i % COLS) * CW
            d.rounded_rectangle([x + 4, y, x + CW - 8, y + CH], radius=14, fill=t["panel"], outline=t["line"])
            color = t["accent"] if gname == "Navigation" and i == 0 else t["ink"]
            big = icon(n, 48, color); im.alpha_composite(big, (x + 18, y + 18))
            im.alpha_composite(icon(n, 24, t["ink"]), (x + 84, y + 30))
            im.alpha_composite(icon(n, 16, t["muted"]), (x + 118, y + 34))
            d.text((x + 18, y + 104), n, font=font(15, 600), fill=t["ink"])
        y += CH + 28
    out = ROOT / "sheets" / f"ui-icons-{theme}.png"
    im.convert("RGB").crop((0, 0, W, y + 10)).save(out); print(out)

def debug():
    """8x keyline view: 24 grid, 2px padding box, circle keyline. For QA only."""
    names = [n for _, g in GROUPS for n in g]
    S, C = 8, 10
    cell = 24 * S + 20
    rows = (len(names) + C - 1) // C
    im = Image.new("RGBA", (C * cell + 20, rows * (cell + 20) + 20), "#ffffff"); d = ImageDraw.Draw(im)
    for k, n in enumerate(names):
        x = 20 + (k % C) * cell; y = 20 + (k // C) * (cell + 20)
        for g in range(25):
            c = (230, 230, 240) if g % 2 else (205, 205, 225)
            d.line([x + g * S, y, x + g * S, y + 24 * S], fill=c); d.line([x, y + g * S, x + 24 * S, y + g * S], fill=c)
        d.rectangle([x + 2 * S, y + 2 * S, x + 22 * S, y + 22 * S], outline=(255, 150, 150))
        d.ellipse([x + 2 * S, y + 2 * S, x + 22 * S, y + 22 * S], outline=(150, 200, 255))
        im.alpha_composite(icon(n, 24 * S, "#1c1915"), (x, y))
        d.text((x, y + 24 * S + 2), n, font=font(14, 600), fill="#333")
    im.convert("RGB").save("/tmp/ui-debug.png")

if __name__ == "__main__":
    if "debug" in sys.argv: debug()
    else:
        for th in THEMES: build(th)
