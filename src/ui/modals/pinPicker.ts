/**
 * Pin picker modal — label + color picker for placing a map pin on a
 * newspaper listing (cars or homes).
 *
 * 9 labels (numeric 1-9) + 8 colors. Pin pushes into LIFE.carPins with
 * worldX/worldY copied from the listing and expiresDay forwarded so the
 * pin auto-cleans when the listing expires.
 *
 * Ported from monolith L50296-50545 (picker UI). The in-world + minimap
 * rendering of placed pins is NOT in this file — see
 * src/render/worldMarkers.ts drawCarPinsWorld (H204) and
 * src/render/minimap.ts (H180 inline carPins block) for those.
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

/** Pixel layout — shared by renderer + click router so positions can't
 *  drift. All values 1:1 with monolith L50232-50268. */
const LABEL_W = 26;
const LABEL_GAP = 4;
const LABEL_Y = 84;
const COLOR_W = 28;
const COLOR_GAP = 6;
const COLOR_Y = 136;
const PIN_BTN_Y = 218;
const PIN_BTN_H = 28;
const CANCEL_BTN_Y = 252;
const CANCEL_BTN_H = 24;

/** Draws the dim backdrop + title + label grid + color grid + preview
 *  + PIN IT / CANCEL buttons. 1:1 port of monolith L50217-50271. */
export function drawPinPicker(
  ctx: CanvasRenderingContext2D,
  opts: PinPickerOpts,
): void {
  const { state: pp, GW } = opts;
  // Backdrop (92% black — slightly less opaque than the seller overlay
  // so a hint of the newspaper row underneath stays readable).
  ctx.fillStyle = 'rgba(0, 0, 0, 0.92)';
  ctx.fillRect(0, 0, GW, opts.GH);
  ctx.textAlign = 'center';

  // Header — 📌 PIN THIS HOME / CAR + listing name + price.
  const isHouse = pp.listing.type === 'house';
  ctx.fillStyle = '#fa0';
  ctx.font = 'bold 14px monospace';
  ctx.fillText(isHouse ? '📌 PIN THIS HOME' : '📌 PIN THIS CAR', GW / 2, 24);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px monospace';
  ctx.fillText(pp.listing.name, GW / 2, 42);
  ctx.fillStyle = '#888';
  ctx.font = '10px monospace';
  const priceStr = isHouse
    ? (pp.listing.isRental ? '$' + pp.listing.price + '/mo' : '$' + pp.listing.price)
    : '$' + pp.listing.price;
  ctx.fillText(priceStr, GW / 2, 56);

  // Label-selection grid (1..9).
  ctx.fillStyle = '#aaa';
  ctx.font = 'bold 10px monospace';
  ctx.fillText('CHOOSE LABEL:', GW / 2, 78);
  const lbTotal = PIN_LABELS.length * (LABEL_W + LABEL_GAP) - LABEL_GAP;
  const lbX0 = (GW - lbTotal) / 2;
  const selLabel: PinLabel = pp._selLabel ?? '1';
  PIN_LABELS.forEach((lb, i) => {
    const lx = lbX0 + i * (LABEL_W + LABEL_GAP);
    ctx.fillStyle = lb === selLabel ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.1)';
    ctx.fillRect(lx, LABEL_Y, LABEL_W, LABEL_W);
    ctx.strokeStyle = lb === selLabel ? '#fff' : '#555';
    ctx.strokeRect(lx, LABEL_Y, LABEL_W, LABEL_W);
    ctx.fillStyle = lb === selLabel ? '#fff' : '#888';
    ctx.font = 'bold 14px monospace';
    ctx.fillText(lb, lx + LABEL_W / 2, LABEL_Y + 18);
  });

  // Color-selection grid.
  ctx.fillStyle = '#aaa';
  ctx.font = 'bold 10px monospace';
  ctx.fillText('CHOOSE COLOR:', GW / 2, 128);
  const cTotal = PIN_COLORS.length * (COLOR_W + COLOR_GAP) - COLOR_GAP;
  const cX0 = (GW - cTotal) / 2;
  const selColor: PinColor = pp._selColor ?? '#f44';
  PIN_COLORS.forEach((col, i) => {
    const cx = cX0 + i * (COLOR_W + COLOR_GAP);
    ctx.fillStyle = col;
    ctx.fillRect(cx, COLOR_Y, COLOR_W, COLOR_W);
    if (col === selColor) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - 1, COLOR_Y - 1, COLOR_W + 2, COLOR_W + 2);
      ctx.lineWidth = 1;
    }
  });

  // Preview line — the selected label in the selected color.
  ctx.fillStyle = selColor;
  ctx.font = 'bold 20px monospace';
  ctx.fillText(selLabel, GW / 2, 190);
  ctx.fillStyle = '#888';
  ctx.font = '9px monospace';
  ctx.fillText('This marker will appear on your map', GW / 2, 206);

  // PIN IT button (green) + CANCEL button (red).
  ctx.fillStyle = 'rgba(0, 255, 0, 0.15)';
  ctx.fillRect(20, PIN_BTN_Y, GW - 40, PIN_BTN_H);
  ctx.strokeStyle = '#0f0';
  ctx.strokeRect(20, PIN_BTN_Y, GW - 40, PIN_BTN_H);
  ctx.fillStyle = '#0f0';
  ctx.font = 'bold 12px monospace';
  ctx.fillText('📌 PIN IT', GW / 2, PIN_BTN_Y + 18);

  ctx.fillStyle = 'rgba(255, 0, 0, 0.1)';
  ctx.fillRect(20, CANCEL_BTN_Y, GW - 40, CANCEL_BTN_H);
  ctx.strokeStyle = '#f44';
  ctx.strokeRect(20, CANCEL_BTN_Y, GW - 40, CANCEL_BTN_H);
  ctx.fillStyle = '#f44';
  ctx.font = 'bold 11px monospace';
  ctx.fillText('CANCEL', GW / 2, CANCEL_BTN_Y + 16);

  ctx.textAlign = 'left';
}

/** Routes a tap to label / color cell or PIN IT / CANCEL. Mutates
 *  pp._selLabel / pp._selColor on cell taps; invokes deps.commit /
 *  deps.cancel on the bottom buttons. 1:1 port of monolith L50273-
 *  50307. */
export function handlePinPickerClick(
  tx: number,
  ty: number,
  opts: PinPickerOpts,
  deps: PinPickerDeps,
): void {
  const { state: pp, GW } = opts;

  // Label cells.
  if (ty >= LABEL_Y && ty <= LABEL_Y + LABEL_W) {
    const lbTotal = PIN_LABELS.length * (LABEL_W + LABEL_GAP) - LABEL_GAP;
    const lbX0 = (GW - lbTotal) / 2;
    for (let i = 0; i < PIN_LABELS.length; i++) {
      const lx = lbX0 + i * (LABEL_W + LABEL_GAP);
      if (tx >= lx && tx <= lx + LABEL_W) {
        pp._selLabel = PIN_LABELS[i];
        return;
      }
    }
  }

  // Color cells.
  if (ty >= COLOR_Y && ty <= COLOR_Y + COLOR_W) {
    const cTotal = PIN_COLORS.length * (COLOR_W + COLOR_GAP) - COLOR_GAP;
    const cX0 = (GW - cTotal) / 2;
    for (let i = 0; i < PIN_COLORS.length; i++) {
      const cx = cX0 + i * (COLOR_W + COLOR_GAP);
      if (tx >= cx && tx <= cx + COLOR_W) {
        pp._selColor = PIN_COLORS[i];
        return;
      }
    }
  }

  // PIN IT.
  if (ty >= PIN_BTN_Y && ty <= PIN_BTN_Y + PIN_BTN_H) {
    const label = pp._selLabel ?? '1';
    const color = pp._selColor ?? '#f44';
    deps.commit({
      listing: pp.listing,
      index: pp.index,
      label,
      color,
      worldX: pp.listing.worldX,
      worldY: pp.listing.worldY,
      expiresDay: pp.listing.expiresDay,
    });
    deps.showNotif('📌 Pinned ' + pp.listing.name + ' as ' + label);
    return;
  }

  // CANCEL.
  if (ty >= CANCEL_BTN_Y && ty <= CANCEL_BTN_Y + CANCEL_BTN_H) {
    deps.cancel();
    return;
  }
}

