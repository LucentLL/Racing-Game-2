/**
 * "EAT" tab — actually the full HEALTH & FITNESS surface.
 *
 * Despite the file name (per migration plan), the tab covers more than
 * eating: health + fitness bars, status warnings (hungry / starving /
 * tired / exhausted / haven't eaten today), three food tiers (junk /
 * regular / premium) with eat buttons, plus shop-for-food and the
 * gym/sleep affordances below the divider.
 *
 * Eating is INSTANT — does not consume a time slot (per the section
 * header copy). Sleep + gym below DO consume slots.
 *
 * Click hit-boxes are populated during the draw pass into
 * LIFE._eatBtnYs[] (one entry per food tier). The orchestrator's tap
 * handler reads that array — a typical canvas-renderer-emits-rects
 * pattern. The renderer + handler MUST agree on the layout, so the row
 * height (32 px per food tier) is exported as a constant rather than
 * recomputed on the click side.
 *
 * Header clip-top tweak: v8.99.34 lowered clipTop to 34 (was 30) so the
 * "❤️ HEALTH & FITNESS" title at y=38 isn't sliced off.
 *
 * Ported from monolith L48854-end of eat tab.
 *
 * SCAFFOLD status: type contract + entry point stubbed with TODO line
 * refs.
 */

/** Row height for each food-tier card. Shared with the tap handler. */
export const FOOD_ROW_H = 32;
/** Top of the clipped scroll region (v8.99.34 — was 30). */
export const EAT_CLIP_TOP = 34;

/** Health-status badge (color + label + icon, from getHealthStatus()). */
export interface HealthStatus {
  color: string;
  label: string;
  icon: string;
}

/** Per-frame inputs for the eat / health tab. */
export interface EatOpts {
  health: number;
  fitness: number;
  healthStatus: HealthStatus;
  fitnessStatus: HealthStatus;
  /** Days since the player last ate / slept. Drives status warnings. */
  daysSinceEat: number;
  daysSinceSleep: number;
  /** True after the player ate this day — eat buttons disable. */
  ateToday: boolean;
  /** Total food on hand (sum of foodStock). Drives "haven't eaten today"
   *  warning visibility — only shows when player HAS food but didn't eat. */
  totalFood: number;
  /** Food stock per tier. */
  foodStock: { junk: number; regular: number; premium: number };
  /** Scroll offset (LIFE._scrollY — shared per-tab). */
  scrollY: number;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
  BACK_ZONE: number;
}

/** Single eat-button rect emitted into LIFE._eatBtnYs by the draw pass. */
export interface EatBtnRect {
  /** Top y of the food-tier card. */
  y: number;
  /** Tier key — 'junk' | 'regular' | 'premium'. */
  key: 'junk' | 'regular' | 'premium';
  /** True when this tier is currently eatable (qty>0 && !ateToday). */
  canEat: boolean;
}

/** Side effects the draw pass needs. */
export interface EatDeps {
  /** Replaces LIFE._eatBtnYs with the rects emitted this frame. */
  setEatBtnYs(rects: EatBtnRect[]): void;
}

/** Draws the eat / health tab — bars, warnings, three food tiers, and
 *  the shop / gym / sleep affordances below.
 *  TODO(D29-followup): port from L48854-end of eat tab. */
export function drawHomeEat(
  _ctx: CanvasRenderingContext2D,
  _opts: EatOpts,
  _deps: EatDeps,
): void {
  // TODO: L48854-end of eat tab. Order: bars (health, fitness) → status
  // line → DIVIDER: EAT → 3 food tiers (emits LIFE._eatBtnYs) → DIVIDER:
  // SHOP → grocery shop → DIVIDER: REST → gym + sleep. Eating is instant;
  // gym + sleep consume time slots.
}
