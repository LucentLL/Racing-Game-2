/**
 * H1073: modular avatar compositor — the BL-6 scaffolding from
 * docs/BLACKLIST.md, shipped interface-first so every consumer
 * (dialogue portraits, OUTFIT tab, STATUS tab, future barber /
 * clothing shops) codes against the final shape today.
 *
 * Draw order once art exists: base sheet → outfit → hair → hat →
 * glasses → condition overlay. Right now only the base sheet ships
 * (characterBase: gender × fitness build × skin tone), so the slot
 * layers are no-ops — the moment layered sheets land in public/ui/
 * this module grows loaders without any consumer changing.
 *
 * NPCs and the player share this renderer: an AvatarPose is just
 * {gender, fitness, skinTone, avatar?} — rivals/strangers pass their
 * config values, the player passes LifeState fields.
 */

import { drawCharacterBase } from '@/render/characterBase';

/** Cosmetic slot selection. All ids null = stock look. Persisted on
 *  life.avatar (wholesale save blob). */
export interface AvatarSpec {
  outfitId: string | null;
  hatId: string | null;
  hairId: string | null;
  glassesId: string | null;
}

/** Everything needed to draw somebody. */
export interface AvatarPose {
  gender: 'M' | 'F';
  fitness: number;
  skinTone: number;
  avatar?: AvatarSpec | null;
}

export function defaultAvatarSpec(): AvatarSpec {
  return { outfitId: null, hatId: null, hairId: null, glassesId: null };
}

/** The slot list the OUTFIT tab renders — single source so new slots
 *  (shoes? chains?) appear everywhere at once. */
export const AVATAR_SLOTS: ReadonlyArray<{ key: keyof AvatarSpec; label: string }> = [
  { key: 'outfitId',  label: 'OUTFIT' },
  { key: 'hairId',    label: 'HAIR' },
  { key: 'hatId',     label: 'HAT' },
  { key: 'glassesId', label: 'GLASSES' },
];

/** Composite an avatar at (x, y) size s×s. Today: base sheet only;
 *  slot layers draw here (in order) when their art ships. */
export function drawAvatar(
  ctx: CanvasRenderingContext2D,
  pose: AvatarPose,
  x: number,
  y: number,
  s: number,
): void {
  drawCharacterBase(ctx, pose.gender, pose.fitness, pose.skinTone, x, y, s);
  // outfit → hair → hat → glasses → condition overlays land here (BL-6).
}
