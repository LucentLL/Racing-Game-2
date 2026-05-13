export interface FuelGrade {
  name: string;
  octane: number;
  price: number;
  color: string;
  diesel: boolean;
}

export const FUEL_GRADES: readonly FuelGrade[] = [
  { name: '87 REG',   octane: 87,  price: 0.99, color: '#0a0',    diesel: false },
  { name: '93 PREM',  octane: 93,  price: 1.24, color: '#0af',    diesel: false },
  { name: '110 RACE', octane: 110, price: 2.49, color: '#f80',    diesel: false },
  { name: 'DIESEL',   octane: 0,   price: 1.99, color: '#2d8c2d', diesel: true  },
];
