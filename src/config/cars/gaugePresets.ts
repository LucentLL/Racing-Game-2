/**
 * Per-car-generation gauge cluster color/style presets.
 *
 * H71: 1:1 port of monolith GAUGE_PRESETS at L29287-29326 plus the
 * _getGaugePreset helper at L29327.
 *
 * Keys are generation strings (matched by getCarGeneration in carBody).
 * "default" applies to anything without a chassis-specific override.
 * Entries are sparse on purpose — they only encode fields the monolith
 * actually customizes. The few entries that exist today (dodge variants)
 * preserve the monolith's exact field set.
 *
 * v8.99.123.90 archaeology preserved in field comments below — both
 * needle colors were unified to red (#e44) per user "speedometer needle
 * should be red like rpm needle". Dodge variants kept their orange-
 * tinted face/bezel/odo/gear-accent theme but had needles converted.
 */
export interface GaugePreset {
  /** Dial backplate fill color. */
  faceColor: string;
  /** Outer ring stroke color. */
  bezelColor: string;
  /** Speedometer needle color. v8.99.123.90: unified to red across all
   *  presets, so this matches rpmNeedleColor in every entry. */
  speedNeedleColor: string;
  /** Tachometer needle color. */
  rpmNeedleColor: string;
  /** Rim (fuel/temp/battery) needle color — separate from main needles
   *  so chassis themes can keep the rim tint orange when speed/rpm
   *  needles are red. */
  rimNeedleColor: string;
  /** Speedometer number/label color. */
  speedTextColor: string;
  /** Tachometer number/label color. */
  rpmTextColor: string;
  /** Odometer digit color. */
  odoColor: string;
  /** Gear indicator accent color (border/glow on the gear text). */
  gearAccent: string;
  /** Redline as a fraction of RPM_MAX (0.80 = top 20% of sweep is red). */
  redlineFrac: number;
}

export const GAUGE_PRESETS: Readonly<Record<string, GaugePreset>> = {
  default: {
    faceColor: '#0b0b0b',
    bezelColor: '#3a3a3a',
    speedNeedleColor: '#e44',
    rpmNeedleColor: '#e44',
    rimNeedleColor: '#fff',
    speedTextColor: '#cfcfcf',
    rpmTextColor: '#bbb',
    odoColor: '#fc8',
    gearAccent: '#0f0',
    redlineFrac: 0.80,
  },
  dodge_charger: {
    faceColor: '#1a1410',
    bezelColor: '#5a4838',
    speedNeedleColor: '#e44',
    rpmNeedleColor: '#e44',
    rimNeedleColor: '#ffaa30',
    speedTextColor: '#e8d8b0',
    rpmTextColor: '#d8c890',
    odoColor: '#ffaa30',
    gearAccent: '#ff8000',
    redlineFrac: 0.83,
  },
  // dodge_super_bee shares dodge_charger styling — B-body sibling per
  // monolith comment at L29316.
  dodge_super_bee: {
    faceColor: '#1a1410',
    bezelColor: '#5a4838',
    speedNeedleColor: '#e44',
    rpmNeedleColor: '#e44',
    rimNeedleColor: '#ffaa30',
    speedTextColor: '#e8d8b0',
    rpmTextColor: '#d8c890',
    odoColor: '#ffaa30',
    gearAccent: '#ff8000',
    redlineFrac: 0.83,
  },
};

/** Lookup a preset by generation key, falling back to default.
 *  1:1 port of monolith _getGaugePreset at L29327. */
export function getGaugePreset(genKey: string): GaugePreset {
  return GAUGE_PRESETS[genKey] ?? GAUGE_PRESETS.default;
}
