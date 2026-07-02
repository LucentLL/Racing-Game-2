"""Recon pass for map-vectorization project.

1. Parse baselineRoads.ts -> per-class counts, width histogram, extents;
   dump I-485 / I-77 N / I-77 S rows verbatim to landmarks.json.
2. Analyze the 4 source PNGs -> stroke RGB clusters, stroke thickness
   (EDT-ridge based), non-white bounding box.

Re-runnable: py -3 recon.py
Outputs: landmarks.json, recon_summary.json (same dir as this script).
"""
import json
import os
import re
import sys

import numpy as np
from PIL import Image

try:
    from scipy import ndimage
    HAVE_SCIPY = True
except ImportError:
    HAVE_SCIPY = False

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = r"C:/Users/mcgee/code/Racing-Game-2"
BASELINE_TS = os.path.join(REPO, "src", "config", "world", "baselineRoads.ts")
MAPS = {
    "77": os.path.join(REPO, "Maps", "77.png"),
    "485": os.path.join(REPO, "Maps", "485.png"),
    "minor": os.path.join(REPO, "Maps", "Minor Roads.png"),
    "water": os.path.join(REPO, "Maps", "Rivers and Lake.png"),
}

# ---------------------------------------------------------------- baseline --

def parse_baseline():
    src = open(BASELINE_TS, encoding="utf-8").read()
    # Rows look like: [10,1,"I-485",4,1606,365,...],
    row_re = re.compile(r"^\[(\d+),([01]),\"([^\"]+)\",(\d+),([0-9,\s]+)\],?\s*$",
                        re.MULTILINE)
    rows = []
    for m in row_re.finditer(src):
        w, maj, name, z = int(m.group(1)), int(m.group(2)), m.group(3), int(m.group(4))
        coords = [int(v) for v in m.group(5).split(",") if v.strip()]
        rows.append({"w": w, "maj": maj, "name": name, "z": z, "coords": coords})

    highways = [r for r in rows if r["maj"] == 1]
    minors = [r for r in rows if r["maj"] == 0]

    def extents(rs):
        xs = [c for r in rs for c in r["coords"][0::2]]
        ys = [c for r in rs for c in r["coords"][1::2]]
        return {"x": [min(xs), max(xs)], "y": [min(ys), max(ys)]}

    width_hist = {}
    for r in rows:
        width_hist[r["w"]] = width_hist.get(r["w"], 0) + 1

    stats = {
        "rows_total": len(rows),
        "highways": {
            "count": len(highways),
            "names": [r["name"] for r in highways],
            "widths": {r["name"]: r["w"] for r in highways},
            "pt_counts": {r["name"]: len(r["coords"]) // 2 for r in highways},
            "extents": extents(highways),
        },
        "minors": {
            "count": len(minors),
            "widths": sorted(set(r["w"] for r in minors)),
            "extents": extents(minors),
        },
        "width_hist": {str(k): v for k, v in sorted(width_hist.items())},
    }

    landmarks = {}
    for name in ("I-485", "I-77 N", "I-77 S"):
        r = next(r for r in rows if r["name"] == name)
        landmarks[name] = [r["w"], r["maj"], r["name"], r["z"], *r["coords"]]
    with open(os.path.join(HERE, "landmarks.json"), "w", encoding="utf-8") as f:
        json.dump(landmarks, f)
    return stats

# ------------------------------------------------------------------ images --

# Source PNGs are RGBA with a fully transparent background; strokes are
# colored, anti-aliased content pixels. Mask = alpha > ALPHA_THRESH.
ALPHA_THRESH = 128
WHITE_THRESH = 245  # fallback for non-alpha images: content if any channel below this


def color_clusters(rgb, mask, max_clusters=6):
    """Histogram-cluster non-white pixels by quantized RGB (/24 bins)."""
    px = rgb[mask]
    if len(px) == 0:
        return []
    q = (px // 24).astype(np.int32)
    keys = q[:, 0] * 10000 + q[:, 1] * 100 + q[:, 2]
    uniq, counts = np.unique(keys, return_counts=True)
    order = np.argsort(counts)[::-1]
    total = len(px)
    out = []
    for idx in order[:max_clusters * 3]:
        share = counts[idx] / total
        if share < 0.01 and len(out) >= 2:
            break
        sel = keys == uniq[idx]
        mean = px[sel].mean(axis=0)
        out.append({"rgb": [int(round(v)) for v in mean],
                    "share": round(float(share), 4),
                    "count": int(counts[idx])})
        if len(out) >= max_clusters:
            break
    return out


def thickness_stats(mask):
    """Stroke thickness via EDT ridge: 2*edt-1 at local-max pixels."""
    if not HAVE_SCIPY:
        return runlength_thickness(mask)
    edt = ndimage.distance_transform_edt(mask)
    local_max = ndimage.maximum_filter(edt, size=3)
    ridge = mask & (edt >= local_max) & (edt > 0.5)
    vals = 2 * edt[ridge] - 1
    if len(vals) == 0:
        return None
    return {
        "method": "edt_ridge",
        "p10": round(float(np.percentile(vals, 10)), 1),
        "p50": round(float(np.percentile(vals, 50)), 1),
        "p90": round(float(np.percentile(vals, 90)), 1),
        "max": round(float(vals.max()), 1),
        "n_ridge_px": int(ridge.sum()),
    }


def runlength_thickness(mask):
    """Fallback: horizontal run lengths of content pixels."""
    runs = []
    h = mask.shape[0]
    for y in range(0, h, max(1, h // 400)):
        row = mask[y]
        d = np.diff(row.astype(np.int8))
        starts = np.where(d == 1)[0]
        ends = np.where(d == -1)[0]
        n = min(len(starts), len(ends))
        runs.extend((ends[:n] - starts[:n]).tolist())
    runs = np.array([r for r in runs if r > 0])
    if len(runs) == 0:
        return None
    return {
        "method": "h_runs",
        "p10": float(np.percentile(runs, 10)),
        "p50": float(np.percentile(runs, 50)),
        "p90": float(np.percentile(runs, 90)),
        "max": float(runs.max()),
    }


def largest_component(mask):
    if not HAVE_SCIPY:
        return None
    lab, n = ndimage.label(mask)
    if n == 0:
        return None
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    big = int(np.argmax(sizes)) + 1
    ys, xs = np.where(lab == big)
    return {"area_px": int(sizes[big - 1]),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
            "n_components": int(n)}


def analyze_image(path):
    im = Image.open(path)
    mode = im.mode
    rgba = np.asarray(im.convert("RGBA"))
    rgb = rgba[..., :3]
    h, w = rgb.shape[:2]
    if mode in ("RGBA", "LA", "PA") or "transparency" in im.info:
        mask = rgba[..., 3] > ALPHA_THRESH
    else:
        mask = (rgb < WHITE_THRESH).any(axis=2)
    n = int(mask.sum())
    if n == 0:
        return {"size": [w, h], "empty": True}
    ys, xs = np.where(mask)
    bbox = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    return {
        "mode": mode,
        "size": [w, h],
        "content_px": n,
        "content_share": round(n / (w * h), 4),
        "bbox_xyxy": bbox,
        "colors": color_clusters(rgb, mask),
        "thicknessPx": thickness_stats(mask),
        "largest_component": largest_component(mask),
    }


def main():
    summary = {
        "python": {
            "version": sys.version.split()[0],
            "exe": sys.executable,
            "numpy": np.__version__,
            "scipy": HAVE_SCIPY,
        },
        "baseline": parse_baseline(),
        "images": {},
    }
    for name, path in MAPS.items():
        summary["images"][name] = analyze_image(path)
    out = os.path.join(HERE, "recon_summary.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
