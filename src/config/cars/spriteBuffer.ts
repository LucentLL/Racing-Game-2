/**
 * Per-bodytype sprite render-buffer correction. Some sprites have thin
 * protruding elements (door mirrors, fender tips) whose auto-trimmed canvas
 * extent is wider than the visible BODY. Without correction,
 * drawImage(-L/2, -W/2, L, W) renders the body smaller than the intended
 * L×W, with the buffer area filled by transparent padding around mirrors.
 *
 * Tuple format: [lengthMultiplier, widthMultiplier].
 * Bodytypes without an entry render at exact L×W.
 *
 * Collision/physics dimensions in CAR().size are UNCHANGED — only the
 * drawImage destination rect is scaled.
 */
export const SPRITE_BUFFER: Record<string, readonly [number, number]> = {
  miata_na:        [1.007, 1.114],
  cruiser:         [1.006, 1.151],
  ambulance:       [1.003, 1.141],
  sedan:           [1.006, 1.107],
  civic99:         [1.007, 1.108],
  accord99:        [1.000, 1.151],
  hatch:           [1.002, 1.141],
  suv:             [1.002, 1.141],
  pickup:          [1.000, 1.193],
  civic_eg:        [1.000, 1.098],
  silvia:          [1.003, 1.137],
  silvia_180sx:    [1.004, 1.120],
  rx7_fd:          [1.016, 1.119],
  gtr_r34:         [1.000, 1.118],
  gtr_r34_vspec:   [1.003, 1.075],
  nsx_na:          [1.010, 1.143],
  semi:            [1.000, 1.113],
  semi_truck:      [1.000, 1.113],
  boxtruck:        [1.004, 1.093],
  box_truck:       [1.004, 1.093],
  dodge_viper:     [1.007, 1.057],
  plymouth_cuda:   [1.003, 1.030],
  dodge_charger:   [1.003, 1.043],
  audi_quattro:    [1.000, 1.084],
  dodge_super_bee: [1.007, 1.012],
  ruf_btr:         [1.015, 1.021],
  ruf_ctr_yb:      [1.013, 1.055],
  ruf_ctr2:        [1.000, 1.054],
};

export const SPRITE_CACHE_LONG_AXIS = 512;
