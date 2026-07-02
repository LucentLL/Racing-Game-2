"""Render transformed layers over baseline landmarks for visual QC. py -3 fit_qc.py"""
import json, os
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SC = 0.5  # world tile -> px, with offset so negative coords visible
OX, OY = 1100, 150

def w2p(pts):
    return [((x + OX) * SC, (y + OY) * SC) for x, y in pts]

img = Image.new("RGB", (int((2500 + OX + 1100) * SC), int((2500 + OY + 300) * SC)), (18, 18, 22))
dr = ImageDraw.Draw(img)
# world bounds
dr.rectangle([OX * SC, OY * SC, (2500 + OX) * SC, (2500 + OY) * SC], outline=(90, 90, 90), width=2)

layers = [("world_water.json", (40, 90, 130), 2),
          ("world_minor.json", (110, 90, 30), 1),
          ("world_hw485.json", (255, 120, 40), 3),
          ("world_hw77.json", (90, 150, 255), 3)]
for fn, col, w in layers:
    d = json.load(open(os.path.join(HERE, fn)))
    for pl in d["polylines"]:
        pts = w2p(pl["pts"])
        if pl.get("closed") and len(pts) > 2:
            pts = pts + [pts[0]]
        dr.line(pts, fill=col, width=w)

# baseline landmarks in white, on top
lm = json.load(open(os.path.join(HERE, "landmarks.json")))
for name, row in lm.items():
    pts = np.array(row[4:], float).reshape(-1, 2)
    p = w2p(pts.tolist())
    if name == "I-485":
        p = p + [p[0]]
    dr.line(p, fill=(255, 255, 255), width=1)

img.save(os.path.join(HERE, "fit_qc.png"))
print("wrote fit_qc.png", img.size)
