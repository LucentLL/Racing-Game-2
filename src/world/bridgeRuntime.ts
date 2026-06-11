/**
 * H785: runtime home for the bridge layer system.
 *
 * bridgeGeometry.ts is a complete 1:1 port of the monolith's bridge
 * collision + layer-transition pipeline (barriers, triggers, decks,
 * synthetic structures for editor-drawn elevated roads) — but until
 * this hop nothing imported it, so "elevated" roads were a pure
 * render-order illusion: no drive-under, no barriers, and editor
 * bridges behaved like painted ground roads.
 *
 * This module owns the canonical mutable state the monolith kept as
 * globals:
 *   - BRIDGE_STRUCTURES — the structure list bridgeBlocked /
 *     bridgeUpdateLayer / bridgeCarUnderElevated consume.
 *   - BRIDGE_ROADS — the road list bridgeUpdateLayer uses to resolve
 *     a structure's upperRoadName back to its polyline (heading-
 *     alignment sanity check).
 *   - playerBridgeLayer — the player's bridge layer (0 = ground,
 *     1 = elevated deck). Distinct from player.layerZ, which is the
 *     RENDER z; the layer is the COLLISION/transition state that
 *     playerLayerZAt alone can't express ("under the bridge" vs "on
 *     the bridge" at the same x,y).
 *
 * rebuildBridgeStructures is called from rebuildRenderEntries so the
 * structures stay in sync with every road-set change (boot, editor
 * commits, deletes, resets).
 */

import {
  bridgeAddAllSynthetic,
  type BridgeStructureMade,
  type BridgeRoadFull,
  type PlayerLayerState,
} from './bridgeGeometry';

export const BRIDGE_STRUCTURES: BridgeStructureMade[] = [];
export const BRIDGE_ROADS: BridgeRoadFull[] = [];

/** Player's bridge layer — 0 ground, 1 elevated deck. Reset to 0 on
 *  rebuild so a road edit under the player can't strand layer=1. */
export const playerBridgeLayer: PlayerLayerState = { layer: 0 };

export function rebuildBridgeStructures(
  roads: ReadonlyArray<BridgeRoadFull>,
): void {
  BRIDGE_ROADS.length = 0;
  for (const r of roads) BRIDGE_ROADS.push(r);
  BRIDGE_STRUCTURES.length = 0;
  // _prof is pre-populated by the caller (lane-standardized asphalt
  // width); the fallback only fires for degenerate rows.
  bridgeAddAllSynthetic(BRIDGE_STRUCTURES, BRIDGE_ROADS, (r) => ({
    totalW: r._prof?.totalW ?? 4,
  }));
  playerBridgeLayer.layer = 0;
}
