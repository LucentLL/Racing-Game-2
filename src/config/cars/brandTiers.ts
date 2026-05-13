export type BrandClass = 'econ' | 'mid' | 'premium' | 'exotic' | 'bike' | 'race';

export interface BrandTier {
  re: RegExp;
  cls: BrandClass;
  mult: number;
}

export const LUXURY_BRANDS: readonly string[] = [
  'Ferrari', 'Lamborghini', 'Porsche', 'Aston Martin', 'Jaguar', 'TVR',
  'Lister', 'Pagani', 'Shelby', 'AC Cars', 'De Tomaso', 'Bentley', 'Lotus',
];

export const BRAND_TIERS: readonly BrandTier[] = [
  { re: /^(Ferrari|Lamborghini|Pagani|Bugatti|McLaren|Koenigsegg|Spyker)/, cls: 'exotic', mult: 1.0 },
  { re: /^(Porsche|Aston Martin|Bentley|Maserati|Lotus|TVR|Lister)/, cls: 'premium', mult: 1.15 },
  { re: /^(BMW|Mercedes|Mercedes-Benz|AMG|Audi|Jaguar|Lexus|Cadillac|Acura|Infiniti|Saab|Volvo)/, cls: 'premium', mult: 1.0 },
  { re: /^(Alfa Romeo|Lancia|RUF|NISMO|Spoon|Shelby|Panoz|Callaway|Ascari|Gemballa)/, cls: 'premium', mult: 1.05 },
  { re: /^(Honda|Toyota|Nissan|Mazda|Subaru|Mitsubishi|Ford|Chevrolet|Chrysler|Dodge|Plymouth|Mercury|Pontiac|BUICK|EAGLE|Volkswagen|Opel|Peugeot|Citroen|Renault|Fiat|MGF|SILEIGHTY)/, cls: 'mid', mult: 1.0 },
  { re: /^(Daihatsu|Suzuki|Autobianchi|Hyundai|Kia|Triumph)/, cls: 'econ', mult: 1.0 },
  { re: /^(Harley-Davidson|Kawasaki|Yamaha|Ducati)/, cls: 'bike', mult: 1.0 },
];

export function getBrandTier(name: string): BrandTier {
  for (const t of BRAND_TIERS) {
    if (t.re.test(name)) return t;
  }
  return { re: /^/, cls: 'mid', mult: 1.0 };
}
