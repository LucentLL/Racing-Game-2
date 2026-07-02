"""Fit ONE transform image-px -> world-tile from traced highways vs hand-traced baseline.

Method: bbox similarity init -> ICP (closest point, similarity via Umeyama) on I-485;
if similarity residual is poor, refine with full affine ICP (I-485 + I-77 jointly).
Then apply the final transform to hw77/hw485/minor/water and write world_*.json.

Re-runnable: py -3 fit_transform.py
"""
import json, math, os
import numpy as np
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))

def load_polys(name):
    d = json.load(open(os.path.join(HERE, name)))
    return d

def landmark_pts(row):
    # [w, isMajor, name, z, x1,y1,...]
    c = row[4:]
    return np.array(c, float).reshape(-1, 2)

def resample(pts, spacing, closed=False):
    pts = np.asarray(pts, float)
    if closed and not np.allclose(pts[0], pts[-1]):
        pts = np.vstack([pts, pts[0]])
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    total = s[-1]
    if total < 1e-9:
        return pts[:1]
    n = max(2, int(total / spacing) + 1)
    t = np.linspace(0, total, n)
    x = np.interp(t, s, pts[:, 0]); y = np.interp(t, s, pts[:, 1])
    return np.column_stack([x, y])

def umeyama(src, dst):
    """similarity fit dst ~= s*R@src + t. Returns s, R(2x2), t(2,)."""
    ms, md = src.mean(0), dst.mean(0)
    sc, dc = src - ms, dst - md
    cov = dc.T @ sc / len(src)
    U, D, Vt = np.linalg.svd(cov)
    S = np.eye(2)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        S[1, 1] = -1
    R = U @ S @ Vt
    var = (sc ** 2).sum() / len(src)
    s = np.trace(np.diag(D) @ S) / var
    t = md - s * R @ ms
    return s, R, t

def apply_sim(pts, s, R, t):
    return (s * (R @ pts.T)).T + t

def affine_fit(src, dst):
    """dst ~= A@src + b, full 6-param least squares. Returns M(2x3)."""
    X = np.column_stack([src, np.ones(len(src))])
    M, *_ = np.linalg.lstsq(X, dst, rcond=None)
    return M.T  # 2x3

def apply_aff(pts, M):
    return pts @ M[:, :2].T + M[:, 2]

def residual_stats(d):
    return dict(mean=float(np.mean(d)), median=float(np.median(d)),
                p95=float(np.percentile(d, 95)), max=float(np.max(d)))

# ---------------- load data ----------------
lm = json.load(open(os.path.join(HERE, "landmarks.json")))
base485 = landmark_pts(lm["I-485"])
base77 = [landmark_pts(lm["I-77 N"]), landmark_pts(lm["I-77 S"])]

hw485 = load_polys("hw485.json")
hw77 = load_polys("hw77.json")

SP_TILE = 2.0   # resample spacing in tiles for baseline
img485 = resample(hw485["polylines"][0]["pts"], 4.0, closed=True)
base485_d = resample(base485, SP_TILE, closed=True)
base77_d = np.vstack([resample(p, SP_TILE) for p in base77])
img77_all = np.vstack([resample(p["pts"], 4.0, closed=p.get("closed", False))
                       for p in hw77["polylines"]])

# ---------------- bbox similarity init ----------------
def bbox(p): return p.min(0), p.max(0)
(i0, i1), (b0, b1) = bbox(img485), bbox(base485_d)
sx = (b1[0] - b0[0]) / (i1[0] - i0[0])
sy = (b1[1] - b0[1]) / (i1[1] - i0[1])
s0 = (sx + sy) / 2
R0 = np.eye(2)
t0 = (b0 + b1) / 2 - s0 * (i0 + i1) / 2
print(f"bbox init: sx={sx:.4f} sy={sy:.4f} (aniso ratio {sx/sy:.3f}) s0={s0:.4f} t0={t0}")

# ---------------- ICP similarity on I-485 ----------------
tree485 = cKDTree(base485_d)
s, R, t = s0, R0, t0
for it in range(20):
    cur = apply_sim(img485, s, R, t)
    d, idx = tree485.query(cur)
    # trim worst 5% to be robust to hand-trace outliers
    keep = d <= np.percentile(d, 95)
    s, R, t = umeyama(img485[keep], base485_d[idx[keep]])
cur = apply_sim(img485, s, R, t)
d485_sim, _ = tree485.query(cur)
rot_sim = math.degrees(math.atan2(R[1, 0], R[0, 0]))
print(f"similarity ICP: s={s:.5f} rot={rot_sim:.3f}deg t=({t[0]:.1f},{t[1]:.1f})")
print("  I-485 residual (tiles):", residual_stats(d485_sim))

# I-77 validation under similarity (baseline -> nearest transformed image pt)
tree77img_sim = cKDTree(apply_sim(img77_all, s, R, t))
d77_sim, _ = tree77img_sim.query(base77_d)
print("  I-77 residual (tiles):", residual_stats(d77_sim))

# ---------------- affine ICP (joint I-485 + I-77) ----------------
M = np.column_stack([s * R, t])  # start from similarity
tree77b = cKDTree(base77_d)
for it in range(20):
    cur485 = apply_aff(img485, M)
    d1, i1x = tree485.query(cur485)
    k1 = d1 <= np.percentile(d1, 95)
    # I-77 pairs: baseline pt -> nearest transformed image pt (image side has extra roads)
    treeimg = cKDTree(apply_aff(img77_all, M))
    d2, i2x = treeimg.query(base77_d)
    k2 = d2 <= np.percentile(d2, 90)  # trim harder: extra roads / branch mismatch
    src = np.vstack([img485[k1], img77_all[i2x[k2]]])
    dst = np.vstack([base485_d[i1x[k1]], base77_d[k2]])
    M = affine_fit(src, dst)

d485_aff, _ = tree485.query(apply_aff(img485, M))
treeimg = cKDTree(apply_aff(img77_all, M))
d77_aff, _ = treeimg.query(base77_d)
print("affine ICP: M=", M.tolist())
print("  I-485 residual (tiles):", residual_stats(d485_aff))
print("  I-77 residual (tiles):", residual_stats(d77_aff))

# decompose affine
A = M[:, :2]
sxa = np.linalg.norm(A[:, 0]); sya = np.linalg.norm(A[:, 1])
rot_aff = math.degrees(math.atan2(A[1, 0], A[0, 0]))
shear = float(A[:, 0] @ A[:, 1] / (sxa * sya))
print(f"  decomposed: sx={sxa:.4f} sy={sya:.4f} rot={rot_aff:.3f}deg shear={shear:.4f}")

# ---------------- choose transform ----------------
use_affine = residual_stats(d485_sim)["mean"] > 1.5 * residual_stats(d485_aff)["mean"] \
             or residual_stats(d77_sim)["mean"] > 1.5 * residual_stats(d77_aff)["mean"]
if use_affine:
    xform = lambda p: apply_aff(np.asarray(p, float), M)
    chosen = "affine"
    d485, d77 = d485_aff, d77_aff
else:
    xform = lambda p: apply_sim(np.asarray(p, float), s, R, t)
    chosen = "similarity"
    d485, d77 = d485_sim, d77_sim
print("CHOSEN:", chosen)

# ---------------- width mapping ----------------
def game_width(layer, widthPx, kind=None):
    if layer == "hw77":
        return 12          # thickest interstate class
    if layer == "hw485":
        return 10
    if layer == "minor":
        return 6 if widthPx >= 5.5 else 5   # arterial 6, collector/residential 5
    if layer == "water":
        # rivers keep px width, converted to tiles with the fitted scale
        scale_mean = (np.linalg.norm(M[:, 0]) + np.linalg.norm(M[:, 1])) / 2 if use_affine else s
        return max(2, round(widthPx * scale_mean))
    return 5

# ---------------- apply to all four layers ----------------
mean_scale = float((np.linalg.norm(M[:, 0]) + np.linalg.norm(M[:, 1])) / 2) if use_affine else float(s)
extents = {}
for name in ["hw77", "hw485", "minor", "water"]:
    d = load_polys(name + ".json")
    out = {"layer": d["layer"], "space": "tile", "worldSize": [2500, 2500],
           "transform": ({"type": "affine", "M": M.tolist()} if use_affine
                         else {"type": "similarity", "scale": float(s),
                               "rotationDeg": rot_sim, "tx": float(t[0]), "ty": float(t[1])}),
           "polylines": []}
    allpts = []
    for pl in d["polylines"]:
        tp = xform(pl["pts"])
        tp_r = np.round(tp, 1)
        allpts.append(tp)
        npl = {"pts": tp_r.tolist(), "widthPx": pl["widthPx"],
               "width": game_width(name, pl["widthPx"], pl.get("kind")),
               "closed": pl.get("closed", False)}
        if "kind" in pl: npl["kind"] = pl["kind"]
        out["polylines"].append(npl)
    ap = np.vstack(allpts)
    ext = [float(ap[:, 0].min()), float(ap[:, 1].min()), float(ap[:, 0].max()), float(ap[:, 1].max())]
    extents[name] = [round(v, 1) for v in ext]
    with open(os.path.join(HERE, f"world_{name}.json"), "w") as f:
        json.dump(out, f)
    print(f"world_{name}.json: {len(out['polylines'])} polylines, extent {extents[name]}")

# ---------------- summary ----------------
summary = {
    "chosen": chosen,
    "similarity": {"scale": float(s), "rotationDeg": rot_sim,
                   "tx": float(t[0]), "ty": float(t[1]),
                   "residuals": {"i485": residual_stats(d485_sim), "i77": residual_stats(d77_sim)}},
    "affine": {"M": M.tolist(),
               "decomposed": {"scaleX": float(sxa), "scaleY": float(sya),
                              "rotationDeg": rot_aff, "shear": shear},
               "residuals": {"i485": residual_stats(d485_aff), "i77": residual_stats(d77_aff)}},
    "meanScale": mean_scale,
    "worldExtents": extents,
}
with open(os.path.join(HERE, "fit_summary.json"), "w") as f:
    json.dump(summary, f, indent=1)
print(json.dumps(summary, indent=1))
