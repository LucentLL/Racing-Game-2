export type GearPattern = readonly number[];

export const GEAR_PATTERNS: Record<number, GearPattern> = {
  4: [0.25, 0.45, 0.70, 1.0],
  5: [0.20, 0.35, 0.53, 0.76, 1.0],
  6: [0.17, 0.28, 0.42, 0.58, 0.78, 1.0],
  7: [0.15, 0.24, 0.35, 0.48, 0.63, 0.80, 1.0],
};
