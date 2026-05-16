/**
 * Torque-curve interpolation at a target RPM. 1:1 port of monolith
 * getTorqueAtRPM at L6799-6812. Returns a normalized 0..1 torque
 * multiplier matching the curve's shape — peak torque returns 1.0,
 * off-peak RPMs return proportionally less. Cars with no GT4 spec
 * data (empty rpms array) return 0.75, matching the monolith's
 * fallback at L6801.
 *
 * Linear interp between adjacent samples. The curves are short (4-15
 * points typically), so a linear scan is faster than a binary search.
 */

/** Lookup torque at the given RPM. rpms must be sorted ascending and
 *  same-length as norms; caller guarantees this (catalog.ts builds
 *  them via decodeTorqueCurve). Out-of-range RPMs clamp to the
 *  curve's endpoints. */
export function getTorqueAtRPM(
  rpms: readonly number[],
  norms: readonly number[],
  rpm: number,
): number {
  if (rpms.length < 2) return 0.75;
  if (rpm <= rpms[0]) return norms[0];
  const last = rpms.length - 1;
  if (rpm >= rpms[last]) return norms[last];
  for (let i = 0; i < last; i++) {
    if (rpm <= rpms[i + 1]) {
      const t = (rpm - rpms[i]) / (rpms[i + 1] - rpms[i]);
      return norms[i] * (1 - t) + norms[i + 1] * t;
    }
  }
  return norms[last];
}
