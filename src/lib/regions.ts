import type { PageRegion } from "./translate.server";

/**
 * Detected boxes hug the original glyphs while the real balloon is slightly
 * larger, so the render box only gets symmetric padding — never the aggressive
 * inflation that used to spill white patches over the artwork.
 */
export function renderBox(region: PageRegion) {
  const sfx = region.kind === "sfx";
  const padRatio = sfx ? 0.05 : 0.11;
  const minW = sfx ? 0.05 : 0.07;
  const minH = sfx ? 0.02 : 0.025;

  const padX = region.box.w * padRatio;
  const padY = region.box.h * padRatio;
  const w = Math.min(0.99, Math.max(region.box.w + padX * 2, minW));
  const h = Math.min(0.99, Math.max(region.box.h + padY * 2, minH));
  const cx = region.box.x + region.box.w / 2;
  const cy = region.box.y + region.box.h / 2;

  return {
    x: Math.min(1 - w, Math.max(0, cx - w / 2)),
    y: Math.min(1 - h, Math.max(0, cy - h / 2)),
    w,
    h,
  };
}

/**
 * Upper bound for lettering, in px. Height alone is a bad cap: a two-word name
 * in a tall narration band would be rendered enormous, so the page width sets
 * the ceiling for readable, official-release-like type.
 */
export function maxFontPx(opts: {
  pageWidth: number;
  boxHeight: number;
  sfx: boolean;
}) {
  const { pageWidth, boxHeight, sfx } = opts;
  const widthCap = pageWidth * (sfx ? 0.13 : 0.05);
  const heightCap = boxHeight * (sfx ? 1.05 : 0.95);
  return Math.max(8, Math.min(widthCap, heightCap));
}
