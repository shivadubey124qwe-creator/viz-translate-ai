import type { LoadedPage } from "./loaders";

export type ReaderMode = "vertical" | "paged";
export type ReaderModePreference = ReaderMode | "auto";

const KEY = "mangalens:reader-mode";

/**
 * Long-strip detection: webtoon/manhwa pages are far taller than wide, so the
 * median aspect ratio of the chapter decides the natural reading mode.
 */
export function detectMode(pages: LoadedPage[]): ReaderMode {
  const ratios = pages
    .filter((p) => p.width > 0 && p.height > 0)
    .map((p) => p.height / p.width)
    .sort((a, b) => a - b);
  if (!ratios.length) return "vertical";
  const median = ratios[Math.floor(ratios.length / 2)] ?? 1.4;
  const longStrip = ratios.filter((r) => r >= 2).length / ratios.length;
  if (median >= 1.9 || longStrip >= 0.4) return "vertical";
  return "paged";
}

export function resolveMode(pref: ReaderModePreference, pages: LoadedPage[]): ReaderMode {
  return pref === "auto" ? detectMode(pages) : pref;
}

export function readModePreference(): ReaderModePreference {
  if (typeof localStorage === "undefined") return "auto";
  const raw = localStorage.getItem(KEY);
  return raw === "vertical" || raw === "paged" || raw === "auto" ? raw : "auto";
}

export function writeModePreference(pref: ReaderModePreference) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* private mode — preference simply isn't remembered */
  }
}
