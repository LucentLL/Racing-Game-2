"""Vectorize Maps/485.png (I-485 outer loop, single orange-red closed stroke)
-> maplab/hw485.json + hw485_qc.png.

Self-contained: numpy + PIL + scipy.ndimage only (skimage missing -> Zhang-Suen here).
Re-runnable: py -3 vec485.py
"""
import json
import os
import sys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

SRC = "C:/Users/mcgee/code/Racing-Game-2/Maps/485.png"
OUTDIR = os.path.dirname(os.path.abspath(__file__))
OUT_JSON = os.path.join(OUTDIR, "hw485.json")
OUT_QC = os.path.join(OUTDIR, "hw485_qc.png")

SPECK_MIN_LEN = 20.0   # px arc length for dangling segments
DP_EPS = 2.0           # Douglas-Peucker epsilon px
SPUR_PRUNE_ITERS = 15  # max endpoint-peel iterations (loop layer has no real endpoints)

# ---------------------------------------------------------------- Zhang-Suen
def zhang_suen(img: np.ndarray) -> np.ndarray:
    """Vectorized Zhang-Suen thinning. img: bool 2D. Returns bool skeleton."""
    im = np.pad(img.astype(np.uint8), 1)
    def nbrs(a):
        P2 = np.roll(a, 1, 0)              # N
        P3 = np.roll(np.roll(a, 1, 0), -1, 1)   # NE
        P4 = np.roll(a, -1, 1)             # E
        P5 = np.roll(np.roll(a, -1, 0), -1, 1)  # SE
        P6 = np.roll(a, -1, 0)             # S
        P7 = np.roll(np.roll(a, -1, 0), 1, 1)   # SW
        P8 = np.roll(a, 1, 1)              # W
        P9 = np.roll(np.roll(a, 1, 0), 1, 1)    # NW
        return P2, P3, P4, P5, P6, P7, P8, P9
    it = 0
    while True:
        changed = False
        for step in (0, 1):
            P2, P3, P4, P5, P6, P7, P8, P9 = nbrs(im)
            seq = [P2, P3, P4, P5, P6, P7, P8, P9, P2]
            A = np.zeros_like(im, dtype=np.uint8)
            for k in range(8):
                A += ((seq[k] == 0) & (seq[k + 1] == 1)).astype(np.uint8)
            B = P2 + P3 + P4 + P5 + P6 + P7 + P8 + P9
            cond = (im == 1) & (B >= 2) & (B <= 6) & (A == 1)
            if step == 0:
                cond &= (P2 * P4 * P6 == 0) & (P4 * P6 * P8 == 0)
            else:
                cond &= (P2 * P4 * P8 == 0) & (P2 * P6 * P8 == 0)
            if cond.any():
                im[cond] = 0
                changed = True
        it += 1
        if not changed or it > 200:
            break
    return im[1:-1, 1:-1].astype(bool)

# ---------------------------------------------------------------- tracing
# Graph rule: 4-neighbors always connect; a DIAGONAL edge is redundant (dropped)
# when the two pixels share a 4-neighbor in the skeleton. This removes the
# Zhang-Suen staircase artifact where corner pixels read as false junctions.
OFFS4 = [(-1, 0), (1, 0), (0, -1), (0, 1)]
OFFSD = [(-1, -1), (-1, 1), (1, -1), (1, 1)]

def degree_map(skel):
    s = skel.astype(np.uint8)
    def sh(dy, dx):
        out = np.zeros_like(s)
        H, W = s.shape
        ys0, ys1 = max(dy, 0), H + min(dy, 0)
        xs0, xs1 = max(dx, 0), W + min(dx, 0)
        out[ys0:ys1, xs0:xs1] = s[ys0 - dy:ys1 - dy, xs0 - dx:xs1 - dx]
        return out
    N, S, Wst, E = sh(-1, 0), sh(1, 0), sh(0, -1), sh(0, 1)
    deg = N + S + Wst + E
    # diagonal counts only when no shared 4-neighbor bridges it
    deg += sh(-1, -1) & ~(N | Wst)
    deg += sh(-1, 1) & ~(N | E)
    deg += sh(1, -1) & ~(S | Wst)
    deg += sh(1, 1) & ~(S | E)
    return deg * skel

def prune_spurs(skel, max_iters):
    """Peel degree-1 endpoints; safe for closed-loop layers (no real endpoints)."""
    total = 0
    for _ in range(max_iters):
        deg = degree_map(skel)
        ends = skel & (deg <= 1)
        n = int(ends.sum())
        if n == 0:
            break
        skel = skel & ~ends
        total += n
    return skel, total

def neighbors_of(p, skel):
    y, x = p
    H, W = skel.shape
    def on(yy, xx):
        return 0 <= yy < H and 0 <= xx < W and skel[yy, xx]
    out = [(y + dy, x + dx) for dy, dx in OFFS4 if on(y + dy, x + dx)]
    for dy, dx in OFFSD:
        ny, nx = y + dy, x + dx
        if on(ny, nx) and not (on(y + dy, x) or on(y, x + dx)):
            out.append((ny, nx))
    return out

def trace_segments(skel):
    """Walk skeleton into node-to-node paths + pure cycles.
    Returns list of dicts {pts:[(y,x)...], closed:bool}."""
    deg = degree_map(skel)
    node_mask = skel & (deg != 2)
    visited = np.zeros_like(skel, bool)  # consumed non-node pixels
    segs = []
    used_pairs = set()

    node_list = list(zip(*np.nonzero(node_mask)))
    for p in node_list:
        for q in neighbors_of(p, skel):
            if node_mask[q]:
                key = frozenset((p, q))
                if key not in used_pairs:
                    used_pairs.add(key)
                    segs.append({"pts": [p, q], "closed": False})
                continue
            if visited[q]:
                continue
            path = [p, q]
            visited[q] = True
            prev, cur = p, q
            while True:
                cands = [r for r in neighbors_of(cur, skel)
                         if r != prev and (node_mask[r] or not visited[r])]
                # prefer terminating on a node
                node_c = [r for r in cands if node_mask[r]]
                if node_c:
                    # pick the closest node candidate (4-adjacent before diagonal)
                    node_c.sort(key=lambda r: abs(r[0]-cur[0]) + abs(r[1]-cur[1]))
                    path.append(node_c[0])
                    break
                cands = [r for r in cands if not visited[r]]
                if not cands:
                    break  # dead end (shouldn't happen after pruning)
                nxt = cands[0]
                visited[nxt] = True
                path.append(nxt)
                prev, cur = cur, nxt
            segs.append({"pts": path, "closed": False})

    # pure cycles: remaining unvisited degree-2 pixels
    rem = skel & ~node_mask & ~visited
    ys, xs = np.nonzero(rem)
    remset = set(zip(ys.tolist(), xs.tolist()))
    while remset:
        start = next(iter(remset))
        remset.discard(start)
        path = [start]
        prev, cur = None, start
        while True:
            cands = [r for r in neighbors_of(cur, skel) if r != prev and r in remset]
            if not cands:
                break
            nxt = cands[0]
            remset.discard(nxt)
            path.append(nxt)
            prev, cur = cur, nxt
        segs.append({"pts": path, "closed": True})
    return segs

def arc_len(pts):
    a = np.asarray(pts, float)
    if len(a) < 2:
        return 0.0
    return float(np.hypot(*(a[1:] - a[:-1]).T).sum())

def stitch(segs):
    """Merge open segments end-to-end wherever exactly two segment-ends meet
    at a shared endpoint. Turns a junction-split loop back into one cycle."""
    open_segs = [s for s in segs if not s["closed"]]
    closed_segs = [s for s in segs if s["closed"]]
    changed = True
    while changed:
        changed = False
        ends = {}
        for i, s in enumerate(open_segs):
            for e in (s["pts"][0], s["pts"][-1]):
                ends.setdefault(e, []).append(i)
        for e, idxs in ends.items():
            uniq = list(dict.fromkeys(idxs))
            if len(idxs) == 2:
                if len(uniq) == 1:
                    # one segment meeting itself -> cycle
                    s = open_segs[uniq[0]]
                    if len(s["pts"]) > 3:
                        s["closed"] = True
                        if s["pts"][0] == s["pts"][-1]:
                            s["pts"] = s["pts"][:-1]
                        closed_segs.append(s)
                        open_segs.pop(uniq[0])
                        changed = True
                        break
                    continue
                i, j = uniq
                a, b = open_segs[i], open_segs[j]
                ap, bp = a["pts"], b["pts"]
                if ap[-1] != e:
                    ap = ap[::-1]
                if bp[0] != e:
                    bp = bp[::-1]
                a["pts"] = ap + bp[1:]
                open_segs.pop(j)
                changed = True
                break
    return open_segs + closed_segs

# ---------------------------------------------------------------- simplify
def dp_open(pts, eps):
    """Iterative Douglas-Peucker on list of (y,x)."""
    pts = np.asarray(pts, float)
    n = len(pts)
    if n < 3:
        return pts.tolist()
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i0, i1 = stack.pop()
        if i1 <= i0 + 1:
            continue
        p0, p1 = pts[i0], pts[i1]
        d = p1 - p0
        L = np.hypot(*d)
        seg = pts[i0 + 1:i1]
        if L < 1e-9:
            dist = np.hypot(*(seg - p0).T)
        else:
            dist = np.abs(np.cross(d, seg - p0)) / L
        k = int(np.argmax(dist))
        if dist[k] > eps:
            idx = i0 + 1 + k
            keep[idx] = True
            stack.append((i0, idx))
            stack.append((idx, i1))
    return pts[keep].tolist()

def dp_closed(pts, eps):
    pts = list(pts)
    if len(pts) < 5:
        return pts
    a0 = np.asarray(pts[0], float)
    d = np.hypot(*(np.asarray(pts, float) - a0).T)
    i = int(np.argmax(d))
    half1 = dp_open(pts[:i + 1], eps)
    half2 = dp_open(pts[i:] + [pts[0]], eps)
    return half1[:-1] + half2[:-1]

# ---------------------------------------------------------------- main
def main():
    img = Image.open(SRC).convert("RGBA")
    W, H = img.size
    arr = np.asarray(img)
    mask = arr[:, :, 3] > 128
    n_mask = int(mask.sum())

    # crop to bbox + margin for speed
    ys, xs = np.nonzero(mask)
    y0, y1 = max(0, ys.min() - 4), min(H, ys.max() + 5)
    x0, x1 = max(0, xs.min() - 4), min(W, xs.max() + 5)
    m = mask[y0:y1, x0:x1]

    # dilate 1px to close antialias gaps, skeletonize
    md = ndi.binary_dilation(m, structure=np.ones((3, 3), bool))
    skel = zhang_suen(md)
    n_skel0 = int(skel.sum())
    skel, pruned = prune_spurs(skel, SPUR_PRUNE_ITERS)
    n_skel = int(skel.sum())

    # width from UNdilated mask distance transform
    edt = ndi.distance_transform_edt(m)

    segs = trace_segments(skel)
    # drop dangling specks (short + at least one non-junction end)
    deg = degree_map(skel)
    kept, dropped = [], 0
    for s in segs:
        L = arc_len(s["pts"] + ([s["pts"][0]] if s["closed"] else []))
        if not s["closed"] and L < SPECK_MIN_LEN:
            e0, e1 = s["pts"][0], s["pts"][-1]
            if deg[e0] <= 1 or deg[e1] <= 1:
                dropped += 1
                continue
        kept.append(s)
    segs = stitch(kept)
    # post-stitch speck drop (anything tiny that survived)
    final = []
    for s in segs:
        L = arc_len(s["pts"] + ([s["pts"][0]] if s["closed"] else []))
        if L < SPECK_MIN_LEN:
            dropped += 1
            continue
        final.append(s)

    polylines = []
    total_len = 0.0
    for s in final:
        raw = s["pts"]
        widths = [2.0 * edt[p] for p in raw if edt[p] > 0]
        w_med = float(np.median(widths)) if widths else 0.0
        simp = dp_closed(raw, DP_EPS) if s["closed"] else dp_open(raw, DP_EPS)
        # (y,x) crop coords -> (x,y) full-image coords
        pts_xy = [[int(round(x + x0)), int(round(y + y0))] for y, x in simp]
        L = arc_len([(p[1], p[0]) for p in pts_xy] +
                    ([(pts_xy[0][1], pts_xy[0][0])] if s["closed"] else []))
        total_len += L
        polylines.append({"pts": pts_xy, "widthPx": round(w_med, 2),
                          "closed": bool(s["closed"]), "lenPx": round(L, 1),
                          "rawPts": len(raw), "simpPts": len(pts_xy)})

    polylines.sort(key=lambda p: -p["lenPx"])
    out = {"layer": "hw485", "imageSize": [W, H],
           "polylines": [{"pts": p["pts"], "widthPx": p["widthPx"],
                          "closed": p["closed"]} for p in polylines]}
    with open(OUT_JSON, "w") as f:
        json.dump(out, f)

    # ------------------------------------------------------------ QC render
    base = Image.new("RGB", (W, H), (255, 255, 255))
    faded = Image.composite(
        Image.new("RGB", (W, H), (255, 200, 180)),  # pale tint of source stroke
        base,
        Image.fromarray((mask * 90).astype(np.uint8)))
    qc = faded.copy()
    dr = ImageDraw.Draw(qc)
    palette = [(0, 140, 0), (160, 0, 200), (0, 0, 230), (200, 120, 0),
               (0, 150, 150), (220, 0, 120)]
    for i, p in enumerate(polylines):
        col = palette[i % len(palette)]
        pts = [tuple(pt) for pt in p["pts"]]
        if p["closed"]:
            pts = pts + [pts[0]]
        dr.line(pts, fill=col, width=1)
        # start marker
        sx, sy = pts[0]
        dr.ellipse([sx - 4, sy - 4, sx + 4, sy + 4], outline=col, width=2)
    qc.save(OUT_QC)

    summary = {
        "layer": "hw485",
        "imageSize": [W, H],
        "maskPx": n_mask,
        "skelPx": {"beforePrune": n_skel0, "afterPrune": n_skel, "prunedSpurPx": pruned},
        "count": len(polylines),
        "closedCount": sum(1 for p in polylines if p["closed"]),
        "totalLenPx": round(total_len, 1),
        "droppedSpecks": dropped,
        "perPolyline": [{"lenPx": p["lenPx"], "widthPx": p["widthPx"],
                         "closed": p["closed"], "rawPts": p["rawPts"],
                         "simpPts": p["simpPts"]} for p in polylines],
    }
    print(json.dumps(summary, indent=1))

if __name__ == "__main__":
    main()
