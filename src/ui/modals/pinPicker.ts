/**
 * Pin picker modal — label + color picker for placing a map pin on a
 * newspaper listing (cars or homes).
 *
 * 9 labels (numeric 1-9) + 8 colors. Pin pushes into LIFE.carPins with
 * worldX/worldY copied from the listing and expiresDay forwarded so the
 * pin auto-cleans when the listing expires.
 *
 * Plus the world + minimap rendering for placed pins (drawCarPinsWorld
 * + drawCarPinsMinimap). Pins blink at ~3 Hz to draw the eye, and
 * include both car and home listings now (v8.99.102 — homes added).
 *
 * Ported from monolith L50296-50545.
 *
 * SCAFFOLD status: type contract + entry points stubbed with TODO line
 * refs.
 */

/** Available labels (display order). Single source of truth — both the
 *  draw and the click handler iterate this. */
export const PIN_LABELS = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
] as const;
export type PinLabel = (typeof PIN_LABELS)[number];

/** Available colors (display order). */
export const PIN_COLORS = [
  '#f44',
  '#f80',
  '#ff0',
  '#0f0',
  '#0ff',
  '#88f',
  '#f0f',
  '#fff',
] as const;
export type PinColor = (typeof PIN_COLORS)[number];

/** Listing being pinned. */
export interface PinListing {
  /** 'house' = home pin, otherwise car pin. */
  type?: string;
  name: string;
  price: number;
  /** True for rental homes (drives price label). */
  isRental?: boolean;
  worldX: number;
  worldY: number;
  /** Drives auto-cleanup when listing expires. */
  expiresDay: number;
}

/** LIFE.pinPicker shape. */
export interface PinPickerState {
  listing: PinListing;
  /** Index into LIFE.newspaper. */
  index: number;
  /** Currently chosen label / color (defaults '1' / '#f44'). */
  _selLabel?: PinLabel;
  _selColor?: PinColor;
}

/** Placed pin (an entry of LIFE.carPins). */
export interface PlacedPin {
  listing: PinListing;
  index: number;
  label: PinLabel;
  color: PinColor;
  worldX: number;
  worldY: number;
  expiresDay: number;
}

/** Per-frame inputs for the pin picker overlay. */
export interface PinPickerOpts {
  state: PinPickerState;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Side effects of PIN IT / CANCEL. */
export interface PinPickerDeps {
  /** Pushes the new pin into LIFE.carPins, clears LIFE.pinPicker. */
  commit(pin: PlacedPin): void;
  /** Clears LIFE.pinPicker without placing. */
  cancel(): void;
  showNotif(msg: string): void;
}

/** Per-frame inputs for world-space pin rendering (called inside the
 *  render() camera transform — drives the in-world marker). */
export interface PinWorldRenderOpts {
  pins: PlacedPin[];
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Per-frame inputs for minimap pin rendering. */
export interface PinMinimapRenderOpts {
  pins: PlacedPin[];
  /** Player world position (drives the minimap centering). */
  px: number;
  py: number;
  TILE: number;
  /** Minimap geometry (matches mScale=0.116, viewR=78 elsewhere). */
  mScale: number;
  viewR: number;
}

/** Draws the dim backdrop + title + label grid + color grid + preview
 *  + PIN IT / CANCEL buttons. TODO(D31-followup): port from L50299-50352. */
export function drawPinPicker(
  _ctx: CanvasRenderingContext2D,
  _opts: PinPickerOpts,
): void {
  // TODO: L50299-50352. Label cells 26x26 with 4px gap, color cells
  // 28x28 with 6px gap.
}

/** Routes a tap to label / color cell or PIN IT / CANCEL.
 *  TODO(D31-followup): port from L50355-50389. */
export function handlePinPickerClick(
  _tx: number,
  _ty: number,
  _opts: PinPickerOpts,
  _deps: PinPickerDeps,
): void {
  // TODO: L50355-50389.
}

/** Renders all placed pins in world space. ~3 Hz blink so pins draw
 *  the eye. TODO(D31-followup): port from L50392+. */
export function drawCarPinsWorld(
  _ctx: CanvasRenderingContext2D,
  _opts: PinWorldRenderOpts,
): void {
  // TODO: L50392+. blink = Math.sin(Date.now()*0.006)>0.
}

/** Renders all placed pins as minimap dots. Called from the minimap
 *  layer — matches the same mScale/viewR projection used elsewhere.
 *  TODO(D31-followup): port from monolith car-pin minimap section
 *  (search 'drawCarPinsMinimap' near L50500+). */
export function drawCarPinsMinimap(
  _ctx: CanvasRenderingContext2D,
  _opts: PinMinimapRenderOpts,
): void {
  // TODO: search for drawCarPinsMinimap near L50500+.
}
