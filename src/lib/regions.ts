import type { PageRegion } from "./translate.server";

/**
 * Detected boxes hug the original glyphs, and localized text is usually longer
 * than the source, so the render box is inflated (and floored) before layout.
 * Speech/narration boxes get room to wrap; SFX only needs a small margin.
 */
export function renderBox(region: PageRegion) {
  const sfx = region.kind === "sfx";
  const growX = sfx ? 1.15 : 1.5;
  const growY = sfx ? 1.15 : 1.7;
  const minW = sfx ? 0.1 : 0.16;
  const minH = sfx ? 0.05 : 0.07;

  const w = Math.min(0.98, Math.max(region.box.w * growX, minW));
  const h = Math.min(0.98, Math.max(region.box.h * growY, minH));
  const cx = region.box.x + region.box.w / 2;
  const cy = region.box.y + region.box.h / 2;

  return {
    x: Math.min(1 - w, Math.max(0, cx - w / 2)),
    y: Math.min(1 - h, Math.max(0, cy - h / 2)),
    w,
    h,
  };
}
