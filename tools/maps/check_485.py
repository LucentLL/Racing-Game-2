# Diagnose the missing I-485 SE section: is the gap in the emitted rows,
# in the registered trace, or in the raw trace?
import json, math, re, os
ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
FIX = os.path.join(ROOT, 'fixtures', 'maps')

ts = open(os.path.join(ROOT, 'src', 'config', 'world', 'baselineRoads.ts')).read()
rows = []
for m in re.finditer(r'^\[([0-9]+),([01]),"([^"]*)",([0-9]+),([0-9.,\-]+)\],?$', ts, re.M):
    nums = [float(v) for v in m.group(5).split(',')]
    rows.append({'w': int(m.group(1)), 'name': m.group(3), 'z': int(m.group(4)),
                 'pts': [[nums[k], nums[k+1]] for k in range(0, len(nums)-1, 2)]})

def gaps(pts, thresh=8):
    out = []
    for i in range(len(pts)-1):
        d = math.hypot(pts[i+1][0]-pts[i][0], pts[i+1][1]-pts[i][1])
        if d > thresh: out.append((i, round(d,1), [round(pts[i][0]),round(pts[i][1])], [round(pts[i+1][0]),round(pts[i+1][1])]))
    return out

report = {}
hw = [r for r in rows if r['z'] >= 2]
report['highwayRows'] = [{'name': r['name'], 'w': r['w'], 'n': len(r['pts']),
                          'start': [round(v) for v in r['pts'][0]], 'end': [round(v) for v in r['pts'][-1]],
                          'bigGaps': gaps(r['pts'])} for r in hw]
# endpoint adjacency between highway rows (a junction-split network should chain)
eps = []
for i, r in enumerate(hw):
    eps.append((i, r['name'], r['pts'][0])); eps.append((i, r['name'], r['pts'][-1]))
danglers = []
for i, (ri, name, p) in enumerate(eps):
    best = 1e9
    for j, (rj, _, q) in enumerate(eps):
        if ri == rj: continue
        best = min(best, math.hypot(p[0]-q[0], p[1]-q[1]))
    # also distance to any OTHER highway polyline body
    for j, r2 in enumerate(hw):
        if j == ri: continue
        for k in range(len(r2['pts'])-1):
            a, b = r2['pts'][k], r2['pts'][k+1]
            dx, dy = b[0]-a[0], b[1]-a[1]
            L2 = dx*dx+dy*dy
            if L2 < 1e-9: continue
            t = max(0, min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/L2))
            best = min(best, math.hypot(p[0]-(a[0]+dx*t), p[1]-(a[1]+dy*t)))
    if best > 6:
        danglers.append({'row': name, 'end': [round(v) for v in p], 'nearest': round(best,1)})
report['danglingHighwayEnds'] = danglers
# the registered trace, for comparison
tr = json.load(open(os.path.join(FIX, 'world_hw485.json')))['polylines']
report['trace485'] = [{'n': len(p['pts']), 'closed': bool(p.get('closed')),
                       'gaps': gaps(p['pts'])} for p in tr]
tr77 = json.load(open(os.path.join(FIX, 'world_hw77.json')))['polylines']
report['trace77'] = [{'i': i, 'n': len(p['pts']),
                      'start': [round(v) for v in p['pts'][0]], 'end': [round(v) for v in p['pts'][-1]]}
                     for i, p in enumerate(tr77)]
print(json.dumps(report, indent=1))
