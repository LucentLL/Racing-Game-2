// H1239 probe: what building / surface / parking-lot rows does each map hand
// the render passes?
//
// The bug this guards: drawDriveways + drawPlacedBuildings were fed
// ctx.worldEditor.buildings/.surfaces (the CITY editor state) on EVERY map, so
// a track map painted city roofs with no collision under them. The city path
// must stay on the live editor state (still editable); every other map must
// serve its own overlay rows.
//
// Usage: node tools/maplab/structrows.mjs
import {
  setActiveMapId,
  getActiveMapId,
  getActiveMapLots,
  getActiveMapBuildings,
  getActiveMapSurfaces,
  listMaps,
} from './maplab.mjs';

let fail = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) fail++;
}

console.log('--- per-map structure rows served to the render passes ---');
for (const m of listMaps()) {
  setActiveMapId(m.id);
  const b = getActiveMapBuildings().length;
  const s = getActiveMapSurfaces().length;
  const l = getActiveMapLots().length;
  console.log(`  ${m.id.padEnd(12)} buildings=${b}  surfaces=${s}  lots=${l}`);
}

console.log('\n--- assertions ---');

// The city must serve EMPTY from the cache: gameLoop's guard sends it to the
// live editor state instead, exactly as before this commit.
setActiveMapId('city');
check('city serves empty caches (gameLoop uses live editor state)',
  getActiveMapBuildings().length === 0
  && getActiveMapSurfaces().length === 0
  && getActiveMapLots().length === 0);

// A track map must serve its OWN rows — zero today (no pit geometry yet), which
// is precisely the fix: it used to receive the city's building rows.
setActiveMapId('monza');
check('monza serves its own (empty) rows, not the city\'s',
  getActiveMapBuildings().length === 0 && getActiveMapSurfaces().length === 0,
  `id=${getActiveMapId()}`);

// The car meet is the existing proof that a non-city overlay reaches a render
// pass — its parking lot must still come through.
setActiveMapId('carmeet');
check('carmeet still serves its parking lot (H1032 path intact)',
  getActiveMapLots().length === 1,
  `lots=${getActiveMapLots().length}`);

// Switching away must not leak the previous map's rows.
setActiveMapId('spa');
check('switching carmeet -> spa clears the lot cache',
  getActiveMapLots().length === 0);

// Buildings authored on a map's overlay must flow through the cache. Simulate
// what H1240's pit geometry will do by reading the def's source directly.
setActiveMapId('carmeet');
const meetOverlay = listMaps().find((m) => m.id === 'carmeet').source().overlay;
check('cache matches the map source (lots)',
  getActiveMapLots().length === meetOverlay.parkingLots.length);
check('cache matches the map source (buildings)',
  getActiveMapBuildings().length === (meetOverlay.buildings?.length ?? 0));

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
