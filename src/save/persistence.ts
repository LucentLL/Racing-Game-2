import type { LifeState, PlayerPose } from '@/state/life';
import type { CarConditionData, CarSpecLike } from './carCondition';
import { saveCarCondition } from './carCondition';
import { SAVE_KEY, type SaveDataV1 } from './schema';
import { gameUnitsToMiles } from '@/physics/physicsUnits';

export interface SaveContext {
  life: LifeState;
  player: PlayerPose;
  activeCar: { id: string };
  carOdometers: Record<string, number>;
  carConditions: Record<string, CarConditionData>;
  cars: Record<string, CarSpecLike & { rhd?: unknown; defaultManual?: boolean }>;
  carIds: string[];
  housingTiers: Record<string, { mortgage?: number }>;
  makeFreshBodyDamage: () => unknown;
}

export function saveGame(ctx: SaveContext, storageKey: string = SAVE_KEY): void {
  try {
    saveCarCondition(
      ctx.activeCar.id,
      ctx.life,
      ctx.activeCar.id,
      ctx.carConditions,
      ctx.makeFreshBodyDamage,
    );

    const life = ctx.life;
    const data: SaveDataV1 = {
      money: life.money,
      fuel: life.fuel,
      fuelOctane: life.fuelOctane,
      day: life.day,
      activeCar: ctx.activeCar.id,
      ownedCars: [...life.ownedCars],
      carOdometers: { ...ctx.carOdometers },
      carConditions: { ...ctx.carConditions },
      playerName: life.playerName,
      playerAlias: life.playerAlias,
      portrait: life.portrait,
      gender: life.gender || 'M',
      skinTone: life.skinTone || 1,
      playerJob: life.playerJob,
      engine: life.engine,
      tires: life.tires,
      carHP: life.carHP,
      paint: life.paint,
      health: life.health,
      fitness: life.fitness,
      daysSinceEat: life.daysSinceEat,
      daysSinceSleep: life.daysSinceSleep,
      ateToday: life.ateToday,
      lastMealTier: life.lastMealTier,
      gymVisitedToday: life.gymVisitedToday,
      lastWorkoutLevel: life.lastWorkoutLevel,
      slotsActiveToday: life.slotsActiveToday,
      foodStock: life.foodStock,
      skipStrikes: life.skipStrikes,
      _fired: life._fired,
      age: life.age,
      workRep: life.workRep,
      workDaysTotal: life.workDaysTotal,
      workDaysPresent: life.workDaysPresent,
      consecutiveAbsences: life.consecutiveAbsences,
      basePay: life.basePay,
      payMultiplier: life.payMultiplier,
      lastRaiseDay: life.lastRaiseDay,
      streetRep: life.streetRep,
      streetRacesTotal: life.streetRacesTotal,
      streetRacesWon: life.streetRacesWon,
      lastRaceDay: life.lastRaceDay,
      mechanicVisits: life.mechanicVisits,
      mechanicDiscount: life.mechanicDiscount,
      dispatcherTrust: life.dispatcherTrust,
      sceneRegular: life.sceneRegular,
      neighborhoodDays: life.neighborhoodDays,
      localDeals: life.localDeals,
      homeX: life.homeX,
      homeY: life.homeY,
      officeX: life.officeX,
      officeY: life.officeY,
      impoundedCars: life.impoundedCars ? [...life.impoundedCars] : [],
      pendingParts: life.pendingParts || [],
      ownedParts: life.ownedParts || [],
      mail: life.mail || [],
      jerryCans: life.jerryCans || 0,
      officeMenu: life.officeMenu,
      officeLeaveEarly: !!life.officeLeaveEarly,
      coffeeBuff: life.coffeeBuff || 0,
      carAds: life.carAds || [],
      faults: life.faults || [],
      px: ctx.player.px,
      py: ctx.player.py,
      pAngle: ctx.player.pAngle,
      month: life.month,
      dayOfMonth: life.dayOfMonth,
      housingType: life.housingType,
      monthlyHousingCost: life.monthlyHousingCost,
      mortgageBalance: life.mortgageBalance,
      mortgageMonthsRemaining: life.mortgageMonthsRemaining,
      missedPayments: life.missedPayments,
      garageSlots: life.garageSlots,
      carLoans: life.carLoans || [],
      bankLoans: life.bankLoans || [],
      timeSlot: life.timeSlot,
      slotsUsed: life.slotsUsed,
      sessionTimer: life.sessionTimer,
      pendingSalary: life.pendingSalary || 0,
      mechSkill: life.mechSkill || 15,
      calendarLog: life.calendarLog || [],
      newspaperSection: life.newspaperSection || 'cars',
      gameplaySettings: { ...life.gameplaySettings },
    };
    localStorage.setItem(storageKey, JSON.stringify(data));
  } catch {
    /* localStorage quota / SecurityError — swallow, monolith behaviour */
  }
}

export function loadGame(
  ctx: SaveContext,
  jsonStr?: string,
  storageKey: string = SAVE_KEY,
): boolean {
  const save = jsonStr ?? localStorage.getItem(storageKey);
  if (!save) return false;
  try {
    const d = JSON.parse(save) as SaveDataV1;
    const life = ctx.life;

    if (d.money !== undefined) life.money = d.money;
    if (d.fuel !== undefined) life.fuel = d.fuel;
    if (d.fuelOctane !== undefined) life.fuelOctane = d.fuelOctane;
    if (d.day !== undefined) life.day = d.day;
    if (d.activeCar) ctx.activeCar.id = d.activeCar;
    if (d.ownedCars) life.ownedCars = Array.from(d.ownedCars);

    // GS500 → Katana migration (v8.99.122.42)
    if (ctx.activeCar.id === 'suzuki_gs500') ctx.activeCar.id = 'suzuki_katana';
    if (life.ownedCars) {
      life.ownedCars = life.ownedCars.map((cid) =>
        cid === 'suzuki_gs500' ? 'suzuki_katana' : cid,
      );
    }

    if (d.playerName) life.playerName = d.playerName;
    if (d.playerAlias) life.playerAlias = d.playerAlias;
    if (d.portrait !== undefined) life.portrait = d.portrait;
    life.gender = d.gender === 'F' || d.gender === 'M' ? d.gender : 'M';
    life.skinTone = typeof d.skinTone === 'number' && d.skinTone >= 1 ? d.skinTone : 1;
    if (d.playerJob) life.playerJob = d.playerJob;
    if (d.engine !== undefined) life.engine = d.engine;
    if (d.tires !== undefined) life.tires = d.tires;
    if (d.carHP !== undefined) life.carHP = d.carHP;
    if (d.paint !== undefined) life.paint = d.paint;

    if (d.health !== undefined) life.health = d.health;
    if (d.fitness !== undefined) life.fitness = d.fitness;
    if (d.daysSinceEat !== undefined) life.daysSinceEat = d.daysSinceEat;
    if (d.daysSinceSleep !== undefined) life.daysSinceSleep = d.daysSinceSleep;
    if (d.ateToday !== undefined) life.ateToday = d.ateToday;
    if (d.lastMealTier) life.lastMealTier = d.lastMealTier;
    if (d.gymVisitedToday !== undefined) life.gymVisitedToday = d.gymVisitedToday;
    if (d.lastWorkoutLevel !== undefined) life.lastWorkoutLevel = d.lastWorkoutLevel;
    if (d.slotsActiveToday !== undefined) life.slotsActiveToday = d.slotsActiveToday;
    if (d.foodStock) {
      life.foodStock = d.foodStock;
    } else if (d.meals !== undefined && !d.foodStock) {
      life.foodStock = { junk: 0, regular: d.meals || 5, premium: 0 };
    }
    if (d.skipStrikes !== undefined) life.skipStrikes = d.skipStrikes;
    if (d._fired !== undefined) life._fired = d._fired;

    if (d.age !== undefined) life.age = d.age;
    if (d.workRep !== undefined) {
      life.workRep = d.workRep;
    } else if (d.skipStrikes !== undefined) {
      life.workRep = Math.max(0, 50 - d.skipStrikes * 15);
    }
    if (d.workDaysTotal !== undefined) life.workDaysTotal = d.workDaysTotal;
    if (d.workDaysPresent !== undefined) life.workDaysPresent = d.workDaysPresent;
    if (d.consecutiveAbsences !== undefined) life.consecutiveAbsences = d.consecutiveAbsences;
    if (d.basePay !== undefined) life.basePay = d.basePay;
    if (d.payMultiplier !== undefined) life.payMultiplier = d.payMultiplier;
    if (d.lastRaiseDay !== undefined) life.lastRaiseDay = d.lastRaiseDay;
    if (d.streetRep !== undefined) life.streetRep = d.streetRep;
    if (d.streetRacesTotal !== undefined) life.streetRacesTotal = d.streetRacesTotal;
    if (d.streetRacesWon !== undefined) life.streetRacesWon = d.streetRacesWon;
    if (d.lastRaceDay !== undefined) life.lastRaceDay = d.lastRaceDay;

    if (d.mechanicVisits !== undefined) life.mechanicVisits = d.mechanicVisits;
    if (d.mechanicDiscount !== undefined) life.mechanicDiscount = d.mechanicDiscount;
    if (d.dispatcherTrust !== undefined) life.dispatcherTrust = d.dispatcherTrust;
    if (d.sceneRegular !== undefined) life.sceneRegular = d.sceneRegular;
    if (d.neighborhoodDays !== undefined) life.neighborhoodDays = d.neighborhoodDays;
    if (d.localDeals !== undefined) life.localDeals = d.localDeals;
    if (d.homeX !== undefined) life.homeX = d.homeX;
    if (d.homeY !== undefined) life.homeY = d.homeY;
    if (d.officeX !== undefined) life.officeX = d.officeX;
    if (d.officeY !== undefined) life.officeY = d.officeY;

    if (d.impoundedCars) life.impoundedCars = Array.from(d.impoundedCars);
    if (d.pendingParts) life.pendingParts = d.pendingParts;
    if (d.ownedParts) life.ownedParts = d.ownedParts;
    if (d.mail) life.mail = d.mail;
    if (d.jerryCans !== undefined) life.jerryCans = d.jerryCans;
    // H216: officeMenu narrowed to typed shape. Validate before
    // assigning so a corrupt save doesn't write a malformed
    // object — fall through to null which clears any stale state.
    if (d.officeMenu === null) {
      life.officeMenu = null;
    } else if (d.officeMenu && typeof d.officeMenu === 'object') {
      const om = d.officeMenu as { phase?: unknown; coffeeTaken?: unknown; lunchTaken?: unknown };
      if (om.phase === 'arrive' || om.phase === 'lunch' || om.phase === 'afternoon') {
        life.officeMenu = {
          phase: om.phase,
          coffeeTaken: !!om.coffeeTaken,
          lunchTaken: !!om.lunchTaken,
        };
      }
    }
    if (d.officeLeaveEarly !== undefined) life.officeLeaveEarly = d.officeLeaveEarly;
    if (d.coffeeBuff !== undefined) life.coffeeBuff = d.coffeeBuff;
    if (d.carAds) life.carAds = d.carAds;
    if (d.faults) life.faults = d.faults;
    if (d.px !== undefined) {
      ctx.player.px = d.px;
      ctx.player.py = d.py ?? ctx.player.py;
      ctx.player.pAngle = d.pAngle ?? 0;
    }

    if (d.month !== undefined) life.month = d.month;
    if (d.dayOfMonth !== undefined) life.dayOfMonth = d.dayOfMonth;

    if (d.housingType) life.housingType = d.housingType;
    if (d.monthlyHousingCost !== undefined) life.monthlyHousingCost = d.monthlyHousingCost;
    if (d.mortgageBalance !== undefined) life.mortgageBalance = d.mortgageBalance;
    if (d.mortgageMonthsRemaining !== undefined) life.mortgageMonthsRemaining = d.mortgageMonthsRemaining;

    // Legacy mortgage estimation when balance exists but months unknown
    if (life.mortgageBalance > 0 && life.mortgageMonthsRemaining <= 0) {
      const tier = ctx.housingTiers[life.housingType];
      if (tier && tier.mortgage && tier.mortgage > 0) {
        const monthlyRate = life.mortgageRate / 12;
        const approxPrincipal = tier.mortgage - life.mortgageBalance * monthlyRate;
        if (approxPrincipal > 0) {
          life.mortgageMonthsRemaining = Math.ceil(life.mortgageBalance / approxPrincipal);
        } else {
          life.mortgageMonthsRemaining = 360;
        }
        if (life.mortgageMonthsRemaining > 360) life.mortgageMonthsRemaining = 360;
      }
    }

    if (d.missedPayments !== undefined) life.missedPayments = d.missedPayments;
    if (d.garageSlots !== undefined) life.garageSlots = d.garageSlots;
    if (d.carLoans) life.carLoans = d.carLoans;
    if (d.bankLoans) life.bankLoans = d.bankLoans;
    // H214: timeSlot + slotsUsed narrowed to typed shapes. Older
    // saves may have written either (a) unknown junk via the
    // pre-H214 catch-all or (b) the actual string/object — we
    // accept the latter at runtime and fall through on the former.
    if (typeof d.timeSlot === 'string' && (d.timeSlot === 'morning' || d.timeSlot === 'afternoon' || d.timeSlot === 'night')) {
      life.timeSlot = d.timeSlot;
    }
    if (d.slotsUsed && typeof d.slotsUsed === 'object') {
      const su = d.slotsUsed as { morning?: unknown; afternoon?: unknown; night?: unknown };
      life.slotsUsed = {
        morning: !!su.morning,
        afternoon: !!su.afternoon,
        night: !!su.night,
      };
    }
    if (d.sessionTimer !== undefined) life.sessionTimer = d.sessionTimer;
    if (d.pendingSalary !== undefined) life.pendingSalary = d.pendingSalary;
    if (d.mechSkill !== undefined) life.mechSkill = d.mechSkill;
    if (d.calendarLog) life.calendarLog = d.calendarLog;
    if (d.newspaperSection) life.newspaperSection = d.newspaperSection;
    life.realtorVisit = null;

    if (d.gameplaySettings) {
      for (const k in d.gameplaySettings) {
        const v = d.gameplaySettings[k];
        if (v !== undefined) {
          (life.gameplaySettings as Record<string, unknown>)[k] = v;
        }
      }
    }

    if (d.carOdometers) {
      for (const k in d.carOdometers) ctx.carOdometers[k] = d.carOdometers[k];
    }
    if (d.carConditions) {
      for (const k in d.carConditions) ctx.carConditions[k] = d.carConditions[k];
    }

    // GS500 → Katana per-condition migration
    if (ctx.carConditions['suzuki_gs500']) {
      if (!ctx.carConditions['suzuki_katana']) {
        ctx.carConditions['suzuki_katana'] = ctx.carConditions['suzuki_gs500'];
      }
      delete ctx.carConditions['suzuki_gs500'];
    }

    // Rebuild CAR_IDS from ownedCars
    if (life.ownedCars && life.ownedCars.length > 0) {
      ctx.carIds.length = 0;
      life.ownedCars.forEach((id) => {
        if (ctx.cars[id] && !ctx.carIds.includes(id)) ctx.carIds.push(id);
      });
      if (!ctx.carIds.includes(ctx.activeCar.id) && ctx.carIds.length > 0) {
        ctx.activeCar.id = ctx.carIds[0];
      }
    }

    // v8.99.126.89 isManual migration
    if (!life._v89_isManualMigrated) {
      for (const cid of Object.keys(ctx.carConditions)) {
        const cc = ctx.carConditions[cid];
        const car = ctx.cars[cid];
        if (!cc || !car) continue;
        const odo = ctx.carOdometers[cid] || 0;
        const milesDriven = gameUnitsToMiles(odo);
        if (cc.isManual === false && car.defaultManual === true && milesDriven < 200) {
          cc.isManual = true;
          if (cid === ctx.activeCar.id) life.isManual = true;
        }
      }
      life._v89_isManualMigrated = true;
    }

    return true;
  } catch {
    return false;
  }
}

export function hasSave(storageKey: string = SAVE_KEY): boolean {
  return !!localStorage.getItem(storageKey);
}

export function clearSave(storageKey: string = SAVE_KEY): void {
  localStorage.removeItem(storageKey);
}
