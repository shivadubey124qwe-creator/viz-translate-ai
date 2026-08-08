/**
 * Typography engine.
 *
 * Pure, browser-safe layout maths shared by the reader (DOM rendering) and the
 * CBZ exporter (canvas rendering) so both produce identical lettering.
 */

export type BlockKind = "speech" | "thought" | "narration" | "sign" | "caption" | "sfx";

export const BLOCK_KINDS: BlockKind[] = [
  "speech",
  "thought",
  "narration",
  "caption",
  "sign",
  "sfx",
];

export type FontId = "bubble" | "narration" | "display" | "sfx" | "serif" | "mono";

export const FONT_CHOICES: { id: FontId; label: string }[] = [
  { id: "bubble", label: "Bubble — Comic Neue" },
  { id: "narration", label: "Narration — Barlow" },
  { id: "display", label: "Display — Anton" },
  { id: "sfx", label: "Impact — Anton" },
  { id: "serif", label: "Serif" },
  { id: "mono", label: "Mono" },
];

const FAMILIES: Record<FontId, string> = {
  bubble: "'Comic Neue', 'Barlow', sans-serif",
  narration: "'Barlow', system-ui, sans-serif",
  display: "'Anton', 'Barlow', sans-serif",
  sfx: "'Anton', Impact, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'JetBrains Mono', monospace",
};

export function familyFor(id: FontId) {
  return FAMILIES[id] ?? FAMILIES.bubble;
}

export interface Typography {
  fontId: FontId;
  weight: number;
  italic: boolean;
  /** em */
  letterSpacing: number;
  /** multiplier of the font size */
  lineHeight: number;
  /** em, 0 = no stroke */
  strokeWidth: number;
  strokeColor: string;
  color: string;
  /** 0..1 drop-shadow strength */
  shadow: number;
  opacity: number;
  align: "left" | "center" | "right";
  uppercase: boolean;
  /** hard ceiling for the font size, as a fraction of the page width */
  maxFontRatio: number;
}

const INK = "#141210";
const PAPER = "#f7f4ee";

/**
 * Estimates the lettering style for a block from its classification plus cues
 * measured off the original artwork (ink coverage, background luminance).
 */
export function autoTypography(opts: {
  kind: BlockKind;
  onDark: boolean;
  intensity?: number | undefined;
  inkRatio?: number | undefined;
}): Typography {
  const { kind, onDark } = opts;
  const ink = opts.inkRatio ?? 0.2;
  const heavy = ink > 0.3;
  const base: Typography = {
    fontId: "bubble",
    weight: heavy ? 800 : 700,
    italic: false,
    letterSpacing: 0,
    lineHeight: 1.06,
    strokeWidth: 0,
    strokeColor: onDark ? INK : PAPER,
    color: onDark ? PAPER : INK,
    shadow: 0,
    opacity: 1,
    align: "center",
    uppercase: false,
    maxFontRatio: 0.055,
  };

  if (kind === "thought") return { ...base, italic: true, lineHeight: 1.1 };
  if (kind === "narration" || kind === "caption") {
    return {
      ...base,
      fontId: "narration",
      weight: 600,
      lineHeight: 1.18,
      letterSpacing: 0.005,
      maxFontRatio: 0.05,
    };
  }
  if (kind === "sign") {
    return {
      ...base,
      fontId: "display",
      weight: 400,
      uppercase: true,
      letterSpacing: 0.02,
      lineHeight: 1,
      maxFontRatio: 0.085,
    };
  }
  if (kind === "sfx") {
    const intensity = Math.min(5, Math.max(1, opts.intensity ?? 3));
    return {
      ...base,
      fontId: "sfx",
      weight: 400,
      uppercase: true,
      letterSpacing: -0.01,
      lineHeight: 0.92,
      strokeWidth: 0.06 + intensity * 0.012,
      shadow: 0.25 + intensity * 0.08,
      maxFontRatio: 0.13 + intensity * 0.012,
    };
  }
  return base;
}

/** Width of `text` rendered at 100px in the block's font, in px. */
export type Measurer = (text: string) => number;

export interface FitResult {
  fontSize: number;
  lines: string[];
  lineHeight: number;
  /** em, may be tightened below the requested value to make text fit */
  letterSpacing: number;
}

interface WrapResult {
  lines: string[];
  /** widest line, measured at 100px */
  maxWidth: number;
}

/**
 * Splits words into at most `target` lines while minimising the widest line.
 * Balanced breaks read far better than greedy wrapping inside a balloon.
 */
function wrapInto(words: string[], widths: number[], spaceW: number, target: number): WrapResult {
  const n = words.length;
  if (n === 0) return { lines: [], maxWidth: 0 };
  if (target >= n) {
    return { lines: words.slice(), maxWidth: Math.max(...widths) };
  }
  const lineWidth = (i: number, j: number) => {
    let w = 0;
    for (let k = i; k < j; k++) w += widths[k] ?? 0;
    return w + spaceW * (j - i - 1);
  };
  // best[l][i] = minimal possible widest line using l lines for words i..n-1
  const INF = Number.POSITIVE_INFINITY;
  const best: number[][] = Array.from({ length: target + 1 }, () => new Array(n + 1).fill(INF));
  const cut: number[][] = Array.from({ length: target + 1 }, () => new Array(n + 1).fill(n));
  for (let l = 0; l <= target; l++) best[l]![n] = 0;
  for (let l = 1; l <= target; l++) {
    for (let i = n - 1; i >= 0; i--) {
      for (let j = i + 1; j <= n; j++) {
        const candidate = Math.max(lineWidth(i, j), best[l - 1]![j] ?? INF);
        if (candidate < (best[l]![i] ?? INF)) {
          best[l]![i] = candidate;
          cut[l]![i] = j;
        }
      }
    }
  }
  const lines: string[] = [];
  let i = 0;
  let l = target;
  while (i < n && l > 0) {
    const j = cut[l]![i] ?? n;
    lines.push(words.slice(i, j).join(" "));
    i = j;
    l--;
  }
  return { lines, maxWidth: best[target]![0] ?? Math.max(...widths) };
}

/**
 * Solves font size, line breaks and spacing for a text inside a safe region.
 * Order of concessions: line breaks → letter spacing → font size → line spacing.
 */
export function fitText(opts: {
  text: string;
  /** usable interior in px */
  boxW: number;
  boxH: number;
  typo: Typography;
  measure: Measurer;
  /** hard ceiling in px */
  maxFont: number;
  minFont?: number;
}): FitResult {
  const { boxW, boxH, typo, measure } = opts;
  const minFont = opts.minFont ?? 7;
  const raw = typo.uppercase ? opts.text.toUpperCase() : opts.text;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || boxW <= 1 || boxH <= 1) {
    return { fontSize: minFont, lines: text ? [text] : [], lineHeight: typo.lineHeight, letterSpacing: typo.letterSpacing };
  }

  const words = text.split(" ");
  const spaceW = measure(" ") || 25;

  const attempt = (letterSpacing: number, lineHeight: number): FitResult => {
    const widths = words.map((w) => measure(w) + letterSpacing * 100 * w.length);
    const maxLines = Math.min(10, Math.max(1, words.length));
    let best: FitResult = {
      fontSize: minFont,
      lines: words,
      lineHeight,
      letterSpacing,
    };
    let bestSize = -1;
    for (let n = 1; n <= maxLines; n++) {
      const { lines, maxWidth } = wrapInto(words, widths, spaceW, n);
      if (!lines.length) continue;
      const byWidth = maxWidth > 0 ? (boxW / maxWidth) * 100 : opts.maxFont;
      const byHeight = (boxH / (lines.length * lineHeight)) * 100;
      const size = Math.min(byWidth, byHeight, opts.maxFont);
      if (size > bestSize) {
        bestSize = size;
        best = { fontSize: size, lines, lineHeight, letterSpacing };
      }
    }
    return best;
  };

  let result = attempt(typo.letterSpacing, typo.lineHeight);
  // Text still cramped: tighten spacing before dropping the size further.
  if (result.fontSize < 12) {
    const tighter = attempt(Math.max(-0.04, typo.letterSpacing - 0.025), Math.max(0.9, typo.lineHeight - 0.1));
    if (tighter.fontSize > result.fontSize) result = tighter;
  }
  result.fontSize = Math.max(minFont, Math.floor(result.fontSize * 100) / 100);
  return result;
}

/** Canvas-based measurer factory; one shared context, no DOM layout cost. */
let sharedCtx: CanvasRenderingContext2D | null = null;

export function makeMeasurer(typo: Typography): Measurer {
  if (typeof document === "undefined") return (t) => t.length * 50;
  if (!sharedCtx) sharedCtx = document.createElement("canvas").getContext("2d");
  const ctx = sharedCtx;
  if (!ctx) return (t) => t.length * 50;
  const font = `${typo.italic ? "italic " : ""}${typo.weight} 100px ${familyFor(typo.fontId)}`;
  return (text: string) => {
    ctx.font = font;
    return ctx.measureText(text).width;
  };
}
