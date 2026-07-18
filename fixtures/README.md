# Road-lab fixtures

## user-world-v1.json (H1176)

The USER'S OWN editor world, reconstructed 2026-07-18 from their text export
(`driverCity_worldEditor_v4` payload shape). This is the standing
visual-regression fixture for road/intersection/gap work — verify against it
before shipping road-visual changes.

**Reproduces immediately on load:**
- **The vertex-gap class:** the vertical w6 road's STORED endpoint is
  (1186.41, 1154.30) while the horizontal w6 road it should join runs at
  y≈1166 — the committed data is ~12 tiles short even though the user
  connected them at a vertex in the editor. The gap is in the DATA at
  commit time (editor connect/snap path), not in the renderer.
- Merge-ribbon fragments at the oval endpoints.

**Known limitation:** the editor's text export omits the `roadProps` bond
sidecars (`bondInnerStart/End`, `laneCentered`), so the two large merge-flag
oval rows render only fragments here while rendering fully in the user's
live storage. Full fidelity needs the raw localStorage JSON.

Load: `localStorage.setItem('driverCity_worldEditor_v4', <file contents>)`,
reload.


Visual-regression fixtures for the World Editor / road geometry pipelines.

## road-lab-v1.json

A `driverCity_worldEditor_v4` localStorage payload. Every row was committed
through the REAL editor pipeline (`_weCommitDraft` via the Confirm button,
build 8efba4b) — welds, fuses, merge bonding and lane-center sidecars are
bonder output, not hand-authored.

Reconstructs the regressions the user reported on 2026-07-02
(phone screenshots, build 62c0b69), plus z=0 controls:

| rows | scenario | expected once fixed |
| --- | --- | --- |
| North Rd / South Rd / Cross Rd / **Link Bridge** (z=2, concrete) | user screenshot 3 (~tile 1107,1181): bridge linking two roads across an intersection. REPRO: hard butt seams at both deck ends, lateral edge-line step, dark axis-aligned rectangle jutting behind the skewed deck | continuous edge lines through both transitions, no stray rectangles |
| Main Hwy / **Ramp** (z=2, merge flag 4) | user screenshot 2 (~tile 1081,1169): merge lane drawn with Bridge ✓. REPRO: renders as floating parapet-edged ribbon ON TOP of the road, no gore opening, road edge line runs straight underneath | tapered gore opening from the road like the z=0 control |
| Vert Rd / **Aux Lane** (z=2, merge flag 4) | user screenshot 1: parallel aux lane with Bridge ✓. REPRO: detached needle floating in the grass beside the road | attached tapered aux lane like the z=0 control |
| Ctl Hwy / **Ctl Ramp** (z=0) | control — renders a correct tapered gore. NOTE: its start grabbed an unintended bond (bondInnerStart at ~10 tiles) — separate finding on bond search radius | intentional-bond-only |
| Ctl Vert / **Ctl Aux** (z=0) | control — correct attached aux lane | unchanged |

## Using it

In a dev build (F12 console or automated preview):

```js
localStorage.setItem('driverCity_worldEditor_v4', /* file contents */);
location.reload();
// F9 to open the editor; scenarios at tiles ~1107,1181 (bridge),
// ~1075,1163 (z=2 merges), ~1022,1160 (z=0 controls).
```

Headless preview driver (hidden window: RAF is frozen):

```js
// editor camera + one synchronous frame
const we = window.__dc.ctx.worldEditor;
we.view.cx = 1107; we.view.cy = 1181; we.view.zoom = 8;
we.needsRedraw = true; window.__weForceRender();
document.getElementById('weCanvas').toDataURL('image/png');
```

Diagnosis (2026-07-02): merge rows carrying z>=2 are hijacked by the bridge
painter and never reach `_weDrawTaperedMergeRoad` — the user's lanes got
z=2 because the Bridge checkbox stayed checked from earlier bridge work.
Same z-gate breaks the ground tile stamp (dirt kickup) and traffic lanes.
Bridge-link seams are the known cross-z butt-cap issue (fuseable() z-check).
