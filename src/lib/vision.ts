/**
 * Page vision: speech-bubble contour detection, safe-interior solving and
 * content-aware text removal. Browser-only (canvas), no network, no mocks.
 *
 * The OCR box only says *where the glyphs are*. Everything the renderer needs —
 * the usable region inside the balloon and a cleaned plate with the original
 * lettering removed — is measured here from the actual pixels.
 */

export interface NBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BlockVision {
  /** Detected bubble/plate bounds (normalised 0..1). */
  bubble: NBox;
  /** Largest safe text region inside the bubble, padded. */
  interior: NBox;
  /** Median interior colour, used as a last-resort fill. */
  fill: string;
  onDark: boolean;
  /** Ink coverage of the original lettering, 0..1 — drives weight estimation. */
  inkRatio: number;
  hasBubble: boolean;
  /** Artwork with the original text reconstructed away. */
  cleaned?: { box: NBox; dataUrl: string };
  /** Untouched crop of the same area, for the inspector. */
  crop?: { box: NBox; dataUrl: string };
}

interface VisionInput {
  id: string;
  box: NBox;
  sfx: boolean;
}

const imageCache = new Map<string, HTMLImageElement>();

async function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url);
  if (cached?.complete) return cached;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not read that page image."));
    el.src = url;
  });
  imageCache.set(url, img);
  return img;
}

function lum(r: number, g: number, b: number) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** Largest all-true axis-aligned rectangle, preferring ones containing (cx,cy). */
function maximalRect(
  mask: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
): { x: number; y: number; w: number; h: number; area: number } {
  const heights = new Int32Array(w);
  let best = { x: 0, y: 0, w: 0, h: 0, area: 0 };
  let bestAny = best;
  const stackX = new Int32Array(w + 1);
  const stackH = new Int32Array(w + 1);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      heights[x] = mask[y * w + x] ? (heights[x] ?? 0) + 1 : 0;
    }
    let top = 0;
    for (let x = 0; x <= w; x++) {
      const cur = x < w ? (heights[x] ?? 0) : 0;
      let start = x;
      while (top > 0 && (stackH[top - 1] ?? 0) >= cur) {
        top--;
        const hh = stackH[top] ?? 0;
        const sx = stackX[top] ?? 0;
        const area = hh * (x - sx);
        const rect = { x: sx, y: y - hh + 1, w: x - sx, h: hh, area };
        if (area > bestAny.area) bestAny = rect;
        const holds =
          cx >= rect.x && cx < rect.x + rect.w && cy >= rect.y && cy < rect.y + rect.h;
        if (holds && area > best.area) best = rect;
        start = sx;
      }
      if (cur > 0) {
        stackX[top] = start;
        stackH[top] = cur;
        top++;
      }
    }
  }
  return best.area > 0 ? best : bestAny;
}

function pad(box: NBox, ratio: number): NBox {
  const px = box.w * ratio;
  const py = box.h * ratio;
  return {
    x: clamp(box.x + px, 0, 1),
    y: clamp(box.y + py, 0, 1),
    w: Math.max(0.01, box.w - px * 2),
    h: Math.max(0.008, box.h - py * 2),
  };
}

/**
 * Rebuilds the artwork under the removed glyphs by diffusing the surrounding
 * pixels inward, so gradients, screentones and line art survive instead of
 * being covered by a flat rectangle.
 */
function inpaint(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  unknown: Uint8Array,
) {
  const filled = new Uint8Array(unknown.length);
  for (let i = 0; i < unknown.length; i++) filled[i] = unknown[i] ? 0 : 1;

  for (let pass = 0; pass < 80; pass++) {
    const newly: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (!filled[j]) continue;
            r += data[j * 4] ?? 0;
            g += data[j * 4 + 1] ?? 0;
            b += data[j * 4 + 2] ?? 0;
            n++;
          }
        }
        if (!n) continue;
        data[i * 4] = r / n;
        data[i * 4 + 1] = g / n;
        data[i * 4 + 2] = b / n;
        data[i * 4 + 3] = 255;
        newly.push(i);
      }
    }
    if (!newly.length) break;
    for (const i of newly) filled[i] = 1;
  }

  // Two smoothing passes over reconstructed pixels remove diffusion banding.
  for (let pass = 0; pass < 2; pass++) {
    const copy = data.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!unknown[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = (y + dy) * w + (x + dx);
            r += copy[j * 4] ?? 0;
            g += copy[j * 4 + 1] ?? 0;
            b += copy[j * 4 + 2] ?? 0;
          }
        }
        data[i * 4] = r / 9;
        data[i * 4 + 1] = g / 9;
        data[i * 4 + 2] = b / 9;
      }
    }
  }
}

function dilate(mask: Uint8Array, w: number, h: number, radius = 1) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          out[ny * w + nx] = 1;
        }
      }
    }
  }
  return out;
}

function toDataUrl(data: Uint8ClampedArray, w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.putImageData(new ImageData(data, w, h), 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Detects the bubble contour + safe interior and produces a cleaned plate for
 * every text region on a page.
 */
export async function analyzeRegions(
  url: string,
  regions: VisionInput[],
  opts: { maxEdge?: number; clean?: boolean } = {},
): Promise<Record<string, BlockVision>> {
  const out: Record<string, BlockVision> = {};
  if (!regions.length || typeof document === "undefined") return out;

  const img = await loadImage(url);
  const maxEdge = opts.maxEdge ?? 1500;
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const W = Math.max(1, Math.round(img.naturalWidth * scale));
  const H = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return out;
  ctx.drawImage(img, 0, 0, W, H);
  const page = ctx.getImageData(0, 0, W, H);

  for (const region of regions) {
    try {
      out[region.id] = analyzeOne(page, W, H, region, opts.clean !== false);
    } catch {
      out[region.id] = {
        bubble: region.box,
        interior: pad(region.box, 0.06),
        fill: "rgb(250,249,245)",
        onDark: false,
        inkRatio: 0.2,
        hasBubble: false,
      };
    }
  }
  return out;
}

function analyzeOne(
  page: ImageData,
  W: number,
  H: number,
  region: VisionInput,
  clean: boolean,
): BlockVision {
  const tx = clamp(Math.round(region.box.x * W), 0, W - 2);
  const ty = clamp(Math.round(region.box.y * H), 0, H - 2);
  const tw = clamp(Math.round(region.box.w * W), 2, W - tx);
  const th = clamp(Math.round(region.box.h * H), 2, H - ty);

  // Search window: generous enough to contain the whole balloon (tails included,
  // they get dropped by the inscribed-rectangle step).
  const wx = clamp(Math.round(tx - tw * 0.85), 0, W - 2);
  const wy = clamp(Math.round(ty - th * 1.1), 0, H - 2);
  const wx2 = clamp(Math.round(tx + tw * 1.85), wx + 2, W);
  const wy2 = clamp(Math.round(ty + th * 2.1), wy + 2, H);
  const ww = wx2 - wx;
  const wh = wy2 - wy;

  const src = page.data;
  const at = (x: number, y: number) => ((y + wy) * W + (x + wx)) * 4;

  // Background estimate: the dominant luminance bucket inside the text box is
  // the balloon fill, because glyphs are always the minority.
  const buckets = new Array(32).fill(0);
  const sums = Array.from({ length: 32 }, () => [0, 0, 0, 0]);
  for (let y = ty; y < ty + th; y++) {
    for (let x = tx; x < tx + tw; x++) {
      const i = (y * W + x) * 4;
      const r = src[i] ?? 0;
      const g = src[i + 1] ?? 0;
      const b = src[i + 2] ?? 0;
      const bucket = Math.min(31, Math.floor(lum(r, g, b) / 8));
      buckets[bucket]++;
      const s = sums[bucket]!;
      s[0]! += r;
      s[1]! += g;
      s[2]! += b;
      s[3]! += 1;
    }
  }
  let top = 0;
  for (let i = 1; i < 32; i++) if ((buckets[i] ?? 0) > (buckets[top] ?? 0)) top = i;
  const s = sums[top]!;
  const count = Math.max(1, s[3] ?? 1);
  const bg = [s[0]! / count, s[1]! / count, s[2]! / count] as const;
  const bgLum = lum(bg[0], bg[1], bg[2]);
  const onDark = bgLum < 118;
  const fill = `rgb(${Math.round(bg[0])}, ${Math.round(bg[1])}, ${Math.round(bg[2])})`;

  const dist = (x: number, y: number) => {
    const i = at(x, y);
    return (
      Math.abs((src[i] ?? 0) - bg[0]) +
      Math.abs((src[i + 1] ?? 0) - bg[1]) +
      Math.abs((src[i + 2] ?? 0) - bg[2])
    );
  };
  const TOL = 108;

  // Flood fill the balloon interior from inside the text box.
  const mask = new Uint8Array(ww * wh);
  const stack: number[] = [];
  for (let y = ty; y < ty + th; y += Math.max(1, Math.floor(th / 8))) {
    for (let x = tx; x < tx + tw; x += Math.max(1, Math.floor(tw / 8))) {
      const lx = x - wx;
      const ly = y - wy;
      if (lx < 0 || ly < 0 || lx >= ww || ly >= wh) continue;
      if (dist(lx, ly) <= TOL) stack.push(ly * ww + lx);
    }
  }
  let masked = 0;
  while (stack.length) {
    const i = stack.pop()!;
    if (mask[i]) continue;
    const x = i % ww;
    const y = (i - x) / ww;
    if (dist(x, y) > TOL) continue;
    mask[i] = 1;
    masked++;
    if (x > 0) stack.push(i - 1);
    if (x < ww - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - ww);
    if (y < wh - 1) stack.push(i + ww);
  }

  let inkPixels = 0;
  for (let y = ty; y < ty + th; y++) {
    for (let x = tx; x < tx + tw; x++) {
      if (dist(x - wx, y - wy) > TOL) inkPixels++;
    }
  }
  const inkRatio = inkPixels / Math.max(1, tw * th);

  // Bubble interior mask, closed over the glyph holes so the inscribed
  // rectangle measures the balloon, not the gaps between letters.
  const closed = dilate(mask, ww, wh, Math.max(2, Math.round(Math.min(tw, th) * 0.06)));
  const cx = tx - wx + tw / 2;
  const cy = ty - wy + th / 2;
  const rect = maximalRect(closed, ww, wh, Math.round(cx), Math.round(cy));

  const hasBubble = !region.sfx && masked > tw * th * 1.15 && rect.area > tw * th * 0.9;

  let bubble: NBox;
  if (hasBubble) {
    bubble = {
      x: (wx + rect.x) / W,
      y: (wy + rect.y) / H,
      w: rect.w / W,
      h: rect.h / H,
    };
  } else {
    bubble = {
      x: clamp(region.box.x - region.box.w * 0.06, 0, 1),
      y: clamp(region.box.y - region.box.h * 0.08, 0, 1),
      w: Math.min(1, region.box.w * 1.12),
      h: Math.min(1, region.box.h * 1.16),
    };
  }
  const interior = pad(bubble, region.sfx ? 0.02 : hasBubble ? 0.075 : 0.05);

  const vision: BlockVision = {
    bubble,
    interior,
    fill,
    onDark,
    inkRatio,
    hasBubble,
  };
  if (!clean) return vision;

  // ---- cleaned plate + original crop -------------------------------------
  const px = clamp(Math.round(bubble.x * W), 0, W - 2);
  const py = clamp(Math.round(bubble.y * H), 0, H - 2);
  const pw = clamp(Math.round(bubble.w * W), 2, W - px);
  const ph = clamp(Math.round(bubble.h * H), 2, H - py);

  const patch = new Uint8ClampedArray(pw * ph * 4);
  const original = new Uint8ClampedArray(pw * ph * 4);
  const unknownRaw = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const si = ((py + y) * W + (px + x)) * 4;
      const di = (y * pw + x) * 4;
      for (let c = 0; c < 4; c++) {
        patch[di + c] = src[si + c] ?? 255;
        original[di + c] = src[si + c] ?? 255;
      }
      patch[di + 3] = 255;
      original[di + 3] = 255;
      const inTextBox =
        px + x >= tx - tw * 0.12 &&
        px + x <= tx + tw * 1.12 &&
        py + y >= ty - th * 0.15 &&
        py + y <= ty + th * 1.15;
      const isInk = dist(px + x - wx, py + y - wy) > TOL * (region.sfx ? 1.1 : 0.9);
      // Inside a balloon everything non-background is lettering; over artwork we
      // only touch pixels that sit within the detected glyph box.
      if (isInk && (hasBubble || inTextBox)) unknownRaw[y * pw + x] = 1;
    }
  }
  const unknown = dilate(unknownRaw, pw, ph, 1);
  let unknownCount = 0;
  for (let i = 0; i < unknown.length; i++) if (unknown[i]) unknownCount++;
  if (unknownCount && unknownCount < unknown.length * 0.92) {
    inpaint(patch, pw, ph, unknown);
    const box: NBox = { x: px / W, y: py / H, w: pw / W, h: ph / H };
    vision.cleaned = { box, dataUrl: toDataUrl(patch, pw, ph) };
    vision.crop = { box, dataUrl: toDataUrl(original, pw, ph) };
  } else {
    const box: NBox = { x: px / W, y: py / H, w: pw / W, h: ph / H };
    vision.crop = { box, dataUrl: toDataUrl(original, pw, ph) };
  }
  return vision;
}
