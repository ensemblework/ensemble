# python3 grid.py out.png cols w file...   (tiles images scaled to width w)
import sys
from PIL import Image
out, cols, w, files = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4:]
ims = [Image.open(f).convert('RGB') for f in files]
ims = [i.resize((w, int(i.height * w / i.width))) for i in ims]
rows = [ims[i:i + cols] for i in range(0, len(ims), cols)]
H = sum(max(i.height for i in r) for r in rows)
G = Image.new('RGB', (w * cols, H), (0, 0, 0)); y = 0
for r in rows:
    for j, i in enumerate(r): G.paste(i, (j * w, y))
    y += max(i.height for i in r)
G.save(out)
