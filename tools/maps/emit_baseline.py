# PHASE A: emit src/config/world/baselineRoads.ts + baselineWater.ts from the
# registered source-map traces (fixtures/maps/world_*.json).
# Highways inherit name/width/z from the best-matching old hand-traced row;
# minors get width classes from stroke thickness; everything clipped to the
# 2500-tile world; old border-ring rows preserved verbatim.
import json, math, re, os

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
FIX = os.path.join(ROOT, 'fixtures', 'maps')
PX2TILE = 1.19862  # stroke thickness image-px -> tiles (fit_summary scale)

def load(n):
    with open(os.path.join(FIX, n)) as f: return json.load(f)
hw = load('world_hw77.json')['polylines'] + load('world_hw485.json')['polylines']
minor = load('world_minor_welded.json')['polylines']
water = load('world_water.json')['polylines']

# parse the ORIGINAL hand-traced rows (pre-regen snapshot) so name-matching
# and border-preservation stay stable across emitter re-runs
ts = open(os.path.join(FIX, 'legacy_baselineRoads.ts.txt')).read()
old = []
for m in re.finditer(r'^\[([0-9]+),([01]),"([^"]*)",([0-9]+),([0-9.,\-]+)\],?$', ts, re.M):
    nums = [float(v) for v in m.group(5).split(',')]
    old.append({'w': int(m.group(1)), 'maj': int(m.group(2)), 'name': m.group(3),
                'z': int(m.group(4)), 'pts': [[nums[k], nums[k+1]] for k in range(0, len(nums)-1, 2)],
                'raw': m.group(0).rstrip(',')})
old_hw = [r for r in old if r['z'] >= 2]

def d_pt_seg(p, a, b):
    ax, ay = a; bx, by = b; dx, dy = bx-ax, by-ay
    L2 = dx*dx+dy*dy
    if L2 < 1e-9: return math.hypot(p[0]-ax, p[1]-ay)
    t = max(0, min(1, ((p[0]-ax)*dx+(p[1]-ay)*dy)/L2))
    return math.hypot(p[0]-(ax+dx*t), p[1]-(ay+dy*t))
def d_pt_poly(p, pts):
    return min(d_pt_seg(p, pts[i], pts[i+1]) for i in range(len(pts)-1))
def mean_dist(a_pts, b_pts, samples=24):
    step = max(1, len(a_pts)//samples)
    ds = [d_pt_poly(a_pts[i], b_pts) for i in range(0, len(a_pts), step)]
    return sum(ds)/len(ds)

def clip_runs(pts, lo=0.5, hi=2499.5):
    """Split a polyline into runs inside the world box (with boundary crossing pts)."""
    def inside(p): return lo <= p[0] <= hi and lo <= p[1] <= hi
    def cross(a, b):
        # param t where segment leaves/enters box (single clip, iterate axes)
        t0, t1 = 0.0, 1.0
        for ax in (0, 1):
            d = b[ax]-a[ax]
            for bound, sgn in ((lo, -1), (hi, 1)):
                if abs(d) < 1e-12:
                    if (a[ax]-bound)*sgn > 0: return None
                    continue
                t = (bound-a[ax])/d
                if d*sgn > 0: t1 = min(t1, t)
                else: t0 = max(t0, t)
        if t0 > t1: return None
        return (t0, t1)
    runs, cur = [], []
    for i in range(len(pts)-1):
        a, b = pts[i], pts[i+1]
        ia, ib = inside(a), inside(b)
        if ia and ib:
            if not cur: cur = [a]
            cur.append(b)
        else:
            c = cross(a, b)
            if c is None:
                if cur: runs.append(cur); cur = []
                continue
            t0, t1 = c
            pa = [a[0]+(b[0]-a[0])*t0, a[1]+(b[1]-a[1])*t0]
            pb = [a[0]+(b[0]-a[0])*t1, a[1]+(b[1]-a[1])*t1]
            if ia:
                if not cur: cur = [a]
                cur.append(pb); runs.append(cur); cur = []
            elif ib:
                if cur: runs.append(cur)
                cur = [pa, b]
            else:
                if t1 > t0 + 1e-9: runs.append([pa, pb])
                if cur: runs.append(cur); cur = []
    if cur: runs.append(cur)
    def ln(r): return sum(math.hypot(r[i+1][0]-r[i][0], r[i+1][1]-r[i][1]) for i in range(len(r)-1))
    # H983: keep SHORT runs — junction-split traces produce sub-6-tile
    # connector pieces between shared nodes; dropping them left gaps and
    # floating stubs in the highway network (user screenshots 2026-07-03).
    # Only genuinely degenerate slivers (<1.5 tiles) go.
    return [r for r in runs if len(r) >= 2 and ln(r) >= 1.5]

def fmt(pts):
    out = []
    for p in pts:
        for v in p:
            r = round(v, 2)
            out.append(str(int(r)) if r == int(r) else f"{r}")
    return ','.join(out)

rows = []
# highways: NAME from best old match (label only) — WIDTH from the source
# layer, per the user's rule: everything drawn in the highway PNGs is
# interstate-class ("I specifically made PNG files of the highways so
# there should be zero confusion"). Legacy w=4 I-277/Brookshire widths
# recreated the old 8-lane-into-2-lane defect and are gone.
hw485_set = set(id(p) for p in load('world_hw485.json')['polylines'])
used = {}
for p in hw:
    best, bd = None, 1e9
    for r in old_hw:
        d = mean_dist(p['pts'], r['pts'])
        if d < bd: bd, best = d, r
    if best is not None and bd <= 30:
        n = used.get(best['name'], 0); used[best['name']] = n+1
        name = best['name'] if n == 0 else f"{best['name']} ({n+1})"
    else:
        name = f"Interstate {len(rows)}"
    # width: I-485 loop = 10; EVERYTHING in the 77 layer = 12. The source
    # stroke thickness is uniform-by-design (user: "I specifically made
    # PNG files of the highways so there should be zero confusion") — no
    # thickness inference, no legacy inheritance, no 2-lane highways.
    w = 10 if name.startswith('I-485') else 12
    for run in clip_runs(p['pts']):
        rows.append(f'[{w},1,"{name}",4,{fmt(run)}]')

# minors: width class from stroke thickness (image px -> tiles)
mi = 0
for p in minor:
    wt = p.get('widthPx', 4) * PX2TILE
    w = 6 if wt >= 7 else (5 if wt >= 4 else 4)
    for run in clip_runs(p['pts']):
        rows.append(f'[{w},0,"m{mi}",0,{fmt(run)}]')
        mi += 1

# preserved old border-ring rows (all pts within 3 tiles of a world edge)
def border(r):
    return all(min(p[0], p[1], 2499-p[0], 2499-p[1]) <= 3 for p in r['pts'])
kept = [r['raw'] for r in old if border(r)]

header = ts.split('export const BASELINE_ROADS')[0]
body = ',\n'.join([*(f'{k}' for k in kept), *rows])
gen = (header
  + 'export const BASELINE_ROADS: readonly BaselineRoadRow[] = [\n'
  + '// === PHASE A regen (H981): traced from Maps/*.png, registered similarity\n'
  + '// scale 1.19862 tx -1066.485 ty -109.951; highways inherit legacy name/w/z;\n'
  + '// minors width-classed by source stroke thickness; border ring preserved. ===\n'
  + body + '\n];\n')
with open(os.path.join(ROOT, 'src', 'config', 'world', 'baselineRoads.ts'), 'w') as f:
    f.write(gen)

# water
rivers, lakes = [], []
for p in water:
    if p.get('closed'):
        for run in [p['pts']] :
            lakes.append(f'["Lake",{fmt(run)}]')
    else:
        # rivers: source strokes are drawn thick for visibility, not scale —
        # cap at 4 tiles so water reads as a river, not a chunky flood band
        # (the user's "random dark grid replacing grass").
        px = p.get('widthPx', 3)
        w = 2 if px < 4 else (3 if px < 6 else 4)
        for run in clip_runs(p['pts']):
            rivers.append(f'[{w},"River",{fmt(run)}]')
wsrc = ('/** PHASE A (H981): baseline water traced from Maps/"Rivers and Lake.png",\n'
  ' *  registered to tile coords. Row formats mirror the editor overlay rows the\n'
  ' *  stampers consume: rivers [w, name, x1,y1,...] (pts from index 2), lakes\n'
  ' *  [name, x1,y1,...] (pts from index 1). Stamped via _weStampRiverTiles /\n'
  ' *  _weStampLake in buildBaselineMap — soft writes, so roads bridge water. */\n'
  'export const BASELINE_RIVERS: ReadonlyArray<readonly (number | string)[]> = [\n'
  + ',\n'.join(rivers) + '\n];\n\n'
  'export const BASELINE_LAKES: ReadonlyArray<readonly (number | string)[]> = [\n'
  + ',\n'.join(lakes) + '\n];\n')
with open(os.path.join(ROOT, 'src', 'config', 'world', 'baselineWater.ts'), 'w') as f:
    f.write(wsrc)

print(json.dumps({'rows': len(rows), 'borderKept': len(kept), 'rivers': len(rivers),
                  'lakes': len(lakes), 'oldRows': len(old)}))
