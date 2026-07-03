# User's suggestion: layer the same-size source maps and draw the traced
# 77-layer polylines over them — if any traced "interstate" rides a yellow
# minor stroke (e.g. Freedom Dr), the trace jumped layers.
import json, os
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
FIX = os.path.join(ROOT, 'fixtures', 'maps')
MAPS = os.path.join(ROOT, 'Maps')

def flat(name):
    im = Image.open(os.path.join(MAPS, name)).convert('RGBA')
    bg = Image.new('RGBA', im.size, (255, 255, 255, 255))
    return np.asarray(Image.alpha_composite(bg, im).convert('RGB')).astype(np.int32)

minor = flat('Minor Roads.png')
hw77 = flat('77.png')
h, w, _ = minor.shape
base = np.full((h, w, 3), 255, dtype=np.uint8)
mmask = minor.sum(axis=2) < 720
hmask = hw77.sum(axis=2) < 720
base[mmask] = (150, 150, 150)
base[hmask] = (140, 190, 255)
img = Image.fromarray(base)
d = ImageDraw.Draw(img)
tr = json.load(open(os.path.join(FIX, 'hw77.json')))
for i, p in enumerate(tr['polylines']):
    xy = [(pt[0], pt[1]) for pt in p['pts']]
    d.line(xy, fill=(220, 30, 30), width=3)
    mx, my = xy[len(xy)//2]
    d.text((mx+10, my+10), f"#{i}", fill=(160, 0, 0))
img = img.resize((int(w*0.33), int(h*0.33)))
img.save(os.path.join(FIX, 'layer_check_77.png'))
print('ok')
