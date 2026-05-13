export type TorquePair = readonly [rpm: number, torque: number];
export type RawTorqueCurve = readonly number[] | readonly TorquePair[];

export interface TorqueCurveCarrier {
  tcRPMs?: readonly number[];
  tcNorm?: readonly number[];
}

export function decodeTC(raw: RawTorqueCurve | null | undefined): TorquePair[] | null {
  if (!raw || raw.length < 3) return null;
  if (
    typeof raw[0] === 'number' &&
    typeof raw[1] === 'number' &&
    typeof raw[2] === 'number'
  ) {
    const nums = raw as readonly number[];
    const start = nums[0];
    const step = nums[1];
    const pairs: TorquePair[] = [];
    for (let i = 2; i < nums.length; i++) {
      pairs.push([start + (i - 2) * step, nums[i]]);
    }
    return pairs;
  }
  if (Array.isArray(raw[0])) return raw as TorquePair[];
  return null;
}

export function getTorqueAtRPM(car: TorqueCurveCarrier, rpm: number): number {
  const rpms = car.tcRPMs;
  const vals = car.tcNorm;
  if (!rpms || !vals || rpms.length < 2) return 0.75;
  if (rpm <= rpms[0]) return vals[0];
  if (rpm >= rpms[rpms.length - 1]) return vals[vals.length - 1];
  for (let i = 0; i < rpms.length - 1; i++) {
    if (rpm <= rpms[i + 1]) {
      const t = (rpm - rpms[i]) / (rpms[i + 1] - rpms[i]);
      return vals[i] * (1 - t) + vals[i + 1] * t;
    }
  }
  return vals[vals.length - 1];
}
