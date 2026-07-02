"""Vectorize Maps/Rivers and Lake.png -> water.json + water_qc.png.

Rivers (dark cyan strokes) -> skeleton -> polylines (Douglas-Peucker eps=2).
Lake / wide-water fills (pale cyan) -> boundary trace -> closed polygons (kind:lake).
Re-runnable: py -3 vectorize_water.py
"""
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

SRC = "C:/Users/mcgee/code/Racing-Game-2/Maps/Rivers and Lake.png"
OUT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_JSON = os.path.join(OUT_DIR, "water.json")
OUT_QC = os.path.join(OUT_DIR, "water_qc.png")

SPECK_LEN = 20.0          # drop polylines with raw arc length < this (px)
LAKE_MIN_AREA = 50        # drop pale components smaller than this (px^2)
DP_EPS = 2.0              # Douglas-Peucker tolerance (px)
GAP_RADIUS = 15.0         # endpoint-pair distance flagged as a probable dash gap

# ---------------------------------------------------------------- masks

def load_masks():
    im = Image.open(SRC).convert("RGBA")
    arr = np.asarray(im)
    a = arr[..., 3] > 128
    s = arr[..., 0].astype(np.int32) + arr[..., 1] + arr[..., 2]
    dark = a & (s <= 500)   # river strokes  ~ (10,120,171)
    pale = a & (s > 500)    # lake fill      ~ (198,236,255)
    return im, dark, pale

# ---------------------------------------------------------------- thinning

def zhang_suen(mask):
    img = mask.astype(np.uint8).copy()
    while True:
        changed = False
        for step in (0, 1):
            p = np.pad(img, 1)
            P2 = p[:-2, 1:-1]; P3 = p[:-2, 2:];  P4 = p[1:-1, 2:]
            P5 = p[2:, 2:];    P6 = p[2:, 1:-1]; P7 = p[2:, :-2]
            P8 = p[1:-1, :-2]; P9 = p[:-2, :-2]
            seq = [P2, P3, P4, P5, P6, P7, P8, P9, P2]
            A = np.zeros_like(img)
            for k in range(8):
                A += ((seq[k] == 0) & (seq[k + 1] == 1)).astype(np.uint8)
            B = (P2.astype(np.int16) + P3 + P4 + P5 + P6 + P7 + P8 + P9)
            if step == 0:
                cond = ((img == 1) & (B >= 2) & (B <= 6) & (A == 1)
                        & ((P2 & P4 & P6) == 0) & ((P4 & P6 & P8) == 0))
            else:
                cond = ((img == 1) & (B >= 2) & (B <= 6) & (A == 1)
                        & ((P2 & P4 & P8) == 0) & ((P2 & P6 & P8) == 0))
            if cond.any():
                img[cond] = 0
                changed = True
        if not changed:
            return img.astype(bool)

# ---------------------------------------------------------------- graph trace

OFFS = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]

def trace_skeleton(skel):
    """Trace 8-connected skeleton into paths; junction/end pixels become
    shared polyline endpoints. Returns list of [(x,y)...] pixel paths."""
    ys, xs = np.nonzero(skel)
    pix = set(zip(xs.tolist(), ys.tolist()))

    def nbrs(p):
        return [(p[0] + dx, p[1] + dy) for dx, dy in OFFS
                if (p[0] + dx, p[1] + dy) in pix]

    deg = {p: len(nbrs(p)) for p in pix}
    nodes = {p for p in pix if deg[p] != 2}
    consumed = set()   # directed pixel steps
    paths = []

    def walk(p, q):
        path = [p, q]
        consumed.add((p, q)); consumed.add((q, p))
        prev, cur = p, q
        while cur not in nodes:
            nxt = [n for n in nbrs(cur) if n != prev and (cur, n) not in consumed]
            if not nxt:
                break
            n = nxt[0]
            consumed.add((cur, n)); consumed.add((n, cur))
            path.append(n)
            prev, cur = cur, n
        return path

    for p in sorted(nodes):
        for q in nbrs(p):
            if (p, q) not in consumed:
                paths.append(walk(p, q))

    covered = set()
    for path in paths:
        covered.update(path)
    remaining = pix - covered - nodes
    while remaining:                     # pure cycles (no junction/endpoint)
        start = remaining.pop()
        nb = [n for n in nbrs(start) if n in remaining or n == start]
        if not nb:
            continue
        path = [start]
        prev, cur = start, nb[0]
        while cur != start:
            path.append(cur)
            remaining.discard(cur)
            nxt = [n for n in nbrs(cur) if n != prev]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
        path.append(start)
        paths.append(path)
    return paths, nodes, deg

# ---------------------------------------------------------------- simplify

def dp_simplify(pts, eps):
    if len(pts) < 3:
        return list(pts)
    pts_np = np.asarray(pts, dtype=np.float64)
    keep = np.zeros(len(pts), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        a, b = pts_np[i], pts_np[j]
        ab = b - a
        L = math.hypot(*ab)
        seg = pts_np[i + 1:j]
        if L == 0:
            d = np.hypot(*(seg - a).T)
        else:
            d = np.abs(ab[0] * (seg[:, 1] - a[1]) - ab[1] * (seg[:, 0] - a[0])) / L
        k = int(np.argmax(d))
        if d[k] > eps:
            keep[i + 1 + k] = True
            stack.append((i, i + 1 + k))
            stack.append((i + 1 + k, j))
    return [tuple(p) for p in np.asarray(pts)[keep]]

# ---------------------------------------------------------------- graph cleanup

CONTRACT_LEN = 4.5   # micro-edges shorter than this get node-contracted

def clean_graph(paths, min_len):
    """1) Contract micro-edges (<CONTRACT_LEN px) via union-find so clusters of
    staircase 'junction' pixels become ONE junction node; 2) prune short
    dead-end spurs; 3) dissolve degree-2 nodes by concatenating edges.
    Genuine short junction-junction connectors above CONTRACT_LEN are kept.
    Returns list of merged pixel paths (junctions = shared endpoints)."""
    edges = [list(p) for p in paths if len(p) >= 2]

    # --- union-find over node coords ---
    parent = {}

    def find(x):
        while parent.get(x, x) != x:
            parent[x] = parent.get(parent[x], parent[x])
            x = parent[x]
        return x

    def union(x, y):
        rx, ry = find(x), find(y)
        if rx != ry:
            parent[rx] = ry

    deg0 = {}
    for p in edges:
        deg0[p[0]] = deg0.get(p[0], 0) + 1
        deg0[p[-1]] = deg0.get(p[-1], 0) + 1
    for p in edges:
        # contract staircase micro-edges INSIDE the network only; isolated
        # micro-fragments (dashed strokes) must survive for the bridging pass
        if (arc_len(p) <= CONTRACT_LEN and p[0] != p[-1]
                and (deg0[p[0]] > 1 or deg0[p[-1]] > 1)):
            union(p[0], p[-1])

    # canonical coordinate per cluster = centroid-nearest member
    members = {}
    for p in edges:
        for e in (p[0], p[-1]):
            members.setdefault(find(e), set()).add(e)
    canon = {}
    for root, pts in members.items():
        cx = sum(q[0] for q in pts) / len(pts)
        cy = sum(q[1] for q in pts) / len(pts)
        canon[root] = min(pts, key=lambda q: (q[0] - cx) ** 2 + (q[1] - cy) ** 2)

    def snap(path):
        a, b = canon[find(path[0])], canon[find(path[-1])]
        out = list(path)
        if out[0] != a:
            out.insert(0, a)
        if out[-1] != b:
            out.append(b)
        return out

    new_edges = []
    for p in edges:
        ra, rb = find(p[0]), find(p[-1])
        if ra == rb and arc_len(p) <= max(CONTRACT_LEN * 2, 8.0):
            continue  # contracted micro-edge / micro-loop inside one junction
        new_edges.append(snap(p))
    edges = new_edges

    # --- prune spurs + dissolve deg-2 nodes to fixpoint ---
    for _ in range(50):
        changed = False
        deg = {}
        for p in edges:
            deg[p[0]] = deg.get(p[0], 0) + 1
            deg[p[-1]] = deg.get(p[-1], 0) + 1

        kept = []
        for p in edges:
            L = arc_len(p)
            free_a, free_b = deg[p[0]] == 1, deg[p[-1]] == 1
            if L < min_len and (free_a != free_b):
                changed = True          # short hair hanging off the network
                continue
            if p[0] == p[-1] and L < min_len:
                changed = True          # tiny self-loop
                continue
            kept.append(p)
        edges = kept

        inc = {}
        for i, p in enumerate(edges):
            inc.setdefault(p[0], []).append(i)
            if p[-1] != p[0]:
                inc.setdefault(p[-1], []).append(i)
        merged = set()
        for node, idxs in inc.items():
            if len(idxs) != 2 or idxs[0] == idxs[1]:
                continue
            i, j = idxs
            if i in merged or j in merged:
                continue
            p1, p2 = edges[i], edges[j]
            if p1[0] == node:
                p1 = p1[::-1]
            if p1[-1] != node or (p2[0] != node and p2[-1] != node):
                continue
            if p2[-1] == node:
                p2 = p2[::-1]
            edges[i] = p1 + p2[1:]
            merged.add(j)
            changed = True
        if merged:
            edges = [p for i, p in enumerate(edges) if i not in merged]
        if not changed:
            break

    # drop residual tiny isolated pieces (keep >= min_isolated so dash
    # fragments survive until the bridging pass)
    min_isolated = 3.0
    deg = {}
    for p in edges:
        deg[p[0]] = deg.get(p[0], 0) + 1
        deg[p[-1]] = deg.get(p[-1], 0) + 1
    return [p for p in edges
            if not (arc_len(p) < min_isolated and deg[p[0]] == 1 and deg[p[-1]] == 1)]

# ---------------------------------------------------------------- gap bridging

def out_tangent(path, at_end):
    """Unit outward direction at a path end (True=tail, False=head)."""
    if at_end:
        a, b = path[max(0, len(path) - 9)], path[-1]
    else:
        a, b = path[min(8, len(path) - 1)], path[0]
    d = (b[0] - a[0], b[1] - a[1])
    n = math.hypot(*d) or 1.0
    return (d[0] / n, d[1] / n)

def bridge_gaps(paths, radius, min_cos=0.25):
    """Greedily join free path ends within `radius` px when the joining
    segment roughly continues both strokes (dashed-stroke healing).
    Returns (paths, bridges) where bridges = [(pt_a, pt_b, dist)]."""
    paths = [list(p) for p in paths]
    bridges = []
    while True:
        # free ends: coordinate used by exactly one open-path end
        use = {}
        for i, p in enumerate(paths):
            if p[0] == p[-1]:
                continue
            for at_end in (False, True):
                e = p[-1] if at_end else p[0]
                use.setdefault(e, []).append((i, at_end))
        free = [(e, v[0]) for e, v in use.items() if len(v) == 1]
        best = None
        for i in range(len(free)):
            for j in range(i + 1, len(free)):
                (ea, (pa, ta)), (eb, (pb, tb)) = free[i], free[j]
                if pa == pb:
                    continue
                d = math.dist(ea, eb)
                if d == 0 or d > radius:
                    continue
                v = ((eb[0] - ea[0]) / d, (eb[1] - ea[1]) / d)
                ca = out_tangent(paths[pa], ta)
                cb = out_tangent(paths[pb], tb)
                if (ca[0] * v[0] + ca[1] * v[1]) < min_cos:
                    continue
                if (cb[0] * -v[0] + cb[1] * -v[1]) < min_cos:
                    continue
                if best is None or d < best[0]:
                    best = (d, pa, ta, pb, tb, ea, eb)
        if best is None:
            return paths, bridges
        d, pa, ta, pb, tb, ea, eb = best
        A = paths[pa] if ta else paths[pa][::-1]      # ends at ea
        B = paths[pb][::-1] if tb else paths[pb]      # starts at eb
        joined = A + B
        bridges.append((ea, eb, round(d, 1)))
        for idx in sorted((pa, pb), reverse=True):
            paths.pop(idx)
        paths.append(joined)

# ---------------------------------------------------------------- lake snap

def snap_ends_to_lakes(paths, lake_polys, max_d=12.0):
    """Extend open river ends onto the nearest lake polygon edge when the
    end already sits within max_d px of it. Returns snap count."""
    def nearest_on_poly(pt):
        best = (1e18, None)
        for poly in lake_polys:
            n = len(poly)
            for k in range(n):
                a, b = poly[k], poly[(k + 1) % n]
                abx, aby = b[0] - a[0], b[1] - a[1]
                L2 = abx * abx + aby * aby
                t = 0.0 if L2 == 0 else max(0.0, min(1.0,
                    ((pt[0] - a[0]) * abx + (pt[1] - a[1]) * aby) / L2))
                q = (a[0] + t * abx, a[1] + t * aby)
                d2 = (pt[0] - q[0]) ** 2 + (pt[1] - q[1]) ** 2
                if d2 < best[0]:
                    best = (d2, (int(round(q[0])), int(round(q[1]))))
        return math.sqrt(best[0]), best[1]

    use = {}
    for p in paths:
        if p[0] != p[-1]:
            use[p[0]] = use.get(p[0], 0) + 1
            use[p[-1]] = use.get(p[-1], 0) + 1
    snapped = 0
    for p in paths:
        if p[0] == p[-1]:
            continue
        for at_end in (False, True):
            e = p[-1] if at_end else p[0]
            if use.get(e, 0) != 1:
                continue
            d, q = nearest_on_poly(e)
            if 0 < d <= max_d and q is not None and q != e:
                if at_end:
                    p.append(q)
                else:
                    p.insert(0, q)
                snapped += 1
    return snapped

def arc_len(pts):
    return float(sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)))

# ---------------------------------------------------------------- lake outline

def moore_trace(mask):
    """Boundary of a single-component bool mask, as ordered pixel list."""
    ys, xs = np.nonzero(mask)
    i = np.lexsort((xs, ys))[0]              # topmost, then leftmost
    start = (int(xs[i]), int(ys[i]))
    offs = [(-1, 0), (-1, -1), (0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1)]
    H, W = mask.shape

    def inside(p):
        return 0 <= p[0] < W and 0 <= p[1] < H and mask[p[1], p[0]]

    boundary = [start]
    prev = (start[0] - 1, start[1])          # W of start is guaranteed outside
    cur = start
    for _ in range(8 * len(xs) + 16):        # hard safety bound
        dx, dy = prev[0] - cur[0], prev[1] - cur[1]
        try:
            k = offs.index((dx, dy))
        except ValueError:
            k = 0
        found = None
        for j in range(1, 9):
            o = offs[(k + j) % 8]
            cand = (cur[0] + o[0], cur[1] + o[1])
            if inside(cand):
                found = cand
                po = offs[(k + j - 1) % 8]
                prev = (cur[0] + po[0], cur[1] + po[1])
                break
        if found is None:
            break                            # isolated pixel
        cur = found
        if cur == start and len(boundary) > 2:
            break
        boundary.append(cur)
    return boundary

# ---------------------------------------------------------------- main

def main():
    im, dark, pale = load_masks()
    W, H = im.size
    issues = []

    # --- lakes first (river ends snap onto their outlines) ---
    lake_polylines = []
    lake_polys = []
    lbl, n = ndimage.label(pale, structure=np.ones((3, 3), int))
    areas = ndimage.sum_labels(np.ones_like(lbl), lbl, index=range(1, n + 1))
    lake_dropped = 0
    for ci in range(1, n + 1):
        area = int(areas[ci - 1])
        if area < LAKE_MIN_AREA:
            lake_dropped += 1
            continue
        comp = lbl == ci
        boundary = moore_trace(comp)
        if arc_len(boundary + [boundary[0]]) < SPECK_LEN:
            lake_dropped += 1
            continue
        simp = dp_simplify(boundary + [boundary[0]], DP_EPS)
        if len(simp) > 1 and simp[0] == simp[-1]:
            simp = simp[:-1]
        if len(simp) < 3:
            lake_dropped += 1
            continue
        cdt = ndimage.distance_transform_edt(comp)
        lake_polys.append([(int(x), int(y)) for x, y in simp])
        lake_polylines.append({
            "pts": [[int(x), int(y)] for x, y in simp],
            "widthPx": round(float(2.0 * cdt.max()), 2),   # max inscribed width
            "closed": True,
            "kind": "lake",
            "lenPx": round(arc_len(boundary + [boundary[0]]), 1),
            "areaPx": area,
        })
        filled = ndimage.binary_fill_holes(comp)
        holes = int(ndimage.label(filled & ~comp)[1])
        if holes:
            issues.append(f"lake component (area {area}) has {holes} interior hole(s)/island(s) not emitted")

    # --- rivers ---
    river_dil = ndimage.binary_dilation(dark, structure=np.ones((3, 3), bool))
    skel = zhang_suen(river_dil)
    paths, nodes, deg = trace_skeleton(skel)
    raw_fragments = len(paths)
    dt = ndimage.distance_transform_edt(dark)
    pale_dist = ndimage.distance_transform_edt(~pale)

    # shoreline duplicates: skeleton of the lake's outline stroke hugs the
    # pale fill; the lake polygon already captures that shape -> drop.
    shoreline_dropped = 0
    kept_paths = []
    for path in paths:
        near = sum(1 for x, y in path if pale_dist[y, x] <= 8.0)
        if len(path) >= 2 and near / len(path) > 0.7 and arc_len(path) > 10:
            shoreline_dropped += 1
            continue
        kept_paths.append(path)

    merged = clean_graph(kept_paths, SPECK_LEN)

    # heal dashed strokes: join free ends whose directions line up
    merged, bridges = bridge_gaps(merged, radius=45.0)
    if bridges:
        issues.append(f"bridged {len(bridges)} dashed-stroke gap(s) (max {max(b[2] for b in bridges)}px): "
                      + "; ".join(f"({a[0]},{a[1]})->({b[0]},{b[1]}) {d}px" for a, b, d in bridges[:10]))

    # final speck drop (isolated open fragments under threshold)
    speck_dropped = 0
    final_paths = []
    for p in merged:
        if arc_len(p) < SPECK_LEN and p[0] != p[-1]:
            deg2 = sum(1 for q in merged if q is not p and (p[0] in (q[0], q[-1]) or p[-1] in (q[0], q[-1])))
            if deg2 == 0:
                speck_dropped += 1
                continue
        final_paths.append(p)

    snapped = snap_ends_to_lakes(final_paths, lake_polys, max_d=12.0)
    if snapped:
        issues.append(f"snapped {snapped} river end(s) onto the lake outline (were <=12px short of it)")

    polylines = []
    dropped = raw_fragments - shoreline_dropped - len(final_paths)  # net specks/spurs
    for path in final_paths:
        L = arc_len(path)
        widths = [dt[y, x] for x, y in path
                  if 0 <= y < dt.shape[0] and 0 <= x < dt.shape[1] and dt[y, x] > 0]
        wpx = float(2.0 * np.median(widths)) if widths else 2.0
        simp = dp_simplify(path, DP_EPS)
        closed = path[0] == path[-1] and len(path) > 3
        polylines.append({
            "pts": [[int(x), int(y)] for x, y in simp],
            "widthPx": round(wpx, 2),
            "closed": bool(closed),
            "kind": "river",
            "lenPx": round(L, 1),
        })

    # gap sniff: FREE endpoints (coord used by exactly one polyline end) that
    # sit close to another free endpoint = probable dash/antialias gap
    end_use = {}
    for pl in polylines:
        if not pl["closed"]:
            for e in (tuple(pl["pts"][0]), tuple(pl["pts"][-1])):
                end_use[e] = end_use.get(e, 0) + 1
    free = [e for e, n in end_use.items() if n == 1]
    gaps = []
    for i in range(len(free)):
        for j in range(i + 1, len(free)):
            d = math.dist(free[i], free[j])
            if 0 < d <= GAP_RADIUS:
                gaps.append({"a": list(free[i]), "b": list(free[j]),
                             "distPx": round(d, 1)})
    if gaps:
        issues.append(f"{len(gaps)} endpoint pair(s) within {GAP_RADIUS}px "
                      f"(possible dash/antialias gaps, left unbridged): "
                      + "; ".join(f"({g['a'][0]},{g['a'][1]})~({g['b'][0]},{g['b'][1]}) d={g['distPx']}"
                                  for g in gaps[:8]))

    polylines.extend(lake_polylines)
    total_len = round(sum(p["lenPx"] for p in polylines), 1)
    out = {"layer": "water", "imageSize": [W, H], "polylines": polylines}
    with open(OUT_JSON, "w") as f:
        json.dump(out, f)

    # --- QC render ---
    base = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    base.alpha_composite(im)
    faded = Image.blend(Image.new("RGBA", (W, H), (255, 255, 255, 255)), base, 0.25)
    qc = faded.convert("RGB")
    d = ImageDraw.Draw(qc)
    import colorsys
    for i, pl in enumerate(polylines):
        hue = (i * 0.6180339887) % 1.0
        r, g, b = [int(c * 255) for c in colorsys.hsv_to_rgb(hue, 0.9, 0.75 if pl["kind"] == "river" else 0.95)]
        pts = [tuple(p) for p in pl["pts"]]
        if pl["closed"]:
            pts = pts + [pts[0]]
        d.line(pts, fill=(r, g, b), width=1)
        if not pl["closed"]:
            for e in (pts[0], pts[-1]):
                d.ellipse([e[0] - 2, e[1] - 2, e[0] + 2, e[1] + 2], outline=(r, g, b))
    for g in gaps:
        cx = (g["a"][0] + g["b"][0]) / 2; cy = (g["a"][1] + g["b"][1]) / 2
        d.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], outline=(255, 0, 255), width=2)
    for a, b, _ in bridges:   # healed dash gaps, magenta
        d.line([a, b], fill=(255, 0, 200), width=3)
    qc.save(OUT_QC)

    rivers = [p for p in polylines if p["kind"] == "river"]
    lakes = [p for p in polylines if p["kind"] == "lake"]
    wh = {}
    for p in rivers:
        k = str(int(round(p["widthPx"])))
        wh[k] = wh.get(k, 0) + 1
    summary = {
        "layer": "water",
        "count": len(polylines),
        "rivers": len(rivers),
        "lakes": len(lakes),
        "totalLenPx": total_len,
        "riverLenPx": round(sum(p["lenPx"] for p in rivers), 1),
        "widthClasses": wh,
        "droppedSpecks": {"riverFragmentsPruned": dropped, "lake": lake_dropped,
                          "shorelineDuplicates": shoreline_dropped,
                          "isolatedSpecks": speck_dropped},
        "rawSkeletonFragments": raw_fragments,
        "bridgedGaps": len(bridges),
        "snappedToLake": snapped,
        "gapCandidates": len(gaps),
        "skeletonNodes": {"endpoints": sum(1 for p in nodes if deg[p] == 1),
                          "junctions": sum(1 for p in nodes if deg[p] >= 3)},
        "lakeAreasPx": sorted((p.get("areaPx", 0) for p in lakes), reverse=True),
        "issues": issues,
    }
    with open(os.path.join(OUT_DIR, "water_summary.json"), "w") as f:
        json.dump(summary, f, indent=1)
    print(json.dumps(summary, indent=1))

if __name__ == "__main__":
    main()
