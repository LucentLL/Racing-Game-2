/**
 * H41 — I-277 boundary polygon.
 *
 * Charlotte's downtown loop. Tiles INSIDE the polygon become buildings /
 * sidewalks; tiles OUTSIDE are grass / forest. Ported verbatim from
 * monolith L17306-17324.
 *
 * The polygon is expanded by I277_EXPAND tiles outward (centroid-radial)
 * so buildings can sit just outside the literal freeway loop, matching
 * how the monolith displays the city.
 */

/** Raw I-277 polygon vertices in tile coords. 92 vertices clockwise. */
const I277_POLY_RAW: readonly [number, number][] = [
  [936, 1096], [945, 1098], [950, 1103], [950, 1104], [953, 1108], [953, 1109],
  [960, 1119], [962, 1122], [969, 1132], [970, 1135], [972, 1138], [974, 1141],
  [976, 1144], [978, 1149], [984, 1155], [986, 1155], [989, 1158], [990, 1158],
  [994, 1162], [995, 1162], [1006, 1173], [1006, 1174], [1028, 1194], [1030, 1199],
  [1036, 1205], [1041, 1215], [1041, 1230], [1040, 1231], [1040, 1235], [1038, 1236],
  [1038, 1239], [1036, 1242], [1036, 1244], [1034, 1249], [1028, 1256], [1028, 1258],
  [1019, 1266], [1018, 1266], [1016, 1268], [1016, 1270], [1011, 1274], [1011, 1276],
  [999, 1286], [998, 1286], [990, 1294], [986, 1295], [983, 1297], [971, 1297],
  [968, 1295], [965, 1295], [958, 1288], [957, 1288], [929, 1260], [928, 1260],
  [908, 1240], [906, 1240], [900, 1235], [893, 1231], [886, 1230], [885, 1229],
  [881, 1229], [880, 1228], [856, 1228], [855, 1227], [842, 1227], [839, 1224],
  [842, 1219], [843, 1215], [850, 1207], [850, 1206], [854, 1203], [856, 1198],
  [856, 1195], [860, 1189], [860, 1186], [862, 1181], [862, 1179], [863, 1177],
  [863, 1175], [865, 1174], [865, 1170], [869, 1164], [869, 1163], [887, 1145],
  [887, 1144], [892, 1139], [892, 1138], [910, 1120], [910, 1119], [932, 1097],
  [934, 1097], [936, 1096],
];

const I277_CX = 945;
const I277_CY = 1201;
/** Tiles beyond the literal loop to allow buildings (monolith L17309). */
const I277_EXPAND = 16;

/** Expanded polygon — each vertex pushed outward from the centroid by
 *  I277_EXPAND tiles. The actual inside-check polygon. */
export const I277_POLY: readonly [number, number][] = I277_POLY_RAW.map((p) => {
  const dx = p[0] - I277_CX;
  const dy = p[1] - I277_CY;
  const d = Math.sqrt(dx * dx + dy * dy) || 1;
  return [p[0] + (dx / d) * I277_EXPAND, p[1] + (dy / d) * I277_EXPAND] as [number, number];
});

/** True when tile coords (tx, ty) lie inside the expanded I-277 loop.
 *  Standard ray-casting point-in-polygon. Hot path — called per tile
 *  during the building render pass, so it's kept allocation-free. */
export function insideI277(tx: number, ty: number): boolean {
  const poly = I277_POLY;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0];
    const yi = poly[i][1];
    const xj = poly[j][0];
    const yj = poly[j][1];
    if (((yi > ty) !== (yj > ty)) && (tx < ((xj - xi) * (ty - yi)) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}
