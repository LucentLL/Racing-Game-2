/**
 * drawRoadOverlay — the single-road rendering pipeline.
 *
 * Ported from render() L30598–31670 of the v8.99.126.89 monolith. Twenty
 * z-ordered sub-passes inside one function:
 *
 *   1. bbox / fallback per-point visibility cull
 *   2. RoadProfile lookup
 *   3. Merge polygon early-return branch (filled poly + open edges)
 *   4. Visible-chunks computation for the stroke passes that follow
 *   5. Main asphalt stroke (with per-segment material override path)
 *   6. Auto-taper polygon fill + flared outer/inner stripes
 *   7. Tire wear (3 passes — solid baseline + 2 dashed emphases)
 *   8. Oil drip (3 passes — solid baseline + 2 dashed emphases)
 *   9. Bridge concrete (shadow + rim + drive surface)
 *  10. Major-road edge band tint
 *  11. I-485 grass median
 *  12. I-77/I-85 jersey barrier
 *  13. Yellow centerline (non-interstate roads w >= 3)
 *  14. Lane dividers (chunked or fallback)
 *  15. White outer edge stripes (fog lines)
 *  16. T-junction edge break (erase + leave gap, no re-stroke per v126.63)
 *  17. Taper lane-addition dashed stripe (DOT MUTCD)
 *  18. Yellow inner-edge stripes (divided highways)
 *  19. Merge chevron pass (V-shapes along centerline)
 *
 * Each pass is exit-gated by feature availability (chunk paths, profile
 * fields, road flags), so this function copes with both fully-preprocessed
 * roads and minimal hand-built ones.
 */

import type { Road, RoadChunk, RoadOverlayDeps } from './types';
import { traceRoadPath } from './traceRoadPath';

/** Bridge concrete extends within ±BRIDGE_R tiles of every bridge crossing. */
const BRIDGE_R = 20;
const BRIDGE_R_SQ = BRIDGE_R * BRIDGE_R;

export function drawRoadOverlay(
  ctx: CanvasRenderingContext2D,
  road: Road,
  deps: RoadOverlayDeps,
): void {
  const pts = road.pts;
  if (pts.length < 2) return;
  const {
    TILE, smoothFocusX, smoothFocusY, viewR, px, py,
    getAsphaltPattern, roadAge, roadMaterial, getRoadProfile,
    effectiveMaterialAge,
  } = deps;
  const perfOn = !!deps.perfOn;
  const incStroke = (n: number): void => { if (perfOn && deps.perfStrokeCount) deps.perfStrokeCount(n); };
  const incFullPath = (n: number): void => { if (perfOn && deps.perfStrokeFullPath) deps.perfStrokeFullPath(n); };

  // ---- Pass 1: bbox cull -------------------------------------------------
  const bb = road._bbox;
  if (bb) {
    const m = viewR * 1.6;
    if (bb.maxX < smoothFocusX - m || bb.minX > smoothFocusX + m
        || bb.maxY < smoothFocusY - m || bb.minY > smoothFocusY + m) return;
  } else {
    // Fallback: per-point scan (sparse + midpoint samples).
    let vis = false;
    for (let si = 0; si < pts.length && !vis; si++) {
      const wx = pts[si][0] * TILE + TILE / 2;
      const wy = pts[si][1] * TILE + TILE / 2;
      if (Math.abs(wx - px) < viewR * 2.5 && Math.abs(wy - py) < viewR * 2.5) { vis = true; break; }
      if (si < pts.length - 1) {
        for (let f = 0.25; f <= 0.75; f += 0.25) {
          const mx = (pts[si][0] * (1 - f) + pts[si + 1][0] * f) * TILE + TILE / 2;
          const my = (pts[si][1] * (1 - f) + pts[si + 1][1] * f) * TILE + TILE / 2;
          if (Math.abs(mx - px) < viewR * 2.5 && Math.abs(my - py) < viewR * 2.5) { vis = true; break; }
        }
      }
    }
    if (!vis) return;
  }

  const prof = road._prof || getRoadProfile(road);
  const rw = prof.asphaltW * TILE;
  const isElevated = (road.z || 0) >= 2;
  const bPts = road.bridgePts || [];
  const mainPath = road._mainPath;

  // ---- Pass 3: merge polygon early-return -------------------------------
  if (road.merge && road._mergePolyPath) {
    ctx.fillStyle = getAsphaltPattern(
      ctx, !!road.maj || !!road._bondedToMajor, false, roadAge(road), roadMaterial(road),
    );
    ctx.fill(road._mergePolyPath);
    ctx.lineWidth = Math.max(1, prof.laneW * 0.06 * TILE);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(240,240,240,0.78)';
    const prevDash = ctx.getLineDash ? ctx.getLineDash() : null;
    if (ctx.setLineDash) ctx.setLineDash([]);
    if (road._mergeOuterEdgePath) ctx.stroke(road._mergeOuterEdgePath);
    if (road._mergeAsymmetric && ctx.setLineDash) {
      ctx.setLineDash([6, 8]);
    }
    if (road._mergeInnerEdgePath) ctx.stroke(road._mergeInnerEdgePath);
    if (ctx.setLineDash) ctx.setLineDash(prevDash || []);
    return;
  }

  // ---- Pass 4: visible chunks -------------------------------------------
  let visibleChunks: RoadChunk[] | null = null;
  if (road._chunks) {
    // viewR + 1-second-of-460-units margin (top-speed lookahead).
    const cm = viewR + 460;
    visibleChunks = [];
    for (let ci = 0; ci < road._chunks.length; ci++) {
      const cb = road._chunks[ci].bbox;
      if (cb.maxX < smoothFocusX - cm || cb.minX > smoothFocusX + cm
          || cb.maxY < smoothFocusY - cm || cb.minY > smoothFocusY + cm) continue;
      visibleChunks.push(road._chunks[ci]);
    }
  }

  /** Strokes either the visible chunks (if chunked) or the full mainPath. */
  const strokeWide = (): void => {
    if (visibleChunks) {
      for (const ck of visibleChunks) ctx.stroke(ck.mainPath);
      incStroke(visibleChunks.length);
    } else if (mainPath) {
      ctx.stroke(mainPath);
      incStroke(1); incFullPath(1);
    } else {
      ctx.beginPath();
      traceRoadPath(ctx, pts, TILE);
      ctx.stroke();
      incStroke(1); incFullPath(1);
    }
  };

  /** Tile-coord proximity test against any bridge-crossing point. */
  const nearBridge = (tx: number, ty: number): boolean => {
    for (const bp of bPts) {
      const dd = (tx - bp.x) ** 2 + (ty - bp.y) ** 2;
      if (dd < BRIDGE_R_SQ) return true;
    }
    return false;
  };

  // ---- Pass 5: main asphalt stroke --------------------------------------
  ctx.lineWidth = rw;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  if (Array.isArray(road.materialOverrides) && road.materialOverrides.length > 0) {
    // Per-segment material loop. Round caps so adjacent same-material
    // segments visually join cleanly.
    const N = pts.length;
    ctx.lineCap = 'round';
    for (let s = 0; s < N - 1; s++) {
      const eff = effectiveMaterialAge(road, s);
      ctx.strokeStyle = getAsphaltPattern(ctx, !!road.maj, false, eff.age, eff.material);
      ctx.beginPath();
      ctx.moveTo(pts[s][0] * TILE + TILE / 2, pts[s][1] * TILE + TILE / 2);
      ctx.lineTo(pts[s + 1][0] * TILE + TILE / 2, pts[s + 1][1] * TILE + TILE / 2);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  } else {
    ctx.strokeStyle = getAsphaltPattern(ctx, !!road.maj, false, roadAge(road), roadMaterial(road));
    strokeWide();
  }

  // ---- Pass 6: auto-taper polygon fill + flared stripes -----------------
  if (road._autoTaperStartPolyPath || road._autoTaperEndPolyPath) {
    const taperFill = getAsphaltPattern(ctx, !!road.maj, false, roadAge(road), roadMaterial(road));
    ctx.fillStyle = taperFill;
    if (road._autoTaperStartPolyPath) ctx.fill(road._autoTaperStartPolyPath);
    if (road._autoTaperEndPolyPath)   ctx.fill(road._autoTaperEndPolyPath);
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'square';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(240,240,240,0.78)';
    const prevDash = ctx.getLineDash ? ctx.getLineDash() : null;
    if (ctx.setLineDash) ctx.setLineDash([]);
    const stsO = road._autoTaperStartOuterStripePath || road._autoTaperStartOuterPath;
    const stsI = road._autoTaperStartInnerStripePath || road._autoTaperStartInnerPath;
    const eteO = road._autoTaperEndOuterStripePath   || road._autoTaperEndOuterPath;
    const eteI = road._autoTaperEndInnerStripePath   || road._autoTaperEndInnerPath;
    if (stsO) ctx.stroke(stsO);
    if (stsI) ctx.stroke(stsI);
    if (eteO) ctx.stroke(eteO);
    if (eteI) ctx.stroke(eteI);
    if (ctx.setLineDash) ctx.setLineDash(prevDash || []);
  }

  // ---- Pass 7+8: lane-aware tire wear + oil drip ------------------------
  // Major roads only — minor city streets have too much wheel-path variance.
  // Each feature gets 3 passes: solid baseline + 2 dashed emphases at
  // co-prime dash periods so the combined visible pattern doesn't repeat
  // within a practical drive.
  if (road.maj && prof.lps >= 2) {
    ctx.lineCap = 'butt';
    const baseWearW = Math.max(2, prof.laneW * TILE * 0.18);
    const baseOilW  = Math.max(0.5, prof.laneW * TILE * 0.025);
    const useChunked = !!(visibleChunks && road._chunks && road._chunks[0] && road._chunks[0].wearPaths);

    // WEAR pass 1: solid baseline.
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.lineWidth = baseWearW * 0.65;
    ctx.strokeStyle = 'rgba(0,0,0,0.07)';
    if (useChunked && visibleChunks) {
      for (const ck of visibleChunks) {
        if (!ck.wearPaths) continue;
        for (const wp of ck.wearPaths) {
          ctx.stroke(wp);
          incStroke(1);
        }
      }
    } else if (road._wearPaths && road._wearPaths.length > 0) {
      for (const wp of road._wearPaths) {
        ctx.stroke(wp);
        incStroke(1); incFullPath(1);
      }
    }

    // WEAR pass 2: dashed emphasis (sum 460).
    ctx.setLineDash([70, 35, 45, 60, 90, 30, 50, 80]);
    ctx.lineWidth = baseWearW * 1.15;
    ctx.strokeStyle = 'rgba(0,0,0,0.13)';
    if (useChunked && visibleChunks) {
      for (const ck of visibleChunks) {
        if (!ck.wearPaths) continue;
        const ckBase = ck.dashLen || 0;
        for (let pi = 0; pi < ck.wearPaths.length; pi++) {
          ctx.lineDashOffset = ckBase + pi * 37;
          ctx.stroke(ck.wearPaths[pi]);
          incStroke(1);
        }
      }
    } else if (road._wearPaths && road._wearPaths.length > 0) {
      for (let pi = 0; pi < road._wearPaths.length; pi++) {
        ctx.lineDashOffset = pi * 37;
        ctx.stroke(road._wearPaths[pi]);
        incStroke(1); incFullPath(1);
      }
    }

    // WEAR pass 3: secondary dashed emphasis (sum 397, prime, co-prime to 460).
    ctx.setLineDash([55, 25, 70, 40, 65, 35, 50, 57]);
    ctx.lineWidth = baseWearW * 0.85;
    ctx.strokeStyle = 'rgba(0,0,0,0.10)';
    if (useChunked && visibleChunks) {
      for (const ck of visibleChunks) {
        if (!ck.wearPaths) continue;
        const ckBase = ck.dashLen || 0;
        for (let pi = 0; pi < ck.wearPaths.length; pi++) {
          ctx.lineDashOffset = ckBase + pi * 31 + 100;
          ctx.stroke(ck.wearPaths[pi]);
          incStroke(1);
        }
      }
    } else if (road._wearPaths && road._wearPaths.length > 0) {
      for (let pi = 0; pi < road._wearPaths.length; pi++) {
        ctx.lineDashOffset = pi * 31 + 100;
        ctx.stroke(road._wearPaths[pi]);
        incStroke(1); incFullPath(1);
      }
    }

    // OIL pass 1: solid baseline.
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.lineWidth = baseOilW * 0.55;
    ctx.strokeStyle = 'rgba(8,5,2,0.20)';
    if (useChunked && visibleChunks) {
      for (const ck of visibleChunks) {
        if (!ck.oilPaths) continue;
        for (const op of ck.oilPaths) {
          ctx.stroke(op);
          incStroke(1);
        }
      }
    } else if (road._oilPaths && road._oilPaths.length > 0) {
      for (const op of road._oilPaths) {
        ctx.stroke(op);
        incStroke(1); incFullPath(1);
      }
    }

    // OIL pass 2: dashed emphasis (sum 450).
    ctx.setLineDash([55, 70, 30, 90, 40, 50, 80, 35]);
    ctx.lineWidth = baseOilW * 1.10;
    ctx.strokeStyle = 'rgba(8,5,2,0.42)';
    if (useChunked && visibleChunks) {
      for (const ck of visibleChunks) {
        if (!ck.oilPaths) continue;
        const ckBase = ck.dashLen || 0;
        for (let pi = 0; pi < ck.oilPaths.length; pi++) {
          ctx.lineDashOffset = ckBase + pi * 73 + 200;
          ctx.stroke(ck.oilPaths[pi]);
          incStroke(1);
        }
      }
    } else if (road._oilPaths && road._oilPaths.length > 0) {
      for (let pi = 0; pi < road._oilPaths.length; pi++) {
        ctx.lineDashOffset = pi * 73 + 200;
        ctx.stroke(road._oilPaths[pi]);
        incStroke(1); incFullPath(1);
      }
    }

    // OIL pass 3: secondary dashed emphasis (sum 401, prime, co-prime to 450).
    ctx.setLineDash([45, 60, 35, 80, 25, 55, 70, 31]);
    ctx.lineWidth = baseOilW * 0.85;
    ctx.strokeStyle = 'rgba(8,5,2,0.30)';
    if (useChunked && visibleChunks) {
      for (const ck of visibleChunks) {
        if (!ck.oilPaths) continue;
        const ckBase = ck.dashLen || 0;
        for (let pi = 0; pi < ck.oilPaths.length; pi++) {
          ctx.lineDashOffset = ckBase + pi * 67 + 50;
          ctx.stroke(ck.oilPaths[pi]);
          incStroke(1);
        }
      }
    } else if (road._oilPaths && road._oilPaths.length > 0) {
      for (let pi = 0; pi < road._oilPaths.length; pi++) {
        ctx.lineDashOffset = pi * 67 + 50;
        ctx.stroke(road._oilPaths[pi]);
        incStroke(1); incFullPath(1);
      }
    }

    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  // ---- Pass 9: bridge concrete ------------------------------------------
  // Drawn in three sublayers per segment that's near a bridge crossing:
  // shadow (under-bridge depth cue), rim/barrier (concrete walls), and the
  // narrower drive surface (exposes rim color in the barrier zone).
  if (isElevated && bPts.length > 0) {
    const bridgeBarrierW = 0.2 * TILE;
    const bridgeOuterRW = prof.totalW * TILE;
    const bridgeDriveRW = Math.max(0, prof.totalW * TILE - 2 * bridgeBarrierW);
    const segIsNearBridge = (i: number): boolean => {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      return nearBridge(mx, my) || nearBridge(pts[i][0], pts[i][1])
          || nearBridge(pts[i + 1][0], pts[i + 1][1]);
    };
    const strokeSeg = (i: number): void => {
      ctx.beginPath();
      ctx.moveTo(pts[i][0] * TILE + TILE / 2, pts[i][1] * TILE + TILE / 2);
      ctx.lineTo(pts[i + 1][0] * TILE + TILE / 2, pts[i + 1][1] * TILE + TILE / 2);
      ctx.stroke();
    };
    ctx.lineCap = 'butt';
    // Shadow.
    ctx.lineWidth = bridgeOuterRW + 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    for (let i = 0; i < pts.length - 1; i++) {
      if (segIsNearBridge(i)) strokeSeg(i);
    }
    // Rim + barrier zone.
    ctx.lineWidth = bridgeOuterRW + 3;
    ctx.strokeStyle = '#888884';
    for (let i = 0; i < pts.length - 1; i++) {
      if (segIsNearBridge(i)) strokeSeg(i);
    }
    // Drive surface (narrower — exposes rim color as barriers).
    ctx.lineWidth = bridgeDriveRW;
    ctx.strokeStyle = '#6a6a68';
    for (let i = 0; i < pts.length - 1; i++) {
      if (segIsNearBridge(i)) strokeSeg(i);
    }
    ctx.lineCap = 'round';
  }

  // ---- Pass 10: major-road edge band tint -------------------------------
  if (road.maj) {
    ctx.lineWidth = rw + 2;
    ctx.strokeStyle = 'rgba(80,80,80,0.4)';
    strokeWide();
  }

  // ---- Pass 11: I-485 grass median --------------------------------------
  if (road.name === 'I-485' && prof.effectiveMedHalf > 0) {
    ctx.lineWidth = prof.effectiveMedHalf * 2 * TILE;
    ctx.strokeStyle = '#1a3a1a';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeWide();
  }

  // ---- Pass 12: I-77/I-85 jersey barrier --------------------------------
  if (road.w >= 12 && road.name !== 'I-485') {
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#555';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    strokeWide();
  }

  // ---- Pass 13: yellow centerline (non-interstate) ----------------------
  // H885: yellow center = opposing-traffic divider — only on TWO-WAY roads.
  // A flagged one-way road or an inherently single-lane road (lps===1) gets
  // white markings only, no center line.
  const hasMedian = road.name === 'I-485' || road.w >= 12;
  const oneWay = !!road.oneway || prof.lps === 1;
  if (road.w >= 3 && !hasMedian && !oneWay) {
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#f0c83a';
    strokeWide();
  }

  // ---- Pass 14: lane dividers (chunked or fallback) ---------------------
  if (prof.lps >= 2) {
    if (visibleChunks && road._chunks && road._chunks[0] && road._chunks[0].dividerPaths) {
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 8]);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      for (const ck of visibleChunks) {
        if (!ck.dividerPaths) continue;
        ctx.lineDashOffset = ck.dashLen || 0;
        for (const dp of ck.dividerPaths) {
          ctx.stroke(dp);
          incStroke(1);
        }
      }
      ctx.lineDashOffset = 0;
      ctx.setLineDash([]);
    } else if (road._dividerPaths && road._dividerPaths.length > 0) {
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 8]);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      for (const dp of road._dividerPaths) {
        ctx.stroke(dp);
        incStroke(1); incFullPath(1);
      }
      ctx.setLineDash([]);
    } else {
      // Fallback: legacy per-frame sampling. Reached only if both chunk
      // and full-road divider paths are missing — shouldn't hit in normal
      // play.
      ctx.lineWidth = 1.2;
      ctx.setLineDash([6, 8]);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      const offsets = prof.dividers.map((d) => d * TILE);
      const txf = (i: number): number => pts[i][0] * TILE + TILE / 2;
      const tyf = (i: number): number => pts[i][1] * TILE + TILE / 2;
      for (const off of offsets) {
        ctx.beginPath();
        const samples: Array<[number, number]> = [];
        if (pts.length === 2) {
          samples.push([txf(0), tyf(0)], [txf(1), tyf(1)]);
        } else {
          const STEPS_PER_SEG = 12;
          samples.push([txf(0), tyf(0)]);
          const mx0 = (txf(0) + txf(1)) / 2;
          const my0 = (tyf(0) + tyf(1)) / 2;
          samples.push([mx0, my0]);
          for (let i = 1; i < pts.length - 2; i++) {
            const prevMx = (txf(i - 1) + txf(i)) / 2;
            const prevMy = (tyf(i - 1) + tyf(i)) / 2;
            const nextMx = (txf(i) + txf(i + 1)) / 2;
            const nextMy = (tyf(i) + tyf(i + 1)) / 2;
            const p0x = prevMx, p0y = prevMy;
            const cpx = txf(i), cpy = tyf(i);
            const p1x = nextMx, p1y = nextMy;
            for (let s = 1; s <= STEPS_PER_SEG; s++) {
              const t = s / STEPS_PER_SEG;
              const u = 1 - t;
              samples.push([u * u * p0x + 2 * u * t * cpx + t * t * p1x,
                            u * u * p0y + 2 * u * t * cpy + t * t * p1y]);
            }
          }
          {
            const li = pts.length - 2;
            const prevMx = (txf(li - 1) + txf(li)) / 2;
            const prevMy = (tyf(li - 1) + tyf(li)) / 2;
            const p0x = prevMx, p0y = prevMy;
            const cpx = txf(li), cpy = tyf(li);
            const p1x = txf(li + 1), p1y = tyf(li + 1);
            for (let s = 1; s <= STEPS_PER_SEG; s++) {
              const t = s / STEPS_PER_SEG;
              const u = 1 - t;
              samples.push([u * u * p0x + 2 * u * t * cpx + t * t * p1x,
                            u * u * p0y + 2 * u * t * cpy + t * t * p1y]);
            }
          }
        }
        for (let s = 0; s < samples.length; s++) {
          const prev = samples[Math.max(0, s - 1)];
          const next = samples[Math.min(samples.length - 1, s + 1)];
          const tdx = next[0] - prev[0];
          const tdy = next[1] - prev[1];
          const tlen = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
          const nx = -tdy / tlen;
          const ny = tdx / tlen;
          const ox = samples[s][0] + nx * off;
          const oy = samples[s][1] + ny * off;
          if (s === 0) ctx.moveTo(ox, oy);
          else ctx.lineTo(ox, oy);
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }

  // ---- Pass 15: white outer edge stripes --------------------------------
  if (prof.edgeOffsets && prof.edgeOffsets.length > 0) {
    const prevCap = ctx.lineCap;
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.lineCap = 'square';
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(255,255,255,0.78)';
    if (visibleChunks && road._chunks && road._chunks[0] && road._chunks[0].edgePaths) {
      for (const ck of visibleChunks) {
        if (!ck.edgePaths) continue;
        for (const ep of ck.edgePaths) {
          ctx.stroke(ep);
          incStroke(1);
        }
      }
    } else if (road._edgePaths && road._edgePaths.length > 0) {
      for (const ep of road._edgePaths) {
        ctx.stroke(ep);
        incStroke(1); incFullPath(1);
      }
    }
    ctx.lineCap = prevCap;
  }

  // ---- Pass 16: T-junction edge break (erase) ---------------------------
  if (road._teeEdgeErasePaths && road._teeEdgeErasePaths.length > 0) {
    ctx.lineCap = 'butt';
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = getAsphaltPattern(ctx, !!road.maj, false, roadAge(road), roadMaterial(road));
    const prevDash = ctx.getLineDash ? ctx.getLineDash() : null;
    if (ctx.setLineDash) ctx.setLineDash([]);
    for (const ep of road._teeEdgeErasePaths) ctx.stroke(ep);
    if (ctx.setLineDash) ctx.setLineDash(prevDash || []);
  }

  // ---- Pass 17: taper lane-addition dashed stripe -----------------------
  if (road._autoTaperStartLaneAddPathPlus  || road._autoTaperStartLaneAddPathMinus
   || road._autoTaperEndLaneAddPathPlus    || road._autoTaperEndLaneAddPathMinus) {
    ctx.lineCap = 'butt';
    ctx.lineWidth = 2.4;
    ctx.strokeStyle = getAsphaltPattern(ctx, !!road.maj, false, roadAge(road), roadMaterial(road));
    const prevDash = ctx.getLineDash ? ctx.getLineDash() : null;
    if (ctx.setLineDash) ctx.setLineDash([]);
    if (road._autoTaperStartLaneAddPathPlus)  ctx.stroke(road._autoTaperStartLaneAddPathPlus);
    if (road._autoTaperStartLaneAddPathMinus) ctx.stroke(road._autoTaperStartLaneAddPathMinus);
    if (road._autoTaperEndLaneAddPathPlus)    ctx.stroke(road._autoTaperEndLaneAddPathPlus);
    if (road._autoTaperEndLaneAddPathMinus)   ctx.stroke(road._autoTaperEndLaneAddPathMinus);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(240,240,240,0.78)';
    if (ctx.setLineDash) ctx.setLineDash([6, 8]);
    if (road._autoTaperStartLaneAddPathPlus)  ctx.stroke(road._autoTaperStartLaneAddPathPlus);
    if (road._autoTaperStartLaneAddPathMinus) ctx.stroke(road._autoTaperStartLaneAddPathMinus);
    if (road._autoTaperEndLaneAddPathPlus)    ctx.stroke(road._autoTaperEndLaneAddPathPlus);
    if (road._autoTaperEndLaneAddPathMinus)   ctx.stroke(road._autoTaperEndLaneAddPathMinus);
    if (ctx.setLineDash) ctx.setLineDash(prevDash || []);
  }

  // ---- Pass 18: yellow inner-edge stripes (divided highways) ------------
  if (prof.innerEdgeOffsets && prof.innerEdgeOffsets.length > 0) {
    const prevCap = ctx.lineCap;
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
    ctx.lineCap = 'butt';
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(240,200,58,0.85)';
    if (visibleChunks && road._chunks && road._chunks[0] && road._chunks[0].innerEdgePaths) {
      for (const ck of visibleChunks) {
        if (!ck.innerEdgePaths) continue;
        for (const ip of ck.innerEdgePaths) {
          ctx.stroke(ip);
          incStroke(1);
        }
      }
    } else if (road._innerEdgePaths && road._innerEdgePaths.length > 0) {
      for (const ip of road._innerEdgePaths) {
        ctx.stroke(ip);
        incStroke(1); incFullPath(1);
      }
    }
    ctx.lineCap = prevCap;
  }

  // ---- Pass 19: merge chevron pass --------------------------------------
  if (road.merge) {
    const CHEVRON_SPACING  = 3.0 * TILE;
    const CHEVRON_DEPTH    = 1.0 * TILE;
    const CHEVRON_HALF_W   = 0.55 * TILE;
    const CHEVRON_SKIP_END = 1.5 * TILE;
    const cullR  = viewR * 1.6;
    const cullR2 = cullR * cullR;
    let totLen = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0]     * TILE + TILE / 2;
      const ay = pts[i][1]     * TILE + TILE / 2;
      const bx = pts[i + 1][0] * TILE + TILE / 2;
      const by = pts[i + 1][1] * TILE + TILE / 2;
      totLen += Math.hypot(bx - ax, by - ay);
    }
    const skipEnd = totLen - CHEVRON_SKIP_END;
    if (skipEnd > CHEVRON_SKIP_END) {
      const prevWidth  = ctx.lineWidth;
      const prevCapM   = ctx.lineCap;
      const prevStroke = ctx.strokeStyle;
      const prevDash   = ctx.getLineDash ? ctx.getLineDash() : null;
      ctx.lineWidth   = 2;
      ctx.lineCap     = 'round';
      ctx.strokeStyle = 'rgba(240,240,240,0.85)';
      if (ctx.setLineDash) ctx.setLineDash([]);
      let traveled = 0;
      let nextAt   = CHEVRON_SKIP_END;
      for (let i = 0; i < pts.length - 1 && nextAt < skipEnd; i++) {
        const ax = pts[i][0]     * TILE + TILE / 2;
        const ay = pts[i][1]     * TILE + TILE / 2;
        const bx = pts[i + 1][0] * TILE + TILE / 2;
        const by = pts[i + 1][1] * TILE + TILE / 2;
        const dx = bx - ax;
        const dy = by - ay;
        const segLen = Math.hypot(dx, dy);
        if (segLen < 0.01) continue;
        const tx = dx / segLen;
        const ty = dy / segLen;
        const nx = -ty;
        const ny =  tx;
        const segEnd = traveled + segLen;
        while (nextAt < segEnd && nextAt < skipEnd) {
          const f = (nextAt - traveled) / segLen;
          const cx = ax + dx * f;
          const cy = ay + dy * f;
          const ddx = cx - smoothFocusX;
          const ddy = cy - smoothFocusY;
          if (ddx * ddx + ddy * ddy <= cullR2) {
            const tipX = cx + tx * CHEVRON_DEPTH * 0.5;
            const tipY = cy + ty * CHEVRON_DEPTH * 0.5;
            const tlx  = cx - tx * CHEVRON_DEPTH * 0.5 + nx * CHEVRON_HALF_W;
            const tly  = cy - ty * CHEVRON_DEPTH * 0.5 + ny * CHEVRON_HALF_W;
            const trx  = cx - tx * CHEVRON_DEPTH * 0.5 - nx * CHEVRON_HALF_W;
            const try_ = cy - ty * CHEVRON_DEPTH * 0.5 - ny * CHEVRON_HALF_W;
            ctx.beginPath();
            ctx.moveTo(tlx, tly);
            ctx.lineTo(tipX, tipY);
            ctx.lineTo(trx, try_);
            ctx.stroke();
            incStroke(1);
          }
          nextAt += CHEVRON_SPACING;
        }
        traveled = segEnd;
      }
      ctx.lineWidth   = prevWidth;
      ctx.lineCap     = prevCapM;
      ctx.strokeStyle = prevStroke;
      if (ctx.setLineDash && prevDash) ctx.setLineDash(prevDash);
    }
  }
}
