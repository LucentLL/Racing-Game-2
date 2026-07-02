"""Vectorize Maps/Minor Roads.png -> maplab/minor.json + minor_qc.png.

Pipeline: alpha mask -> dilate 1px -> Zhang-Suen skeleton (numpy) ->
graph trace (junction clusters = shared endpoints) -> dash bridging ->
speck/spur drop -> Douglas-Peucker eps=2 -> per-polyline median width
from distance transform (x2) of the ORIGINAL (undilated) mask.

Re-runnable; skeleton cached in minor_skel.npz (delete to force recompute,
or pass --fresh).
"""
import json, math, os, sys, time
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

SRC = r"C:/Users/mcgee/code/Racing-Game-2/Maps/Minor Roads.png"
OUT = r"C:/Users/mcgee/AppData/Local/Temp/claude/C--Users-mcgee-code-Racing-Game-2/efccc8c9-027c-4008-995a-66c949d75212/scratchpad/maplab"
CACHE = os.path.join(OUT, "minor_skel.npz")

DP_EPS = 2.0
SPECK_LEN = 20.0          # px arc length
BRIDGE_R = 28.0           # max gap to bridge between dangling ends (dash gaps ~16-24px)
BRIDGE_COS = math.cos(math.radians(50))
DIR_SAMPLE = 6            # pixels along path used to estimate end direction


# ---------------------------------------------------------------- skeleton
def zhang_suen(img_bool):
    """Vectorized Zhang-Suen thinning. img_bool: 2D bool. Returns bool."""
    img = img_bool.astype(np.uint8)
    it = 0
    while True:
        changed = False
        for step in (0, 1):
            p = np.pad(img, 1)
            P2 = p[:-2, 1:-1]; P3 = p[:-2, 2:]; P4 = p[1:-1, 2:]
            P5 = p[2:, 2:];    P6 = p[2:, 1:-1]; P7 = p[2:, :-2]
            P8 = p[1:-1, :-2]; P9 = p[:-2, :-2]
            B = (P2.astype(np.int16) + P3 + P4 + P5 + P6 + P7 + P8 + P9)
            seq = (P2, P3, P4, P5, P6, P7, P8, P9, P2)
            A = np.zeros(img.shape, np.int16)
            for k in range(8):
                A += ((seq[k] == 0) & (seq[k + 1] == 1))
            if step == 0:
                c3 = (P2 * P4 * P6) == 0
                c4 = (P4 * P6 * P8) == 0
            else:
                c3 = (P2 * P4 * P8) == 0
                c4 = (P2 * P6 * P8) == 0
            m = (img == 1) & (B >= 2) & (B <= 6) & (A == 1) & c3 & c4
            if m.any():
                img[m] = 0
                changed = True
        it += 1
        if not changed:
            break
    print(f"  zhang-suen: {it} iterations")
    return img.astype(bool)


# ---------------------------------------------------------------- tracing
N8 = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))


def prune_redundant(sk):
    """Remove pixels whose set 8-neighbors form ONE 8-connected component.

    Such a pixel is redundant for connectivity (a 'braid'/staircase-diamond
    leftover of Zhang-Suen); removing it keeps the skeleton connected and
    collapses parallel threads so raw degree becomes a reliable junction
    detector. Endpoints (deg<2) are protected. Sequential until stable.
    """
    from collections import deque
    S = np.pad(sk, 1)
    def neighbors(y, x):
        return [(y + dy, x + dx) for dy, dx in N8 if S[y + dy, x + dx]]
    def onecomp(pix):
        if len(pix) < 2:
            return False
        pset = set(pix)
        seen = {pix[0]}
        st = [pix[0]]
        while st:
            a = st.pop()
            for dy, dx in N8:
                b = (a[0] + dy, a[1] + dx)
                if b in pset and b not in seen:
                    seen.add(b)
                    st.append(b)
        return len(seen) == len(pix)
    ys, xs = np.nonzero(S)
    q = deque(zip(ys.tolist(), xs.tolist()))
    inq = set(q)
    removed = 0
    while q:
        p = q.popleft()
        inq.discard(p)
        if not S[p]:
            continue
        n = neighbors(*p)
        if len(n) < 2:
            continue
        if onecomp(n):
            S[p] = False
            removed += 1
            for r in n:
                if r not in inq:
                    q.append(r)
                    inq.add(r)
    print(f"  prune: removed {removed} redundant braid px")
    return S[1:-1, 1:-1]

def trace(sk):
    """Trace skeleton (bool, padded by 1 border of False) into pixel paths.

    Returns list of dicts: {pix: [(y,x)...], d0: bool, d1: bool, closed: bool}
    d0/d1 = end is dangling (true skeleton endpoint, degree 1).
    Junction clusters are collapsed to one representative pixel so all
    incident polylines share the exact endpoint coordinate.
    """
    kern = np.array([[1, 1, 1], [1, 0, 1], [1, 1, 1]], np.uint8)
    deg = ndimage.convolve(sk.astype(np.uint8), kern, mode="constant")
    deg[~sk] = 0
    nodemask = sk & (deg != 2)

    # collapse adjacent node pixels into clusters
    lab, nlab = ndimage.label(nodemask, structure=np.ones((3, 3), np.uint8))
    reps = {}          # cluster id -> representative (y,x)
    cl_sizes = np.bincount(lab.ravel())
    if nlab:
        coms = ndimage.center_of_mass(nodemask, lab, range(1, nlab + 1))
    node_pixels_by_lab = {}
    ys, xs = np.nonzero(nodemask)
    for y, x in zip(ys.tolist(), xs.tolist()):
        node_pixels_by_lab.setdefault(lab[y, x], []).append((y, x))
    for li, pix in node_pixels_by_lab.items():
        cy, cx = coms[li - 1]
        reps[li] = min(pix, key=lambda p: (p[0] - cy) ** 2 + (p[1] - cx) ** 2)

    dangling_lab = set()   # cluster is a single degree-1 pixel => true end
    for li, pix in node_pixels_by_lab.items():
        if len(pix) == 1 and deg[pix[0]] == 1:
            dangling_lab.add(li)

    used = np.zeros_like(sk)          # visited interior (degree-2) pixels
    nn_edges = set()                  # node-node adjacency dedup
    paths = []

    isolated = int(((deg == 0) & sk).sum())

    for li, pix in node_pixels_by_lab.items():
        for n in pix:
            for dy, dx in N8:
                m = (n[0] + dy, n[1] + dx)
                if not sk[m]:
                    continue
                if nodemask[m]:
                    lm = lab[m]
                    if lm == li:
                        continue                    # inside same junction
                    e = frozenset((n, m))
                    if e in nn_edges:
                        continue
                    nn_edges.add(e)
                    paths.append(dict(pix=[reps[li], reps[lm]],
                                      d0=li in dangling_lab,
                                      d1=lm in dangling_lab, closed=False))
                    continue
                if used[m]:
                    continue
                # walk through degree-2 pixels
                path = [n, m]
                used[m] = True
                prev, cur = n, m
                while True:
                    nxt = None
                    for ddy, ddx in N8:
                        q = (cur[0] + ddy, cur[1] + ddx)
                        if sk[q] and q != prev:
                            if nodemask[q] or not used[q]:
                                nxt = q
                                if nodemask[q]:
                                    break
                    if nxt is None:
                        break
                    path.append(nxt)
                    if nodemask[nxt]:
                        break
                    used[nxt] = True
                    prev, cur = cur, nxt
                end = path[-1]
                if nodemask[end]:
                    le = lab[end]
                    if le == li and len(path) <= 4:
                        continue                    # tiny self-loop artifact
                    path[0] = reps[li]
                    path[-1] = reps[le]
                    paths.append(dict(pix=path, d0=li in dangling_lab,
                                      d1=le in dangling_lab, closed=False))
                else:
                    path[0] = reps[li]
                    paths.append(dict(pix=path, d0=li in dangling_lab,
                                      d1=True, closed=False))

    # pure cycles: degree-2 pixels never visited
    cyc = sk & (deg == 2) & ~used & ~nodemask
    ys, xs = np.nonzero(cyc)
    remaining = set(zip(ys.tolist(), xs.tolist()))
    ncycles = 0
    while remaining:
        start = next(iter(remaining))
        path = [start]
        remaining.discard(start)
        used[start] = True
        prev, cur = None, start
        while True:
            nxt = None
            for ddy, ddx in N8:
                q = (cur[0] + ddy, cur[1] + ddx)
                if sk[q] and q != prev and q in remaining:
                    nxt = q
                    break
            if nxt is None:
                break
            path.append(nxt)
            remaining.discard(nxt)
            used[nxt] = True
            prev, cur = cur, nxt
        path.append(start)              # close the ring
        paths.append(dict(pix=path, d0=False, d1=False, closed=True))
        ncycles += 1

    print(f"  trace: {len(paths)} raw paths, {nlab} junction clusters, "
          f"{ncycles} pure cycles, {isolated} isolated px dropped")
    return paths


# ---------------------------------------------------------------- helpers
def arclen(pix):
    a = np.asarray(pix, float)
    if len(a) < 2:
        return 0.0
    d = np.diff(a, axis=0)
    return float(np.hypot(d[:, 0], d[:, 1]).sum())


def end_dir(pix, end):
    """Outward unit direction at an end of a pixel path."""
    a = np.asarray(pix, float)
    k = min(DIR_SAMPLE, len(a) - 1)
    if k == 0:
        return np.array([0.0, 0.0])
    v = a[0] - a[k] if end == 0 else a[-1] - a[-1 - k]
    n = np.hypot(*v)
    return v / n if n else v


def bridge(paths):
    """Greedily join dangling ends within BRIDGE_R whose directions align.
    Returns (paths, bridge_segments[(y,x),(y,x)])."""
    ends = []          # (path_idx, end0or1, pt(y,x), outdir)
    for i, p in enumerate(paths):
        if p["closed"]:
            continue
        if p["d0"]:
            ends.append([i, 0, np.array(p["pix"][0], float), end_dir(p["pix"], 0)])
        if p["d1"]:
            ends.append([i, 1, np.array(p["pix"][-1], float), end_dir(p["pix"], 1)])
    cands = []
    for a in range(len(ends)):
        for b in range(a + 1, len(ends)):
            ia, ea, pa, da = ends[a]
            ib, eb, pb, db = ends[b]
            if ia == ib:
                continue
            v = pb - pa
            dist = float(np.hypot(*v))
            if dist > BRIDGE_R or dist == 0:
                continue
            u = v / dist
            aA = float(da @ u)
            aB = float(db @ -u)
            ok = aA >= BRIDGE_COS and aB >= BRIDGE_COS
            if not ok:
                # short dashes often start with a bend: if either path is a
                # short stub, demand alignment only from the longer side and
                # merely "not pointing away" from the stub.
                short = min(arclen(paths[ia]["pix"]),
                            arclen(paths[ib]["pix"])) < 50
                ok = short and max(aA, aB) >= BRIDGE_COS and min(aA, aB) > -0.3
            if not ok:
                continue
            cands.append((dist, a, b))
    cands.sort()
    used_end = set()
    joins = []          # (idxA, endA, idxB, endB)
    segs = []
    for dist, a, b in cands:
        if a in used_end or b in used_end:
            continue
        used_end.add(a); used_end.add(b)
        ia, ea, pa, _ = ends[a]
        ib, eb, pb, _ = ends[b]
        joins.append((ia, ea, ib, eb))
        segs.append((tuple(map(int, pa)), tuple(map(int, pb))))

    # merge joined paths (chains) via union-like stitching
    parent = list(range(len(paths)))
    merged = {i: paths[i] for i in range(len(paths))}
    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for ia, ea, ib, eb in joins:
        ra, rb = root(ia), root(ib)
        A, B = merged[ra], merged[rb]
        if ra == rb:
            A["closed"] = True     # path joined to itself -> ring
            A["d0"] = A["d1"] = False
            continue
        pa = A["pix"]; pb = B["pix"]
        # orient A so the joining end is its tail, B so joining end is head.
        # The join endpoints are the ORIGINAL path ends; after prior merges
        # they sit at head or tail of merged paths -- find by coordinate.
        ptA = tuple(paths[ia]["pix"][0 if ea == 0 else -1])
        ptB = tuple(paths[ib]["pix"][0 if eb == 0 else -1])
        if tuple(pa[0]) == ptA:
            pa = pa[::-1]; A["d0"], A["d1"] = A["d1"], A["d0"]
        if tuple(pb[-1]) == ptB:
            pb = pb[::-1]; B["d0"], B["d1"] = B["d1"], B["d0"]
        if tuple(pa[-1]) != ptA or tuple(pb[0]) != ptB:
            continue               # endpoint consumed by earlier join; skip
        merged[ra] = dict(pix=pa + pb, d0=A["d0"], d1=B["d1"], closed=False)
        parent[rb] = ra
        del merged[rb]
    out = list(merged.values())
    return out, segs


def douglas_peucker(pts, eps):
    a = np.asarray(pts, float)
    n = len(a)
    if n < 3:
        return a.tolist()
    keep = np.zeros(n, bool)
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        seg = a[j] - a[i]
        L = math.hypot(*seg)
        sub = a[i + 1:j] - a[i]
        if L == 0:
            d = np.hypot(sub[:, 0], sub[:, 1])
        else:
            d = np.abs(seg[0] * sub[:, 1] - seg[1] * sub[:, 0]) / L
        k = int(np.argmax(d))
        if d[k] > eps:
            keep[i + 1 + k] = True
            stack.append((i, i + 1 + k))
            stack.append((i + 1 + k, j))
    return a[keep].tolist()


# ---------------------------------------------------------------- main
def main():
    t0 = time.time()
    im = Image.open(SRC)
    arr = np.asarray(im)
    H, W = arr.shape[:2]
    print(f"loaded {W}x{H} mode={im.mode}")
    mask = arr[:, :, 3] > 128

    dil = ndimage.binary_dilation(mask, structure=np.ones((3, 3), bool))

    if os.path.exists(CACHE) and "--fresh" not in sys.argv:
        sk = np.load(CACHE)["sk"]
        print("  skeleton loaded from cache")
    else:
        print("  skeletonizing...")
        sk = zhang_suen(dil)
        np.savez_compressed(CACHE, sk=sk)
    sk = prune_redundant(sk)
    print(f"  skeleton px: {int(sk.sum())}  ({time.time()-t0:.1f}s)")

    # pad by 1 so tracing never needs bounds checks
    skp = np.pad(sk, 1)
    paths = trace(skp)
    # unpad coords
    for p in paths:
        p["pix"] = [(y - 1, x - 1) for (y, x) in p["pix"]]

    n_before = len(paths)
    paths, bridge_segs = bridge(paths)
    print(f"  bridging: {n_before} -> {len(paths)} paths, "
          f"{len(bridge_segs)} gaps bridged")

    # drop specks & spurs: arc<SPECK_LEN with at least one dangling end
    kept, dropped = [], 0
    for p in paths:
        L = arclen(p["pix"])
        if len(p["pix"]) < 2:
            dropped += 1
            continue
        if L < SPECK_LEN and (p["d0"] or p["d1"] or len(p["pix"]) < 3):
            dropped += 1
            continue
        p["len"] = L
        kept.append(p)
    print(f"  dropped {dropped} specks/spurs (<{SPECK_LEN}px, dangling)")

    # ---- T-snap: dangling ends within SNAP_R of ANOTHER polyline get
    # extended to touch it (unclosed T-junctions / tiny dash remnants).
    SNAP_R, BORDER = 14.0, 6
    from scipy.spatial import cKDTree
    allpix, allpid = [], []
    for i, p in enumerate(kept):
        for (y, x) in p["pix"]:
            allpix.append((y, x))
            allpid.append(i)
    tree = cKDTree(np.array(allpix, float))
    allpid = np.array(allpid)
    snaps = []
    for i, p in enumerate(kept):
        for end, flag in ((0, "d0"), (-1, "d1")):
            if not p[flag]:
                continue
            e = np.array(p["pix"][end], float)
            if (e[0] < BORDER or e[0] > H - 1 - BORDER or
                    e[1] < BORDER or e[1] > W - 1 - BORDER):
                continue
            idx = tree.query_ball_point(e, SNAP_R)
            best, bd = None, 1e9
            for j in idx:
                if allpid[j] == i:
                    continue
                d = float(np.hypot(*(np.array(allpix[j], float) - e)))
                if 0.5 < d < bd:
                    bd, best = d, allpix[j]
            if best is not None:
                if end == 0:
                    p["pix"].insert(0, best)
                    p["d0"] = False
                else:
                    p["pix"].append(best)
                    p["d1"] = False
                p["len"] = arclen(p["pix"])
                snaps.append([int(e[1]), int(e[0]), round(bd, 1)])
    print(f"  t-snap: {len(snaps)} dangling ends snapped to nearby polylines")

    # widths from ORIGINAL mask distance transform
    dt2 = ndimage.distance_transform_edt(mask) * 2.0
    dt2d = ndimage.distance_transform_edt(dil) * 2.0 - 2.0   # fallback
    for p in kept:
        ys = np.array([q[0] for q in p["pix"]])
        xs = np.array([q[1] for q in p["pix"]])
        ok = (ys >= 0) & (ys < H) & (xs >= 0) & (xs < W)
        w = dt2[ys[ok], xs[ok]]
        w = w[w > 0]
        if not len(w):
            w = dt2d[ys[ok], xs[ok]]
            w = w[w > 0]
        p["widthPx"] = round(float(np.median(w)) if len(w) else 1.0, 2)

    # closed if ring or ends coincide
    polylines = []
    total_len = 0.0
    degenerate = 0
    kept2 = []
    for p in kept:
        pts = [[float(x), float(y)] for (y, x) in p["pix"]]     # -> x,y
        closed = p["closed"]
        if not closed and len(pts) > 3:
            if math.hypot(pts[0][0] - pts[-1][0], pts[0][1] - pts[-1][1]) <= 2:
                closed = True
        simp = douglas_peucker(pts, DP_EPS)
        simp = [[round(x, 1), round(y, 1)] for x, y in simp]
        slen = sum(math.hypot(simp[k+1][0]-simp[k][0], simp[k+1][1]-simp[k][1])
                   for k in range(len(simp)-1))
        if len(simp) < 2 or slen < 1.0:
            degenerate += 1          # collapsed junction micro-loop etc.
            continue
        total_len += p["len"]
        polylines.append(dict(pts=simp, widthPx=p["widthPx"], closed=closed))
        kept2.append(p)
    kept = kept2
    if degenerate:
        print(f"  dropped {degenerate} degenerate (zero-length) polylines")

    out = dict(layer="minor", imageSize=[W, H], polylines=polylines)
    with open(os.path.join(OUT, "minor.json"), "w") as f:
        json.dump(out, f)

    # ------------------------------------------------------------ QC render
    bg = Image.new("RGB", (W, H), (255, 255, 255))
    bg.paste(im.convert("RGB"), mask=im.getchannel("A"))
    bg = Image.blend(bg, Image.new("RGB", (W, H), (255, 255, 255)), 0.72)
    dr = ImageDraw.Draw(bg)
    palette = [(228, 26, 28), (55, 126, 184), (77, 175, 74), (152, 78, 163),
               (255, 127, 0), (166, 86, 40), (0, 0, 0), (247, 129, 191),
               (0, 158, 115), (213, 94, 0), (86, 60, 200), (120, 120, 0)]
    for i, pl in enumerate(polylines):
        col = palette[i % len(palette)]
        dr.line([tuple(q) for q in pl["pts"]], fill=col, width=1)
    for (a, b) in bridge_segs:
        dr.line([(a[1], a[0]), (b[1], b[0])], fill=(255, 0, 255), width=4)
    qc_path = os.path.join(OUT, "minor_qc.png")
    bg.save(qc_path)
    bg.resize((W // 3, H // 3), Image.LANCZOS).save(
        os.path.join(OUT, "minor_qc_small.png"))

    # ------------------------------------------------------------ report
    widths = np.array([pl["widthPx"] for pl in polylines])
    lens = np.array([p["len"] for p in kept])
    # remaining dangling ends near OTHER-polyline geometry = suspicious gaps
    suspects = []
    endpts = []
    for i, (p, pl) in enumerate(zip(kept, polylines)):
        if p["d0"]:
            endpts.append((i, pl["pts"][0]))
        if p["d1"]:
            endpts.append((i, pl["pts"][-1]))
    allpts = np.array([q for pl in polylines for q in pl["pts"]], float)
    ptpid = np.array([i for i, pl in enumerate(polylines) for _ in pl["pts"]])
    for i, e in endpts:
        d = np.hypot(allpts[:, 0] - e[0], allpts[:, 1] - e[1])
        d[ptpid == i] = 1e9
        if d.min() < 25:
            suspects.append([round(e[0]), round(e[1]), round(float(d.min()), 1)])

    rep = dict(
        polylineCount=len(polylines),
        totalLenPx=round(total_len, 0),
        droppedSpecks=dropped,
        bridgedGaps=len(bridge_segs),
        tSnapped=len(snaps),
        snapPts=snaps,
        bridgeSegs=[[[int(a[1]), int(a[0])], [int(b[1]), int(b[0])]]
                    for a, b in bridge_segs],
        widthPx=dict(min=float(widths.min()), p25=float(np.percentile(widths, 25)),
                     p50=float(np.percentile(widths, 50)),
                     p75=float(np.percentile(widths, 75)),
                     p90=float(np.percentile(widths, 90)),
                     max=float(widths.max())),
        lenPx=dict(p50=float(np.percentile(lens, 50)), max=float(lens.max())),
        closedCount=sum(1 for pl in polylines if pl["closed"]),
        danglingEndsNearGeometry=suspects[:40],
        danglingSuspectCount=len(suspects),
        elapsedSec=round(time.time() - t0, 1),
    )
    with open(os.path.join(OUT, "minor_trace_report.json"), "w") as f:
        json.dump(rep, f, indent=1)
    print(json.dumps(rep, indent=1)[:3000])


if __name__ == "__main__":
    main()
