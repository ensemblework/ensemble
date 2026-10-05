"""Exports: 1024 PNGs for every concept (macOS grid + full-bleed), and a full
size ladder + .ico + .icns + symbolic SVG for the recommended concept (B)."""
import io, pathlib, cairosvg
from PIL import Image
ROOT = pathlib.Path(__file__).resolve().parent.parent
SVG, PNG = ROOT / "app-icon" / "svg", ROOT / "app-icon" / "png"
def png(src, px):
    return Image.open(io.BytesIO(cairosvg.svg2png(url=str(src), output_width=px, output_height=px))).convert("RGBA")
for f in sorted(SVG.glob("ensemble-[abc]-*.svg")):
    if "symbolic" in f.name: continue
    png(f, 1024).save(PNG / f"{f.stem}-1024.png")
# recommended: B
rec = "ensemble-b-two-voices"
(SVG / f"{rec}-symbolic.svg").write_text('''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="208 208 608 608" fill="none" stroke="currentColor" stroke-linecap="round">
  <title>Ensemble symbolic mark (menu bar / tray / monochrome)</title>
  <path d="M316 300 V540 A196 196 0 0 0 708 540 V300" stroke-width="84"/>
  <path d="M426 300 V540 A86 86 0 0 0 598 540 V300" stroke-width="64"/>
</svg>
''')
ladder = ROOT / "app-icon" / "png" / "recommended"
ladder.mkdir(exist_ok=True)
sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
for px in sizes:
    png(SVG / f"{rec}-fullbleed.svg", px).save(ladder / f"ensemble-fullbleed-{px}.png")
    png(SVG / f"{rec}.svg", px).save(ladder / f"ensemble-macos-{px}.png")
# Windows .ico (full-bleed, each size rendered natively), macOS .icns (grid master)
ico_imgs = [png(SVG / f"{rec}-fullbleed.svg", s) for s in (16, 24, 32, 48, 64, 128, 256)]
ico_imgs[-1].save(ladder / "ensemble.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)], append_images=ico_imgs[:-1])
png(SVG / f"{rec}.svg", 1024).save(ladder / "ensemble.icns")
print("done")
