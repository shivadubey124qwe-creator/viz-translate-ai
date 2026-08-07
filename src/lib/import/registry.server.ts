import type { Chapter, ReaderAdapter } from "./types";
import { ChapterImportError, parseChapterUrl } from "./types";
import { mangadexAdapter } from "./adapters/mangadex.server";
import { webtoonsAdapter } from "./adapters/webtoons.server";
import { genericHtmlAdapter } from "./adapters/generic-html.server";

/**
 * Adapter registry. Site support is added by appending an adapter here —
 * no core code changes. Order matters: the generic fallback stays last.
 */
export const adapters: ReaderAdapter[] = [mangadexAdapter, webtoonsAdapter, genericHtmlAdapter];

export function resolveAdapter(url: string): ReaderAdapter {
  const adapter = adapters.find((a) => a.canHandle(url));
  if (!adapter) throw new ChapterImportError("unsupported-site", "No reader adapter handles that site yet.");
  return adapter;
}

/** Validate → resolve adapter → load → normalise. */
export async function importChapterFromUrl(rawUrl: string): Promise<Chapter> {
  const url = parseChapterUrl(rawUrl);
  const adapter = resolveAdapter(url.toString());

  let chapter: Chapter;
  try {
    chapter = await adapter.loadChapter(url.toString());
  } catch (err) {
    if (err instanceof ChapterImportError) throw err;
    throw new ChapterImportError(
      "adapter-error",
      err instanceof Error ? err.message : `The ${adapter.label} importer failed.`,
    );
  }

  const pages = chapter.pages
    .filter((p) => Boolean(p.imageUrl))
    .map((page, index) => ({ ...page, index }));
  if (!pages.length) throw new ChapterImportError("no-pages", "That chapter contained no readable pages.");

  return { ...chapter, title: chapter.title.trim() || "Imported chapter", pages };
}
