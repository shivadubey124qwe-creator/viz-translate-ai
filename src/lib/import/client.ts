import type { Chapter, Page } from "./types";

/** Same-origin URL for a remote page image (canvas-safe, referer replayed). */
export function proxiedImageUrl(page: Pick<Page, "imageUrl" | "referer">) {
  const params = new URLSearchParams({ url: page.imageUrl });
  if (page.referer) params.set("referer", page.referer);
  return `/api/public/image?${params.toString()}`;
}

export function chapterSourceLabel(chapter: Chapter) {
  try {
    return new URL(chapter.source).hostname.replace(/^www\./, "");
  } catch {
    return chapter.source;
  }
}

export const SUPPORTED_SITES = [
  "MangaDex chapter links",
  "WEBTOON (webtoons.com) episode viewer",
  "Most Madara / TS-reader manga & manhwa sites",
];
