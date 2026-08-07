/**
 * Core chapter-import contracts. This module is intentionally free of any
 * site-specific logic and safe to import from the browser.
 */

export interface Page {
  index: number;
  imageUrl: string;
  width: number;
  height: number;
  /** Referer some CDNs require; used by the image proxy only. */
  referer?: string;
}

export interface Chapter {
  id: string;
  title: string;
  chapterNumber: string;
  source: string;
  pages: Page[];
}

export interface ReaderAdapter {
  /** Stable adapter id, e.g. "mangadex". */
  readonly id: string;
  /** Human label shown in "supported sites". */
  readonly label: string;
  canHandle(url: string): boolean;
  loadChapter(url: string): Promise<Chapter>;
}

export type ImportFailure =
  | "invalid-url"
  | "unsupported-site"
  | "unreachable"
  | "no-pages"
  | "blocked"
  | "adapter-error";

export class ChapterImportError extends Error {
  constructor(
    readonly reason: ImportFailure,
    message: string,
  ) {
    super(message);
    this.name = "ChapterImportError";
  }
}

/** Normalises and validates a user-pasted chapter URL. */
export function parseChapterUrl(raw: string): URL {
  const trimmed = raw.trim();
  if (!trimmed) throw new ChapterImportError("invalid-url", "Paste a chapter URL first.");
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ChapterImportError("invalid-url", `"${raw}" is not a valid web address.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ChapterImportError("invalid-url", "Only http and https links can be imported.");
  }
  if (isPrivateHost(url.hostname)) {
    throw new ChapterImportError("blocked", "Local and private network addresses cannot be imported.");
  }
  return url;
}

export function isPrivateHost(hostname: string) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "0.0.0.0" || h === "[::1]" || h === "::1") return true;
  return (
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}
