"""
vec_trace.py -- vectorize a colored-stroke map layer PNG into polylines.

Pipeline: alpha/color threshold -> 1px binary dilation (close antialiasing) ->
Zhang-Suen thinning (numpy, skimage not installed) -> graph trace from
endpoints/junctions -> spur pruning (<min_len with a free end) with re-trace ->
Douglas-Peucker simplify -> per-polyline median stroke width from EDT of the
ORIGINAL (undilated) mask.

Re-runnable CLI, e.g.:
  py -3 vec_trace.py --image "C:/.../Maps/77.png" --layer hw77 \
     --out hw77.json --qc hw77_qc.png --eps 2.0 --min-len 20
"""
import argparse, json, math, os, sys, colorsys
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage


# ---------------------------------------------------------------- mask
def build_mask(img_rgba, alpha_thresh=128, color=None, tol=60):
    a = img_rgba[..., 3]
    mask = a > alpha_thresh
    if color is not None:
        rgb = img_rgba[..., :3].astype(np.int32)
        d = np.abs(rgb - np.array(color, dtype=np.int32)).sum(axis=-1)
        mask &= d <= tol
    return mask


# ---------------------------------------------------------------- Zhang-Suen
def zhang_suen(mask, max_iter=200):
    """Vectorized Zhang-Suen thinning. mask: bool array -> bool skeleton."""
    img = mask.astype(np.uint8)
    for it in range(max_iter):
        changed = False
        for step in (0, 1):
            P = np.pad(img, 1)
            p2 = P[0:-2, 1:-1]  # N
            p3 = P[0:-2, 2:]    # NE
            p4 = P[1:-1, 2:]    # E
            p5 = P[2:, 2:]      # SE
            p6 = P[2:, 1:-1]    # S
            p7 = P[2:, 0:-2]    # SW
            p8 = P[1:-1, 0:-2]  # W
            p9 = P[0:-2, 0:-2]  # NW
            nb = [p2, p3, p4, p5, p6, p7, p8, p9]
            B = np.zeros_like(p2, dtype=np.uint8)
            for n in nb:
                B += n
            A = np.zeros_like(p2, dtype=np.uint8)
            seq = nb + [p2]
            for i in range(8):
                A += ((seq[i] == 0) & (seq[i + 1] == 1)).astype(np.uint8)
            if step == 0:
                cond = ((img == 1) & (B >= 2) & (B <= 6) & (A == 1)
                        & ((p2 & p4 & p6) == 0) & ((p4 & p6 & p8) == 0))
            else:
                cond = ((img == 1) & (B >= 2) & (B <= 6) & (A == 1)
                        & ((p2 & p4 & p8) == 0) & ((p2 & p6 & p8) == 0))
            if cond.any():
                img[cond] = 0
                changed = True
        if not changed:
            break
    return img.astype(bool)


# ---------------------------------------------------------------- graph trace
NB8 = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def cleanup_skeleton(skel):
    """Reduce a Zhang-Suen skeleton to a minimal 8-connected curve set.

    ZS leaves staircase corners / triangle glue where diagonal steps give
    pixels 3 neighbors, so degree-based junction detection sees thousands of
    fake nodes. Remove any pixel whose skeleton neighbors (>=2) form a single
    8-connected cluster among themselves: deleting it preserves connectivity.
    """
    skel = skel.copy()
    H, W = skel.shape
    changed = True
    while changed:
        changed = False
        ys, xs = np.nonzero(skel)
        for y, x in zip(ys.tolist(), xs.tolist()):
            if not skel[y, x]:
                continue
            nbrs = [(y + dy, x + dx) for dy, dx in NB8
                    if 0 <= y + dy < H and 0 <= x + dx < W and skel[y + dy, x + dx]]
            if len(nbrs) < 2:
                continue
            # count 8-connected components among the neighbor pixels themselves
            seen, comps = set(), 0
            for s in nbrs:
                if s in seen:
                    continue
                comps += 1
                stack = [s]
                seen.add(s)
                while stack:
                    c = stack.pop()
                    for t in nbrs:
                        if t not in seen and max(abs(t[0] - c[0]), abs(t[1] - c[1])) <= 1:
                            seen.add(t)
                            stack.append(t)
            if comps == 1:
                skel[y, x] = False
                changed = True
    return skel


def degree_map(skel):
    k = np.ones((3, 3), dtype=np.uint8)
    k[1, 1] = 0
    return ndimage.convolve(skel.astype(np.uint8), k, mode="constant")


def trace_skeleton(skel):
    """Trace 1px skeleton into polylines (pixel chains).
    Returns list of dicts {px: [(y,x)...], closed: bool}."""
    deg = degree_map(skel)
    deg[~skel] = 0
    nodes = skel & (deg != 2)          # endpoints (1) + junctions (>=3) + isolated (0)
    ys, xs = np.nonzero(nodes)
    node_px = list(zip(ys.tolist(), xs.tolist()))
    visited_edges = set()               # frozenset of two (y,x) pixels
    visited_px = np.zeros_like(skel, dtype=bool)
    paths = []

    def skel_neighbors(y, x):
        out = []
        for dy, dx in NB8:
            ny, nx = y + dy, x + dx
            if 0 <= ny < skel.shape[0] and 0 <= nx < skel.shape[1] and skel[ny, nx]:
                out.append((ny, nx))
        return out

    # walk edges out of every node
    for (y, x) in node_px:
        visited_px[y, x] = True
        for nb in skel_neighbors(y, x):
            e = frozenset(((y, x), nb))
            if e in visited_edges:
                continue
            path = [(y, x), nb]
            visited_edges.add(e)
            prev, cur = (y, x), nb
            while not nodes[cur]:
                visited_px[cur] = True
                nxt = None
                for cn in skel_neighbors(*cur):
                    if cn != prev and frozenset((cur, cn)) not in visited_edges:
                        nxt = cn
                        break
                if nxt is None:
                    break
                visited_edges.add(frozenset((cur, nxt)))
                path.append(nxt)
                prev, cur = cur, nxt
            visited_px[cur] = True
            if len(path) >= 2:
                paths.append({"px": path, "closed": False})

    # pure cycles: remaining unvisited deg-2 pixels
    remaining = skel & ~visited_px
    ys, xs = np.nonzero(remaining)
    for y, x in zip(ys.tolist(), xs.tolist()):
        if visited_px[y, x]:
            continue
        path = [(y, x)]
        visited_px[y, x] = True
        prev, cur = None, (y, x)
        while True:
            nxt = None
            for cn in skel_neighbors(*cur):
                if cn != prev and not visited_px[cn]:
                    nxt = cn
                    break
            if nxt is None:
                break
            visited_px[nxt] = True
            path.append(nxt)
            prev, cur = cur, nxt
        if len(path) >= 3:
            paths.append({"px": path, "closed": True})
    return paths


def arc_len(px):
    s = 0.0
    for i in range(1, len(px)):
        s += math.hypot(px[i][0] - px[i - 1][0], px[i][1] - px[i - 1][1])
    return s


def prune_spurs(skel, min_len):
    """Iteratively remove spur branches (< min_len, with >=1 free endpoint)
    and isolated specks from the skeleton; return cleaned skeleton + stats."""
    skel = skel.copy()
    dropped = 0
    for _ in range(10):
        paths = trace_skeleton(skel)
        deg = degree_map(skel)
        deg[~skel] = 0
        removed_any = False
        for p in paths:
            if p["closed"]:
                continue
            L = arc_len(p["px"])
            if L >= min_len:
                continue
            a, b = p["px"][0], p["px"][-1]
            # free end = endpoint pixel with degree <= 1 (dangling)
            if deg[a] <= 1 or deg[b] <= 1:
                for (y, x) in p["px"]:
                    # keep junction pixels (shared with other branches)
                    if deg[y, x] >= 3:
                        continue
                    skel[y, x] = False
                dropped += 1
                removed_any = True
        if not removed_any:
            break
    return skel, dropped


# ---------------------------------------------------------------- simplify
def rdp(pts, eps):
    """Iterative Douglas-Peucker. pts: list of (x, y)."""
    n = len(pts)
    if n < 3:
        return list(pts)
    keep = np.zeros(n, dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    P = np.asarray(pts, dtype=np.float64)
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = P[i], P[j]
        ab = b - a
        L = np.hypot(*ab)
        seg = P[i + 1:j]
        if L < 1e-9:
            d = np.hypot(seg[:, 0] - a[0], seg[:, 1] - a[1])
        else:
            d = np.abs(ab[0] * (a[1] - seg[:, 1]) - ab[1] * (a[0] - seg[:, 0])) / L
        k = int(np.argmax(d))
        if d[k] > eps:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m))
            stack.append((m, j))
    return [pts[i] for i in range(n) if keep[i]]


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--layer", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--qc", required=True)
    ap.add_argument("--alpha-thresh", type=int, default=128)
    ap.add_argument("--color", default=None, help="R,G,B optional color filter")
    ap.add_argument("--tol", type=int, default=60)
    ap.add_argument("--eps", type=float, default=2.0)
    ap.add_argument("--min-len", type=float, default=20.0)
    ap.add_argument("--junc-snap", type=float, default=14.0,
                    help="cluster radius (px) for consolidating junction nodes")
    args = ap.parse_args()

    im = Image.open(args.image).convert("RGBA")
    arr = np.array(im)
    H, W = arr.shape[:2]
    color = tuple(int(c) for c in args.color.split(",")) if args.color else None

    mask = build_mask(arr, args.alpha_thresh, color, args.tol)
    n_mask = int(mask.sum())
    lbl, n_comp = ndimage.label(mask, structure=np.ones((3, 3)))
    print(f"[mask] {n_mask} px, {n_comp} connected components")

    dil = ndimage.binary_dilation(mask, structure=np.ones((3, 3)))
    print("[skel] thinning...")
    skel = zhang_suen(dil)
    print(f"[skel] {int(skel.sum())} px raw")
    skel = cleanup_skeleton(skel)
    print(f"[skel] {int(skel.sum())} px after minimal-curve cleanup")

    skel, n_spur = prune_spurs(skel, args.min_len)
    skel = cleanup_skeleton(skel)  # spur removal can re-expose corner glue
    paths = trace_skeleton(skel)

    # consolidate junction clusters: paths ending at the same drawn junction
    # (glue pixels within --junc-snap of each other) share one exact node pt
    deg = degree_map(skel)
    deg[~skel] = 0
    jpx = [tuple(p) for p in np.argwhere(skel & (deg >= 3))]
    parent = list(range(len(jpx)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(jpx)):
        for j in range(i + 1, len(jpx)):
            if math.hypot(jpx[i][0] - jpx[j][0], jpx[i][1] - jpx[j][1]) <= args.junc_snap:
                parent[find(i)] = find(j)
    clusters = {}
    for i, p in enumerate(jpx):
        clusters.setdefault(find(i), []).append(p)
    snap = {}  # junction pixel -> cluster centroid (y, x)
    for members in clusters.values():
        cy = int(round(sum(m[0] for m in members) / len(members)))
        cx = int(round(sum(m[1] for m in members) / len(members)))
        for m in members:
            snap[m] = (cy, cx)
    n_junctions = len(clusters)
    for p in paths:
        if p["px"][0] in snap:
            p["px"][0] = snap[p["px"][0]]
        if p["px"][-1] in snap:
            p["px"][-1] = snap[p["px"][-1]]

    # EDT of ORIGINAL mask for stroke width
    edt = ndimage.distance_transform_edt(mask)

    polylines, n_speck = [], 0
    for p in paths:
        L = arc_len(p["px"])
        if L < args.min_len:
            n_speck += 1
            continue
        widths = [edt[y, x] * 2.0 for (y, x) in p["px"]]
        w = float(np.median(widths))
        pts_xy = [(x, y) for (y, x) in p["px"]]
        simp = rdp(pts_xy, args.eps)
        if p["closed"] and simp[0] != simp[-1]:
            simp.append(simp[0])
        polylines.append({
            "pts": [[int(x), int(y)] for (x, y) in simp],
            "widthPx": round(w, 1),
            "closed": bool(p["closed"]),
            "_lenPx": round(L, 1),
        })

    polylines.sort(key=lambda r: -r["_lenPx"])
    total_len = sum(r["_lenPx"] for r in polylines)

    out = {
        "layer": args.layer,
        "imageSize": [W, H],
        "polylines": [{k: v for k, v in r.items() if not k.startswith("_")}
                      for r in polylines],
    }
    with open(args.out, "w") as f:
        json.dump(out, f)
    print(f"[out] {args.out}: {len(polylines)} polylines, "
          f"totalLen {total_len:.0f}px, specks dropped {n_speck}, spurs pruned {n_spur}")

    # ---------------- QC render: faded source + 1px colored traces
    base = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    base.alpha_composite(im)
    faded = Image.blend(base, Image.new("RGBA", (W, H), (255, 255, 255, 255)), 0.75)
    dr = ImageDraw.Draw(faded)
    for i, r in enumerate(polylines):
        h = (i * 0.6180339887) % 1.0
        rgb = tuple(int(c * 255) for c in colorsys.hsv_to_rgb(h, 0.95, 0.75))
        pts = [tuple(p) for p in r["pts"]]
        dr.line(pts, fill=rgb + (255,), width=1)
        for (x, y) in (pts[0], pts[-1]):  # endpoint markers
            dr.ellipse([x - 4, y - 4, x + 4, y + 4], outline=(0, 0, 0, 255), width=1)
    faded.convert("RGB").save(args.qc)
    print(f"[qc] {args.qc}")

    # summary blob for the caller
    hist = {}
    for r in polylines:
        k = str(int(round(r["widthPx"])))
        hist[k] = hist.get(k, 0) + 1
    n_free = int(((deg == 1) & skel).sum())
    summary = {
        "layer": args.layer,
        "count": len(polylines),
        "totalLenPx": round(total_len),
        "widthClasses": hist,
        "maskComponents": n_comp,
        "specksDropped": n_speck,
        "spursPruned": n_spur,
        "junctionNodes": n_junctions,
        "freeEnds": n_free,
        "lengthsPx": [r["_lenPx"] for r in polylines],
    }
    with open(os.path.splitext(args.out)[0] + "_summary.json", "w") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
