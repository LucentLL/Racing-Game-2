/**
 * Title image picker — picks one of the 4 CLT-Title-{Day,Night,Sunrise,Sunset}.png
 * scenes at module init and returns a preloaded HTMLImageElement.
 *
 * v8.99.124.11 behavior: single random scene per session, no crossfade.
 * The renderer (src/ui/screens/title.ts) handles the object-fit:cover
 * sizing and the loading-dots fallback while the image streams in.
 *
 * Images live in public/ui/ so they're served at /ui/<name>.png. Public
 * assets are NOT hashed by Vite — fine here because the title PNGs are
 * stable content that never changes.
 */

// H692: prefix each with import.meta.env.BASE_URL so GitHub Pages
// (deployed under '/Racing-Game-2/') resolves the title PNGs correctly.
const _UI = `${import.meta.env.BASE_URL}ui/`;
const TITLE_SCENES = [
  `${_UI}CLT-Title-Day.png`,
  `${_UI}CLT-Title-Night.png`,
  `${_UI}CLT-Title-Sunrise.png`,
  `${_UI}CLT-Title-Sunset.png`,
] as const;

/** Picks one random scene and returns a preloaded HTMLImageElement.
 *  The element's .complete property gates the renderer's image-vs-
 *  loading-dots branch — callers don't have to await anything. */
export function pickTitleImage(): HTMLImageElement {
  const img = new Image();
  img.src = TITLE_SCENES[Math.floor(Math.random() * TITLE_SCENES.length)];
  return img;
}
