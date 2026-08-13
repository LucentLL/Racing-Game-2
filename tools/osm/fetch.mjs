// OSM-A: fetch Charlotte arterial road data from the Overpass API and cache it.
//
//   node tools/osm/fetch.mjs
//
// Downloads two datasets into fixtures/osm/raw/ (gitignored — re-run to refetch):
//   charlotte_ways.json  — every motorway/trunk/primary/secondary/tertiary way
//                          (+ their _link ramps) inside the beltway bbox, with
//                          per-node geometry and all tags (lanes, oneway,
//                          maxspeed, bridge, layer, ref, turn:lanes, ...)
//   charlotte_nodes.json — every traffic_signals / stop / give_way node in bbox
//
// Data © OpenStreetMap contributors, ODbL — user-visible attribution required
// in any shipped build that includes the derived map.
//
// Overpass mirrors rate-limit; queries are cached to disk and only refetched
// when the cache file is missing. Delete a cache file to force a refetch.

import { mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RAW_DIR = join(ROOT, 'fixtures', 'osm', 'raw');
mkdirSync(RAW_DIR, { recursive: true });

// Bbox covering the full I-485 beltway with margin (south, west, north, east).
// Beltway extremes measured on OSM: N~35.39 S~35.09 W~-80.98 E~-80.65.
const BBOX = '35.03,-81.03,35.42,-80.62';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const QUERIES = {
  'charlotte_ways.json': `[out:json][timeout:300];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"](${BBOX});
);
out geom;`,
  'charlotte_nodes.json': `[out:json][timeout:120];
(
  node["highway"~"^(traffic_signals|stop|give_way)$"](${BBOX});
);
out;`,
};

async function fetchQuery(name, query) {
  const outPath = join(RAW_DIR, name);
  if (existsSync(outPath) && statSync(outPath).size > 1000) {
    console.log(`[cache] ${name} exists (${(statSync(outPath).size / 1e6).toFixed(1)} MB) — skipping`);
    return;
  }
  for (const mirror of MIRRORS) {
    try {
      console.log(`[fetch] ${name} from ${new URL(mirror).host} ...`);
      const t0 = Date.now();
      const res = await fetch(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'DriverCity-map-import/1.0 (indie game; contact via github LucentLL)',
        },
        body: 'data=' + encodeURIComponent(query),
      });
      if (!res.ok) {
        console.warn(`  HTTP ${res.status} ${res.statusText} — trying next mirror`);
        continue;
      }
      const text = await res.text();
      // Overpass returns 200 with an error remark on some failures — sanity check.
      const parsed = JSON.parse(text);
      if (!parsed.elements || parsed.elements.length === 0) {
        console.warn(`  0 elements (remark: ${parsed.remark ?? 'none'}) — trying next mirror`);
        continue;
      }
      writeFileSync(outPath, text);
      console.log(`  ok: ${parsed.elements.length} elements, ${(text.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      return;
    } catch (err) {
      console.warn(`  failed (${err.message}) — trying next mirror`);
    }
  }
  throw new Error(`all mirrors failed for ${name}`);
}

for (const [name, query] of Object.entries(QUERIES)) {
  await fetchQuery(name, query);
}
console.log('done.');
