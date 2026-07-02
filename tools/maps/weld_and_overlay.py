# Weld minor-road underpass gaps + render the old-vs-new QC overlay.
# Inputs: fixtures/maps/world_{hw77,hw485,minor,water}.json (registered tile coords)
#         src/config/world/baselineRoads.ts (current hand-traced network)
# Outputs: fixtures/maps/world_minor_welded.json
#          fixtures/maps/overlay_qc.png  (red=old baseline, green=new traces,
#          cyan=welds, blue=water, dim grid = world bounds)
import json, math, re, os

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
FIX = os.path.join(ROOT, 'fixtures', 'maps')

def load(name):
    with open(os.path.join(FIX, name), 'r') as f:
        return json.load(f)

hw77 = load('world_hw77.json'); hw485 = load('world_hw485.json')
minor = load('world_minor.json'); water = load('world_water.json')
def polys(layer):
    return [p['pts'] for p in layer['polylines']]
HW = polys(hw77) + polys(hw485)

# ---------- weld pass ----------
GAP_MAX = 14.0        # tiles; source dashes measured ~6-12 tiles after scaling
COLLINEAR_DEG = 28.0
def endtan(pts, at_start):
    a, b = (pts[0], pts[1]) if at_start else (pts[-1], pts[-2])
    dx, dy = a[0]-b[0], a[1]-b[1]; L = math.hypot(dx, dy) or 1
    return (dx/L, dy/L)  # pointing OUT of the polyline
def seg_x_seg(p1, p2, p3, p4):
    d = (p2[0]-p1[0])*(p4[1]-p3[1]) - (p2[1]-p1[1])*(p4[0]-p3[0])
    if abs(d) < 1e-12: return False
    t = ((p3[0]-p1[0])*(p4[1]-p3[1]) - (p3[1]-p1[1])*(p4[0]-p3[0])) / d
    u = ((p3[0]-p1[0])*(p2[1]-p1[1]) - (p3[1]-p1[1])*(p2[0]-p1[0])) / d
    return 0 < t < 1 and 0 < u < 1
def crosses_highway(a, b):
    for hp in HW:
        for i in range(len(hp)-1):
            if seg_x_seg(a, b, hp[i], hp[i+1]): return True
    return False

mp = [dict(p) for p in minor['polylines']]
welds = []
merged = True
while merged:
    merged = False
    ends = []
    for i, p in enumerate(mp):
        if p.get('closed') or p.get('dead'): continue
        ends.append((i, 0)); ends.append((i, 1))
    for ei in range(len(ends)):
        if merged: break
        i, si = ends[ei]
        a = mp[i]['pts'][0 if si == 0 else -1]
        ta = endtan(mp[i]['pts'], si == 0)
        for ej in range(ei+1, len(ends)):
            j, sj = ends[ej]
            if i == j: continue
            b = mp[j]['pts'][0 if sj == 0 else -1]
            gap = math.hypot(a[0]-b[0], a[1]-b[1])
            if gap > GAP_MAX or gap < 0.01: continue
            tb = endtan(mp[j]['pts'], sj == 0)
            # outward tangents should be roughly OPPOSITE for a collinear join
            dot = ta[0]*tb[0] + ta[1]*tb[1]
            if dot > -math.cos(math.radians(COLLINEAR_DEG)): continue
            if not crosses_highway(a, b): continue
            # weld j onto i
            pi = mp[i]['pts'] if si == 1 else list(reversed(mp[i]['pts']))
            pj = mp[j]['pts'] if sj == 0 else list(reversed(mp[j]['pts']))
            mp[i]['pts'] = pi + pj
            mp[i]['widthPx'] = max(mp[i].get('widthPx', 0), mp[j].get('widthPx', 0))
            mp[j]['dead'] = True
            welds.append((a, b))
            merged = True
            break
mp = [p for p in mp if not p.get('dead')]
out = dict(minor); out['polylines'] = mp; out['welds'] = welds
with open(os.path.join(FIX, 'world_minor_welded.json'), 'w') as f:
    json.dump(out, f)

# ---------- old baseline parse ----------
rows = []
ts = open(os.path.join(ROOT, 'src', 'config', 'world', 'baselineRoads.ts')).read()
for m in re.finditer(r'^\[([0-9]+),([01]),"([^"]*)",([0-9]+),([0-9.,\-]+)\],?$', ts, re.M):
    nums = [float(v) for v in m.group(5).split(',')]
    pts = [[nums[k], nums[k+1]] for k in range(0, len(nums)-1, 2)]
    rows.append({'w': int(m.group(1)), 'name': m.group(3), 'pts': pts})

# ---------- overlay ----------
from PIL import Image, ImageDraw
S = 0.5  # 2500 tiles -> 1250 px
img = Image.new('RGB', (1250, 1250), (14, 16, 22))
d = ImageDraw.Draw(img)
for g in range(0, 1251, 125): d.line([(g,0),(g,1250)], fill=(26,30,40)); d.line([(0,g),(1250,g)], fill=(26,30,40))
def draw(polylines, color, wpx=1):
    for pts in polylines:
        xy = [(p[0]*S, p[1]*S) for p in pts]
        if len(xy) >= 2: d.line(xy, fill=color, width=wpx)
draw([r['pts'] for r in rows], (215, 60, 60), 1)                       # old = red
draw([p['pts'] for p in water['polylines']], (70, 120, 230), 2)        # water = blue
draw([p['pts'] for p in mp], (70, 200, 90), 1)                         # new minor = green
draw(polys(hw77) + polys(hw485), (120, 255, 140), 2)                   # new hw = bright green
for a, b in welds:
    d.line([(a[0]*S, a[1]*S), (b[0]*S, b[1]*S)], fill=(0, 230, 230), width=3)  # welds = cyan
img.save(os.path.join(FIX, 'overlay_qc.png'))

# ---------- stats ----------
def total_len(pls):
    t = 0
    for pts in pls:
        for i in range(len(pts)-1): t += math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1])
    return t
print(json.dumps({
    'weldsMade': len(welds),
    'minorPolylines': {'before': len(minor['polylines']), 'after': len(mp)},
    'lengthTiles': {
        'oldBaselineAll': round(total_len([r['pts'] for r in rows])),
        'newMinor': round(total_len([p['pts'] for p in mp])),
        'newHighways': round(total_len(HW)),
        'water': round(total_len([p['pts'] for p in water['polylines']])),
    },
    'weldPoints': [[round(a[0],1), round(a[1],1)] for a, b in welds[:40]],
}))
