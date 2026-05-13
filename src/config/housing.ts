export type HousingTierKey = 'apt1br' | 'apt2br' | 'rentHouse' | 'ownStarter' | 'ownMid' | 'ownNice';

export interface HousingTier {
  name: string;
  rent: number;
  mortgage: number;
  price: number;
  slots: number;
  desc: string;
}

export const HOUSING_TIERS: Record<HousingTierKey, HousingTier> = {
  apt1br:     { name: '1BR Apartment',   rent: 425, mortgage: 0,    price: 0,      slots: 1, desc: 'Basic apartment, 1 parking spot' },
  apt2br:     { name: '2BR Apartment',   rent: 575, mortgage: 0,    price: 0,      slots: 2, desc: 'Roomier apartment, 2 parking spots' },
  rentHouse:  { name: 'Rental House',    rent: 750, mortgage: 0,    price: 0,      slots: 3, desc: 'House with garage & driveway' },
  ownStarter: { name: 'Starter Home',    rent: 0,   mortgage: 695,  price: 95000,  slots: 3, desc: '$95k — Small house, you own it' },
  ownMid:     { name: 'Mid-Range Home',  rent: 0,   mortgage: 975,  price: 139000, slots: 4, desc: '$139k — Median Charlotte home' },
  ownNice:    { name: 'Nice Home',       rent: 0,   mortgage: 1325, price: 189000, slots: 5, desc: '$189k — Myers Park / SouthPark tier' },
};

export const CAR_LOAN_RATE_NEW = 0.085;
export const CAR_LOAN_RATE_USED = 0.105;
export const LEASE_MONEY_FACTOR = 0.0035;
export const LEASE_RESIDUAL = 0.45;

export const HOUSE_LOAN_APR = 0.075;
export const HOUSE_LOAN_MONTHS = 360;
export const HOUSE_DOWN_OPTIONS: readonly number[] = [0.05, 0.10, 0.15, 0.20, 0.30];

export const BANK_LOAN_RATES = {
  EXCELLENT: 0.095,
  GOOD:      0.115,
  FAIR:      0.145,
  POOR:      0.185,
  BAD:       0.24,
} as const;

export const BANK_LOAN_TERMS: readonly number[] = [24, 36, 48, 60];
