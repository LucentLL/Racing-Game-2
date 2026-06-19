export type SingleSpriteEntry = string;

export interface PopupHeadlightSpriteEntry {
  down: string;
  up: string;
}

export interface MultiVariantSpriteEntry {
  variants: Record<string, string>;
  anchors: Record<string, string>;
}

export type VehicleSpriteEntry =
  | SingleSpriteEntry
  | PopupHeadlightSpriteEntry
  | MultiVariantSpriteEntry;

/**
 * Root-relative base for car sprite PNGs. In Vite, files under `public/cars/`
 * are served at `<base>/cars/`. H692: prefix with import.meta.env.BASE_URL so
 * GitHub Pages (deployed under '/Racing-Game-2/') resolves to
 * '/Racing-Game-2/cars/...' instead of '/cars/...' (which 404s on Pages). Dev
 * server keeps BASE_URL='/' so the resolved URL stays '/cars/...' verbatim.
 */
export const VEHICLE_IMAGE_BASE = `${import.meta.env.BASE_URL}cars/`;

/**
 * key -> sprite filename(s). ADDING A SPRITE? After you add an entry here,
 * run `npm run sprites:buffer` to regenerate src/config/cars/spriteBuffer.ts
 * so the new car is sized from its BODY pixels (not its mirror span). The
 * build runs `npm run sprites:check` and will FAIL until the buffer matches —
 * see scripts/measureSprite.mjs for the rule. Keep top-level keys at 2-space
 * indent (the generator's manifest parser keys on it).
 */
export const VEHICLE_IMAGE_MANIFEST: Record<string, VehicleSpriteEntry> = {
  sedan:    'Ford-Taurus-Brown.png',
  civic99:  'Honda-Civic-Blue.png',
  accord99: 'Honda-Accord-Heather.png',
  hatch:    'Dodge-Caravan-Green.png',
  suv:      'Dodge-Caravan-Green.png',
  pickup:   'Dodge-Ram-White.png',

  silvia:        'Nissan-Silvia-Coupe.png',
  silvia_180sx:  'Nissan-180via-Yellow.png',
  civic_eg:      'Untitled%20(7).png',
  ae86:          'Toyota-Corolla-AE86-White.png',
  rx7_fc:        'Mazda-RX7-FC-Red.png',
  rx7_fd:        { down: 'RX7FD-Down-Grey.png', up: 'RX7FD-Up-Grey.png' },

  kawasaki_ninja: 'Ninja-Green.png',
  honda_cb500:    'CB500-Red.png',
  suzuki_bandit:  'Bandit-Blue.png',
  suzuki_katana:  'Katana-Red.png',

  gtr_r34:        'Nissan-Skyline-R34-Blue.png',
  gtr_r34_vspec:  'Nissan-Skyline-R34-VSpec-Blue%20(1).png',
  nsx_na:         'Acura-NSX-Red.png',

  miata_na: {
    variants: {
      red:   'Mazda-Miata-NA-Red.png',
      black: 'Mazda-Miata-NA-Black.png',
    },
    anchors: {
      red:   '#cc1100',
      black: '#1a1a1a',
    },
  },

  towtruck:   'Tow%20Truck-White.png',
  semi_truck: 'Peterbilt-379-Red.png',
  semi:       'Peterbilt-379-Red.png',
  box_truck:  'Freightliner-Van.png',
  boxtruck:   'Freightliner-Van.png',

  cruiser: {
    variants: {
      st:   'Ford-Crown-Vic-ST.png',
      cmpd: 'Ford-Crown-Vic-CMPD.png',
    },
    anchors: {
      st:   '#b0b0b0',
      cmpd: '#ffffff',
    },
  },

  ambulance: 'Ford-Ambulance.png',

  dodge_viper:    'Dodge-Viper-Blue.png',
  plymouth_cuda:  'Plymouth-Barracuda-Orange.png',
  dodge_charger:  'Dodge-Charger-Orange.png',
  audi_quattro:   'Audi-Quattro-82-White.png',

  dodge_super_bee: 'Dodge-SuperBee-Green.png',
  ruf_btr:         'RUF%20BTR-86-Blue.png',
  ruf_ctr_yb:      'RUF%20CTR-Yellowbird.png',
  ruf_ctr2:        'RUF%20CTR2.png',
};
