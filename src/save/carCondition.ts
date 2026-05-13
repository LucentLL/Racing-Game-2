import type { LifeState } from '@/state/life';

export interface CarConditionData {
  engine: number;
  tires: number;
  carHP: number;
  paint: number;
  fuel: number;
  faults: unknown[];
  hiddenFaults: unknown[];
  hiddenFaultOdo: number;
  welded: boolean;
  supercharged: boolean;
  isManual: boolean;
  bodyDamage: unknown;
  rhdOverride?: boolean;
}

/**
 * Snapshot the active car's live condition from LIFE.* into a CarConditionData
 * record. Called before any car switch or save, and on tick-rate persistence
 * for the active car.
 */
export function saveCarCondition(
  id: string,
  life: LifeState,
  activeCar: string,
  carConditions: Record<string, CarConditionData>,
  makeFreshBodyDamage: () => unknown,
): void {
  if (!id) return;

  let prevRHD: boolean | undefined;
  if (id === activeCar && typeof life.rhdOverride === 'boolean') {
    prevRHD = life.rhdOverride;
  } else if (carConditions[id] && typeof carConditions[id].rhdOverride === 'boolean') {
    prevRHD = carConditions[id].rhdOverride;
  }

  const record: CarConditionData = {
    engine: life.engine,
    tires: life.tires,
    carHP: life.carHP,
    paint: life.paint,
    fuel: life.fuel,
    faults: JSON.parse(JSON.stringify(life.faults)) as unknown[],
    hiddenFaults: JSON.parse(JSON.stringify(life._hiddenFaults ?? [])) as unknown[],
    hiddenFaultOdo: life._hiddenFaultOdo ?? 0,
    welded: !!life.welded,
    supercharged: !!life.supercharged,
    isManual: !!life.isManual,
    bodyDamage: JSON.parse(JSON.stringify(life.bodyDamage ?? makeFreshBodyDamage())),
  };
  if (prevRHD !== undefined) record.rhdOverride = prevRHD;

  carConditions[id] = record;
}

export interface CarSpecLike {
  defaultManual?: boolean;
}

/**
 * Restore the active car's condition from carConditions[id] into LIFE.*,
 * or seed defaults derived from odometer when no record exists.
 */
export function loadCarCondition(
  id: string,
  life: LifeState,
  carConditions: Record<string, CarConditionData>,
  carOdometers: Record<string, number>,
  cars: Record<string, CarSpecLike>,
  makeFreshBodyDamage: () => unknown,
): void {
  const c = carConditions[id];
  if (c) {
    life.engine = c.engine;
    life.tires = c.tires;
    life.carHP = c.carHP;
    life.paint = c.paint;
    life.fuel = c.fuel;
    life.faults = JSON.parse(JSON.stringify(c.faults ?? [])) as unknown[];
    life._hiddenFaults = JSON.parse(JSON.stringify(c.hiddenFaults ?? [])) as unknown[];
    life._hiddenFaultOdo = c.hiddenFaultOdo ?? 0;
    life.welded = !!c.welded;
    life.supercharged = !!c.supercharged;
    if (typeof c.isManual === 'boolean') {
      life.isManual = c.isManual;
    } else {
      life.isManual = !!(cars[id] && cars[id].defaultManual);
    }
    life.rhdOverride = typeof c.rhdOverride === 'boolean' ? c.rhdOverride : null;
    life.bodyDamage = c.bodyDamage
      ? JSON.parse(JSON.stringify(c.bodyDamage))
      : makeFreshBodyDamage();
  } else {
    const odoMi = (carOdometers[id] || 0) * 0.0001278;
    const cond = Math.max(15, Math.round(100 - odoMi / 3000));
    life.engine = cond;
    life.tires = cond;
    life.carHP = cond;
    life.paint = cond;
    life.fuel = 30 + Math.floor(Math.random() * 40);
    life.faults = [];
    life._hiddenFaults = [];
    life._hiddenFaultOdo = carOdometers[id] || 0;
    life.bodyDamage = makeFreshBodyDamage();
    life.welded = false;
    life.supercharged = false;
    life.isManual = !!(cars[id] && cars[id].defaultManual);
    life.rhdOverride = null;
  }
}
