import type { PageRegion } from "./translate.server";
import type { BlockVision, NBox } from "./vision";
import { autoTypography, type BlockKind, type Typography } from "./typography";
import { renderBox } from "./regions";

/** Manual nudges applied on top of the detected geometry. */
export interface BlockPosition {
  /** offsets/scales in fractions of the page (dx/dy) or of the box (dw/dh) */
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  rotation: number;
  scale: number;
}

export const IDENTITY_POSITION: BlockPosition = {
  dx: 0,
  dy: 0,
  dw: 0,
  dh: 0,
  rotation: 0,
  scale: 1,
};

export interface BlockOverride {
  /** edited OCR text */
  source?: string;
  /** edited translation */
  target?: string;
  kind?: BlockKind;
  typography?: Partial<Typography>;
  position?: Partial<BlockPosition>;
  /** manual font size in px at page-render scale; null/undefined = auto */
  fontScale?: number;
}

/**
 * A fully resolved text block: OCR result + vision measurements + user edits.
 * Every renderer (reader, inspector preview, CBZ export) consumes this shape.
 */
export interface TextBlock {
  id: string;
  pageIndex: number;
  kind: BlockKind;
  /** OCR glyph bounds (hint only — never a cleanup region) */
  textBounds: NBox;
  /** tight bounds of the ORIGINAL glyph pixels */
  glyphBounds: NBox;
  /** detected bubble contour bounds (layout only) */
  bubbleBounds: NBox;
  /** safe interior the text must stay inside */
  interior: NBox;
  source: string;
  target: string;
  vertical: boolean;
  rotation: number;
  onDark: boolean;
  emotion?: string | undefined;
  intensity?: number | undefined;
  inkRatio: number;
  hasBubble: boolean;
  fill: string;
  /** 0..1 confidence in the glyph segmentation */
  confidence: number;
  /** ms spent measuring/cleaning this block */
  renderMs: number;
  /** transparent reconstruction plate — glyph pixels only */
  cleaned?: { box: NBox; dataUrl: string } | undefined;
  crop?: { box: NBox; dataUrl: string } | undefined;
  /** debug overlay of the glyph mask */
  maskUrl?: string | undefined;
  typography: Typography;
  position: BlockPosition;
  edited: boolean;
}

function applyPosition(box: NBox, pos: BlockPosition): NBox {
  const w = Math.max(0.01, box.w * (1 + pos.dw) * pos.scale);
  const h = Math.max(0.006, box.h * (1 + pos.dh) * pos.scale);
  const cx = box.x + box.w / 2 + pos.dx;
  const cy = box.y + box.h / 2 + pos.dy;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Drops U+FFFD and stray control chars so no block can render "\uFFFD". */
function clean(text: string) {
  return text.replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
}

export function buildBlock(
  region: PageRegion,
  vision: BlockVision | undefined,
  override: BlockOverride | undefined,
  pageIndex: number,
): TextBlock {
  const kind = (override?.kind ?? region.kind) as BlockKind;
  const sfx = kind === "sfx";

  const fallback = renderBox({ ...region, kind });
  const glyphBounds = vision?.glyphBox ?? region.box;
  const bubbleBounds = vision?.bubble ?? fallback;
  const baseInterior = vision?.interior ?? fallback;
  const position = { ...IDENTITY_POSITION, ...override?.position };
  const onDark = vision?.onDark ?? region.onDark;
  const auto = autoTypography({
    kind,
    onDark,
    intensity: region.intensity,
    inkRatio: vision?.inkRatio,
  });

  // SFX inherit the original lettering's visual structure: measured fill, its
  // real outline colour when one exists, and the detected stroke thickness.
  const measured: Partial<Typography> = sfx
    ? {
        color: vision?.glyphColor ?? auto.color,
        strokeColor: vision?.glyphOutline ?? auto.strokeColor,
        strokeWidth: vision?.glyphOutline
          ? Math.max(auto.strokeWidth, vision.strokeEm)
          : auto.strokeWidth,
      }
    : {};

  return {
    id: region.id,
    pageIndex,
    kind,
    textBounds: region.box,
    glyphBounds,
    bubbleBounds,
    interior: applyPosition(baseInterior, position),
    source: override?.source ?? region.source,
    target: (override?.target ?? region.target ?? "").trim() || region.source,
    vertical: region.vertical,
    rotation:
      position.rotation ||
      (sfx ? vision?.angle || region.rotation || 0 : region.rotation || 0),
    onDark,
    emotion: region.emotion,
    intensity: region.intensity,
    inkRatio: vision?.inkRatio ?? 0.2,
    hasBubble: vision?.hasBubble ?? false,
    fill: vision?.fill ?? (onDark ? "rgb(24,22,20)" : "rgb(250,249,245)"),
    confidence: vision?.confidence ?? 0,
    renderMs: vision?.renderMs ?? 0,
    cleaned: vision?.cleaned,
    crop: vision?.crop,
    maskUrl: vision?.maskUrl,
    typography: { ...auto, ...measured, ...override?.typography },
    position,
    edited: Boolean(
      override &&
        (override.target !== undefined ||
          override.source !== undefined ||
          override.kind !== undefined ||
          override.typography ||
          override.position),
    ),
  };
}


export function buildBlocks(
  regions: PageRegion[],
  visions: Record<string, BlockVision> | undefined,
  overrides: Record<string, BlockOverride>,
  pageIndex: number,
): TextBlock[] {
  return regions.map((r) => buildBlock(r, visions?.[r.id], overrides[r.id], pageIndex));
}
