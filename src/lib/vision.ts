/**
 * Page vision: glyph-level text segmentation, content-aware text removal,
 * speech-bubble geometry and SFX geometry. Browser-only (canvas), no network.
 *
 * The pipeline keeps seven concepts strictly separate:
 *   1. OCR region        — approximate hint only, never a cleanup area
 *   2. glyph mask        — the actual original text pixels (+ antialias/stroke)
 *   3. bubble contour    — measured from the artwork, layout only
 *   4. bubble interior   — flood-filled area inside the contour
 *   5. text-safe region  — inscribed rectangle of the interior, minus the tail
 *   6. cleanup region    — the glyph mask only, feathered; nothing else
 *   7. render region     — where translated lettering is laid out
 *
 * Cleanup output is an RGBA plate that is fully TRANSPARENT everywhere except
 * on top of the reconstructed original glyph pixels, so compositing can never
 * cover artwork with a rectangle.
 */

export interface NBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BlockVision {
  /** Detected bubble bounds when a bubble exists, else the glyph bounds. */
  bubble: NBox;
  /** Largest safe text region (page-normalised). */
  interior: NBox;
  /** Median background colour behind the text. */
  fill: string;
  onDark: boolean;
  /** Ink coverage of the original lettering, 0..1 — drives weight estimation. */
  inkRatio: number;
  hasBubble: boolean;
  /** Tight bounds of the original glyph pixels. */
  glyphBox: NBox;
  /** Dominant orientation of the original lettering, degrees. */
  angle: number;
  /** Average colour of the original glyphs, used to match SFX fills. */
  glyphColor: string;
  /** Original glyph stroke/outline colour when a contrasting outline exists. */
  glyphOutline?: string | undefined;
  /** Estimated stroke thickness of the original glyphs, in em. */
  strokeEm: number;
  /** 0..1 confidence that the glyph mask really is text. */
  confidence: number;
  /** Transparent reconstruction plate: only the removed glyph pixels. */
  cleaned?: { box: NBox; dataUrl: string } | undefined;
  /** Untouched crop of the same area, for the inspector. */
  crop?: { box: NBox; dataUrl: string } | undefined;
  /** Glyph mask preview (debug), black glyphs on transparency. */
  maskUrl?: string | undefined;
  renderMs: number;
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

/** Otsu split of a histogram; returns the bucket index of the threshold. */
function otsu(hist: number[]): number {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return hist.length >> 1;
  let sum = 0;
  for (let i = 0; i < hist.length; i++) sum += i * (hist[i] ?? 0);
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestVar = -1;
  for (let i = 0; i < hist.length; i++) {
    wB += hist[i] ?? 0;
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * (hist[i] ?? 0);
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = i;
    }
  }
  return best;
}

function dilate(mask: Uint8Array, w: number, h: number, radius = 1) {
  if (radius <= 0) return mask.slice();
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(h - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w - 1, x + radius);
      for (let ny = y0; ny <= y1; ny++) {
        for (let nx = x0; nx <= x1; nx++) out[ny * w + nx] = 1;
      }
    }
  }
  return out;
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
 * Structure-preserving reconstruction of the artwork under the removed glyphs.
 *
 * Pass 1 is directional: for every unknown pixel each of the four orientations
 * is probed for the nearest known pixel on both sides, and the orientation
 * whose two ends agree best wins. That continues line art, panel edges,
 * screentone rows and speed lines straight through the hole instead of blurring
 * them away. Pass 2 diffuses whatever pass 1 could not reach, then a light
 * coherence pass removes seams — only ever on reconstructed pixels.
 */
function inpaint(data: Uint8ClampedArray, w: number, h: number, unknown: Uint8Array) {
  const known = new Uint8Array(unknown.length);
  for (let i = 0; i < unknown.length; i++) known[i] = unknown[i] ? 0 : 1;
  const src = data.slice();
  const DIRS: [number, number][] = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  const REACH = Math.max(6, Math.min(48, Math.round(Math.max(w, h) * 0.5)));
  const filled = known.slice();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (known[i]) continue;
      let bestCost = Number.POSITIVE_INFINITY;
      let br = 0;
      let bg = 0;
      let bb = 0;
      for (const [dx, dy] of DIRS) {
        let ax = x;
        let ay = y;
        let a = -1;
        for (let s = 1; s <= REACH; s++) {
          ax = x - dx * s;
          ay = y - dy * s;
          if (ax < 0 || ay < 0 || ax >= w || ay >= h) break;
          const j = ay * w + ax;
          if (known[j]) {
            a = j;
            break;
          }
        }
        let bx = x;
        let by = y;
        let b = -1;
        for (let s = 1; s <= REACH; s++) {
          bx = x + dx * s;
          by = y + dy * s;
          if (bx < 0 || by < 0 || bx >= w || by >= h) break;
          const j = by * w + bx;
          if (known[j]) {
            b = j;
            break;
          }
        }
        if (a < 0 || b < 0) continue;
        const da = Math.hypot(x - (a % w), y - Math.floor(a / w));
        const db = Math.hypot(x - (b % w), y - Math.floor(b / w));
        const t = da / Math.max(0.001, da + db);
        const ar = src[a * 4] ?? 0;
        const ag = src[a * 4 + 1] ?? 0;
        const ab = src[a * 4 + 2] ?? 0;
        const brr = src[b * 4] ?? 0;
        const bgg = src[b * 4 + 1] ?? 0;
        const bbb = src[b * 4 + 2] ?? 0;
        const disagree = Math.abs(ar - brr) + Math.abs(ag - bgg) + Math.abs(ab - bbb);
        const cost = disagree + (da + db) * 3;
        if (cost < bestCost) {
          bestCost = cost;
          br = ar + (brr - ar) * t;
          bg = ag + (bgg - ag) * t;
          bb = ab + (bbb - ab) * t;
        }
      }
      if (!Number.isFinite(bestCost)) continue;
      data[i * 4] = br;
      data[i * 4 + 1] = bg;
      data[i * 4 + 2] = bb;
      data[i * 4 + 3] = 255;
      filled[i] = 1;
    }
  }

  // Anything with no opposing known pixel in any orientation: diffuse inward.
  for (let pass = 0; pass < 120; pass++) {
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
            const weight = dx && dy ? 1 : 2;
            r += (data[j * 4] ?? 0) * weight;
            g += (data[j * 4 + 1] ?? 0) * weight;
            b += (data[j * 4 + 2] ?? 0) * weight;
            n += weight;
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

  // One gentle coherence pass: centre-weighted, so reconstructed lines keep
  // their contrast instead of being averaged into a grey smear.
  const copy = data.slice();
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!unknown[i]) continue;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const j = (y + dy) * w + (x + dx);
          const weight = !dx && !dy ? 4 : dx && dy ? 1 : 2;
          r += (copy[j * 4] ?? 0) * weight;
          g += (copy[j * 4 + 1] ?? 0) * weight;
          b += (copy[j * 4 + 2] ?? 0) * weight;
          n += weight;
        }
      }
      data[i * 4] = r / n;
      data[i * 4 + 1] = g / n;
      data[i * 4 + 2] = b / n;
    }
  }
}


function toDataUrl(data: Uint8ClampedArray, w: number, h: number) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  return canvas.toDataURL("image/png");
}

interface Component {
  pixels: number[];
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 8-connected components of a binary mask. */
function components(mask: Uint8Array, w: number, h: number, limit = 4000): Component[] {
  const seen = new Uint8Array(mask.length);
  const out: Component[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    const comp: Component = { pixels: [], x0: w, y0: h, x1: 0, y1: 0 };
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      comp.pixels.push(i);
      if (x < comp.x0) comp.x0 = x;
      if (y < comp.y0) comp.y0 = y;
      if (x > comp.x1) comp.x1 = x;
      if (y > comp.y1) comp.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (mask[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    out.push(comp);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Detects glyph pixels, bubble geometry and a transparent reconstruction plate
 * for every text region on a page.
 */
export async function analyzeRegions(
  url: string,
  regions: VisionInput[],
  opts: { maxEdge?: number; clean?: boolean } = {},
): Promise<Record<string, BlockVision>> {
  const out: Record<string, BlockVision> = {};
  if (!regions.length || typeof document === "undefined") return out;

  const img = await loadImage(url);
  const maxEdge = opts.maxEdge ?? 1800;
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
        glyphBox: region.box,
        angle: 0,
        glyphColor: "rgb(20,18,16)",
        strokeEm: 0,
        confidence: 0,
        renderMs: 0,
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
  const started = typeof performance !== "undefined" ? performance.now() : 0;
  const src = page.data;

  const tx = clamp(Math.round(region.box.x * W), 0, W - 2);
  const ty = clamp(Math.round(region.box.y * H), 0, H - 2);
  const tw = clamp(Math.round(region.box.w * W), 2, W - tx);
  const th = clamp(Math.round(region.box.h * H), 2, H - ty);

  // ---- 1. background estimate inside the OCR hint -------------------------
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
  let topBucket = 0;
  for (let i = 1; i < 32; i++) {
    if ((buckets[i] ?? 0) > (buckets[topBucket] ?? 0)) topBucket = i;
  }
  const bsum = sums[topBucket]!;
  const bcount = Math.max(1, bsum[3] ?? 1);
  const bg = [bsum[0]! / bcount, bsum[1]! / bcount, bsum[2]! / bcount] as const;
  const onDark = lum(bg[0], bg[1], bg[2]) < 118;
  const fill = `rgb(${Math.round(bg[0])}, ${Math.round(bg[1])}, ${Math.round(bg[2])})`;

  // ---- 2. glyph mask, pixel level ----------------------------------------
  // Work in a slightly grown OCR box so stroked/outlined glyphs are complete.
  const gx = clamp(Math.round(tx - tw * 0.1), 0, W - 2);
  const gy = clamp(Math.round(ty - th * 0.14), 0, H - 2);
  const gx2 = clamp(Math.round(tx + tw * 1.1), gx + 2, W);
  const gy2 = clamp(Math.round(ty + th * 1.14), gy + 2, H);
  const gw = gx2 - gx;
  const gh = gy2 - gy;

  const distAt = (x: number, y: number) => {
    const i = (y * W + x) * 4;
    return (
      Math.abs((src[i] ?? 0) - bg[0]) +
      Math.abs((src[i + 1] ?? 0) - bg[1]) +
      Math.abs((src[i + 2] ?? 0) - bg[2])
    );
  };

  // Adaptive threshold from the distance-to-background histogram (Otsu).
  const dist = new Uint16Array(gw * gh);
  const hist = new Array(48).fill(0);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const d = distAt(gx + x, gy + y);
      dist[y * gw + x] = d;
      hist[Math.min(47, Math.floor(d / 16))]++;
    }
  }
  const split = otsu(hist);
  const core = clamp((split + 1) * 16, 45, 330);
  const halo = Math.max(24, core * 0.45);

  const coreMask = new Uint8Array(gw * gh);
  for (let i = 0; i < coreMask.length; i++) coreMask[i] = (dist[i] ?? 0) >= core ? 1 : 0;

  // Component filtering: keep glyph-sized blobs, discard artwork that merely
  // shares the OCR rectangle (panel borders, hair, line art, big shapes).
  const comps = components(coreMask, gw, gh);
  const glyph = new Uint8Array(gw * gh);
  const boxArea = gw * gh;
  const maxComp = boxArea * (region.sfx ? 0.55 : 0.4);
  const minComp = Math.max(2, boxArea * 0.00015);
  let kept = 0;
  let keptPixels = 0;
  for (const comp of comps) {
    const cw = comp.x1 - comp.x0 + 1;
    const chh = comp.y1 - comp.y0 + 1;
    const size = comp.pixels.length;
    const spansAll = cw > gw * 0.96 && chh > gh * 0.96;
    if (size < minComp || size > maxComp || spansAll) continue;
    // A glyph is never a thin full-width rule (panel border / underline).
    if ((cw > gw * 0.9 && chh < gh * 0.06) || (chh > gh * 0.9 && cw < gw * 0.06)) continue;
    // Long shapes that run out of the search box are artwork: bubble outlines,
    // panel edges, hair, speed lines. Removing them would damage the balloon.
    const touchesEdge =
      comp.x0 === 0 || comp.y0 === 0 || comp.x1 === gw - 1 || comp.y1 === gh - 1;
    if (touchesEdge && (cw > gw * 0.5 || chh > gh * 0.5)) continue;

    for (const i of comp.pixels) glyph[i] = 1;
    kept++;
    keptPixels += size;
  }
  if (!kept) {
    // Fall back to the raw threshold rather than removing nothing at all.
    for (let i = 0; i < glyph.length; i++) glyph[i] = coreMask[i] ?? 0;
    keptPixels = glyph.reduce((a, b) => a + b, 0);
  }

  // Antialiasing + outline halo: only pixels adjacent to the glyph core.
  const near = dilate(glyph, gw, gh, 2);
  const mask = new Uint8Array(gw * gh);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = glyph[i] || (near[i] && (dist[i] ?? 0) >= halo) ? 1 : 0;
  }

  // Glyph metrics: tight bounds, orientation (PCA), colour, stroke thickness.
  let minX = gw;
  let minY = gh;
  let maxX = 0;
  let maxY = 0;
  let n = 0;
  let sx = 0;
  let sy = 0;
  let cr = 0;
  let cg = 0;
  let cb = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!mask[y * gw + x]) continue;
      n++;
      sx += x;
      sy += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const i = ((gy + y) * W + (gx + x)) * 4;
      cr += src[i] ?? 0;
      cg += src[i + 1] ?? 0;
      cb += src[i + 2] ?? 0;
    }
  }
  if (!n) {
    minX = 0;
    minY = 0;
    maxX = gw - 1;
    maxY = gh - 1;
    n = 1;
    sx = gw / 2;
    sy = gh / 2;
  }
  const mx = sx / n;
  const my = sy / n;
  let vxx = 0;
  let vyy = 0;
  let vxy = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (!mask[y * gw + x]) continue;
      const dx = x - mx;
      const dy = y - my;
      vxx += dx * dx;
      vyy += dy * dy;
      vxy += dx * dy;
    }
  }
  vxx /= n;
  vyy /= n;
  vxy /= n;
  let angle = 0;
  if (region.sfx) {
    const theta = 0.5 * Math.atan2(2 * vxy, vxx - vyy);
    const deg = (theta * 180) / Math.PI;
    // Only trust a clear elongation; blobby SFX stay upright.
    const elong = Math.abs(vxx - vyy) / Math.max(1, vxx + vyy);
    angle = elong > 0.22 && Math.abs(deg) < 42 ? deg : 0;
  }

  const glyphBox: NBox = {
    x: (gx + minX) / W,
    y: (gy + minY) / H,
    w: Math.max(1, maxX - minX + 1) / W,
    h: Math.max(1, maxY - minY + 1) / H,
  };
  const glyphColor = `rgb(${Math.round(cr / n)}, ${Math.round(cg / n)}, ${Math.round(cb / n)})`;
  const glyphLum = lum(cr / n, cg / n, cb / n);
  const glyphW = maxX - minX + 1;
  const glyphH = maxY - minY + 1;
  const inkRatio = n / Math.max(1, glyphW * glyphH);
  // Rough stroke thickness: area over skeleton-ish perimeter estimate.
  const strokeEm = clamp(Math.sqrt(n / Math.max(1, kept)) / Math.max(6, glyphH), 0.02, 0.16);
  const confidence = clamp(
    (kept >= 2 ? 0.55 : 0.3) + Math.min(0.35, inkRatio * 1.2) + (n > 40 ? 0.1 : 0),
    0,
    1,
  );

  // Does the original lettering carry a contrasting outline? Sample the halo
  // ring: if it is far from both the glyph fill and the background, it is one.
  let outline: string | undefined;
  {
    const ring = dilate(glyph, gw, gh, 3);
    let rr = 0;
    let rg2 = 0;
    let rb = 0;
    let rn = 0;
    for (let i = 0; i < ring.length; i++) {
      if (!ring[i] || glyph[i]) continue;
      const p = ((gy + Math.floor(i / gw)) * W + (gx + (i % gw))) * 4;
      rr += src[p] ?? 0;
      rg2 += src[p + 1] ?? 0;
      rb += src[p + 2] ?? 0;
      rn++;
    }
    if (rn > 20) {
      const rl = lum(rr / rn, rg2 / rn, rb / rn);
      if (Math.abs(rl - glyphLum) > 60 && Math.abs(rl - lum(bg[0], bg[1], bg[2])) > 45) {
        outline = `rgb(${Math.round(rr / rn)}, ${Math.round(rg2 / rn)}, ${Math.round(rb / rn)})`;
      }
    }
  }

  // ---- 3. bubble contour + interior (layout only) -------------------------
  let hasBubble = false;
  let bubble: NBox = glyphBox;
  let interior: NBox;

  if (!region.sfx) {
    const wx = clamp(Math.round(tx - tw * 0.9), 0, W - 2);
    const wy = clamp(Math.round(ty - th * 1.2), 0, H - 2);
    const wx2 = clamp(Math.round(tx + tw * 1.9), wx + 2, W);
    const wy2 = clamp(Math.round(ty + th * 2.2), wy + 2, H);
    const ww = wx2 - wx;
    const wh = wy2 - wy;
    const TOL = Math.max(70, core * 0.85);
    const inside = new Uint8Array(ww * wh);
    const stack: number[] = [];
    // Seeds: background-coloured pixels inside the OCR box that are NOT glyphs.
    for (let y = ty; y < ty + th; y += Math.max(1, Math.floor(th / 10))) {
      for (let x = tx; x < tx + tw; x += Math.max(1, Math.floor(tw / 10))) {
        const lx = x - wx;
        const ly = y - wy;
        if (lx < 0 || ly < 0 || lx >= ww || ly >= wh) continue;
        const inGlyph =
          x >= gx && y >= gy && x < gx2 && y < gy2 && mask[(y - gy) * gw + (x - gx)];
        if (!inGlyph && distAt(x, y) <= TOL) stack.push(ly * ww + lx);
      }
    }
    let filledCount = 0;
    let borderHits = 0;
    while (stack.length) {
      const i = stack.pop()!;
      if (inside[i]) continue;
      const x = i % ww;
      const y = (i - x) / ww;
      if (distAt(wx + x, wy + y) > TOL) continue;
      inside[i] = 1;
      filledCount++;
      if (x === 0 || y === 0 || x === ww - 1 || y === wh - 1) borderHits++;
      if (x > 0) stack.push(i - 1);
      if (x < ww - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - ww);
      if (y < wh - 1) stack.push(i + ww);
    }

    // Close over glyph holes so the inscribed rectangle measures the balloon.
    const closeR = Math.max(2, Math.round(Math.min(tw, th) * 0.07));
    const closed = dilate(inside, ww, wh, closeR);
    const cx = tx - wx + tw / 2;
    const cy = ty - wy + th / 2;
    const rect = maximalRect(closed, ww, wh, Math.round(cx), Math.round(cy));
    const enclosed = borderHits < (ww + wh) * 0.35;
    hasBubble = enclosed && filledCount > tw * th * 1.1 && rect.area > tw * th * 0.85;

    if (hasBubble) {
      // Tail exclusion: the inscribed rectangle already drops the tail, then
      // clip anything that runs far beyond the lettering vertically.
      const bx = wx + rect.x;
      const by = wy + rect.y;
      bubble = { x: bx / W, y: by / H, w: rect.w / W, h: rect.h / H };
      interior = pad(bubble, 0.07);
    } else {
      // Text over artwork: layout follows the glyphs, generously padded.
      bubble = {
        x: clamp(glyphBox.x - glyphBox.w * 0.06, 0, 1),
        y: clamp(glyphBox.y - glyphBox.h * 0.12, 0, 1),
        w: Math.min(1, glyphBox.w * 1.12),
        h: Math.min(1, glyphBox.h * 1.24),
      };
      interior = bubble;
    }
  } else {
    // SFX: geometry comes from the glyph mask itself, never a bubble.
    bubble = glyphBox;
    interior = {
      x: clamp(glyphBox.x - glyphBox.w * 0.04, 0, 1),
      y: clamp(glyphBox.y - glyphBox.h * 0.06, 0, 1),
      w: Math.min(1, glyphBox.w * 1.08),
      h: Math.min(1, glyphBox.h * 1.12),
    };
  }

  const vision: BlockVision = {
    bubble,
    interior,
    fill,
    onDark,
    inkRatio,
    hasBubble,
    glyphBox,
    angle,
    glyphColor,
    glyphOutline: outline,
    strokeEm,
    confidence,
    renderMs: 0,
  };
  if (!clean) {
    vision.renderMs = Math.round(
      (typeof performance !== "undefined" ? performance.now() : 0) - started,
    );
    return vision;
  }

  // ---- 4. cleanup: reconstruct ONLY the glyph pixels ----------------------
  // The plate covers the glyph bounds plus a small working margin, and every
  // pixel outside the (feathered) glyph mask is left fully transparent.
  const marginX = Math.max(3, Math.round(glyphW * 0.06));
  const marginY = Math.max(3, Math.round(glyphH * 0.06));
  const px = clamp(gx + minX - marginX, 0, W - 2);
  const py = clamp(gy + minY - marginY, 0, H - 2);
  const pw = clamp(glyphW + marginX * 2, 2, W - px);
  const ph = clamp(glyphH + marginY * 2, 2, H - py);

  const patch = new Uint8ClampedArray(pw * ph * 4);
  const original = new Uint8ClampedArray(pw * ph * 4);
  const local = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const si = ((py + y) * W + (px + x)) * 4;
      const di = (y * pw + x) * 4;
      patch[di] = src[si] ?? 255;
      patch[di + 1] = src[si + 1] ?? 255;
      patch[di + 2] = src[si + 2] ?? 255;
      patch[di + 3] = 255;
      original[di] = patch[di]!;
      original[di + 1] = patch[di + 1]!;
      original[di + 2] = patch[di + 2]!;
      original[di + 3] = 255;
      const mxi = px + x - gx;
      const myi = py + y - gy;
      if (mxi >= 0 && myi >= 0 && mxi < gw && myi < gh && mask[myi * gw + mxi]) {
        local[y * pw + x] = 1;
      }
    }
  }

  let maskCount = 0;
  for (let i = 0; i < local.length; i++) if (local[i]) maskCount++;
  const cropBox: NBox = { x: px / W, y: py / H, w: pw / W, h: ph / H };
  vision.crop = { box: cropBox, dataUrl: toDataUrl(original, pw, ph) };

  if (maskCount && maskCount < local.length * 0.9) {
    const grow1 = dilate(local, pw, ph, 1);
    const grow2 = dilate(grow1, pw, ph, 1);
    inpaint(patch, pw, ph, grow2);
    // Alpha: opaque over the glyphs, two feather rings, transparent elsewhere.
    for (let i = 0; i < local.length; i++) {
      const a = local[i] ? 255 : grow1[i] ? 210 : grow2[i] ? 120 : 0;
      patch[i * 4 + 3] = a;
    }
    vision.cleaned = { box: cropBox, dataUrl: toDataUrl(patch, pw, ph) };

    const preview = new Uint8ClampedArray(pw * ph * 4);
    for (let i = 0; i < local.length; i++) {
      const on = local[i] ? 1 : 0;
      preview[i * 4] = 255;
      preview[i * 4 + 1] = 40;
      preview[i * 4 + 2] = 90;
      preview[i * 4 + 3] = on ? 235 : 0;
    }
    vision.maskUrl = toDataUrl(preview, pw, ph);
  }

  vision.renderMs = Math.round(
    (typeof performance !== "undefined" ? performance.now() : 0) - started,
  );
  return vision;
}
