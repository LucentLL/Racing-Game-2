/**
 * SVG RPM gauge — mobile top-left dial + wheel-interior variant.
 *
 * Two consumer surfaces share this module because they share the same
 * tick/label/redline-arc geometry:
 *   - top-left mobile dial (#mobileRpmSvg) — the "primary" RPM widget on
 *     mobile after v8.99.124.13 relocation.
 *   - wheel-interior variant (#wheelRpmSvg) — kept as legacy fallback;
 *     v8.99.123.74 made the top-left dial the canonical mobile site.
 *
 * Per-frame side effects:
 *   - rotate the needle to the current RPM,
 *   - mirror the gear text into the shift-knob recess (#skGearText). The
 *     reverse-encoding rule is: pGear===0 IS reverse (engine encodes
 *     reverse as gear 0; there is no gear -1). The legacy gear-text
 *     element on the RPM dial itself was removed in v8.99.123.97 — guard
 *     the write so it's a no-op when the element is missing.
 *
 * Ported from monolith L22619-22710 (mobile RPM) + the wheel-interior
 * variant near L23041 (`_buildWheelRpmGauge`).
 *
 * SCAFFOLD status: type contract + public entry points. SVG-string
 * assembly + element caching stubbed with TODO line refs.
 */

/** Per-frame inputs for the RPM needle + gear-text update. */
export interface RpmGaugeOpts {
  /** Current engine RPM. */
  rpm: number;
  /** Engine redline (sets the dial range). */
  redline: number;
  /** Selected gear: 0=R, positive=forward gear. (Engine encodes reverse
   *  as 0 — there is no -1 state. See v8.99.124.17 fix.) */
  gear: number;
  /** Active manual override (manualGearTimer > 0). When true `manualGear`
   *  takes priority over `gear` for the shift-knob text. */
  manualOverrideActive: boolean;
  /** Manual override gear value (only consulted when manualOverrideActive). */
  manualGear: number;
  /** True when display_failure fault hides the gauges. */
  hideGauges: boolean;
}

/** CSS positioning inputs. */
export interface RpmGaugeGeometry {
  /** True for body.mob, false for body.pc. */
  isMobile: boolean;
  /** HUD canvas internal width (HUD_W). */
  hudW: number;
}

/** Builds the static tick marks + speed labels + redline arc for the
 *  TOP-LEFT mobile RPM dial. Called once per redline change — typically
 *  only on car switch. TODO(D27-followup): port from L22619-22645. */
export function buildMobileRpmGauge(_redline: number): void {
  // TODO: L22619-22645. Uses startDeg=135, sweepDeg=270, redlineFrac=0.80.
}

/** Builds the wheel-interior RPM variant (legacy site). Same geometry as
 *  the mobile gauge — separate parent SVG element.
 *  TODO(D27-followup): port from the _buildWheelRpmGauge body near L23041. */
export function buildWheelRpmGauge(_redline: number): void {
  // TODO: locate _buildWheelRpmGauge body near L23041 and port — geometry
  // mirrors buildMobileRpmGauge, target element differs.
}

/** Per-frame needle + gear-text update. Mobile-only — bails on body.pc.
 *  Rebuilds static content via buildMobileRpmGauge() if redline changed;
 *  updates needle rotation; mirrors gear text into #skGearText with
 *  reverse-aware coloring (R=#f80, digits=#fff).
 *  TODO(D27-followup): port from L22646-22710. */
export function updateMobileRpm(_opts: RpmGaugeOpts): void {
  // TODO: L22646-22710. Note v8.99.124.17 reverse rule: pGear===0 → 'R'.
}

/** Recomputes left/top/width/height for both the top-left dial and the
 *  wheel-interior variant. Mobile sizes from #steerBar bounding box;
 *  PC sizes to match the previous canvas RPM cluster's footprint.
 *  TODO(D27-followup): port from L22711+. */
export function syncMobileRpmPosition(_geom: RpmGaugeGeometry): void {
  // TODO: L22711+. Position signature is cached internally so writes only
  // happen on actual change.
}
