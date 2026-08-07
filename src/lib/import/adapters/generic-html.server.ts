import type { Chapter, Page, ReaderAdapter } from "../types";
import { ChapterImportError } from "../types";
import { fetchHtml } from "../http.server";
import {
  collectImageUrls,
  collectScriptImageUrls,
  decodeEntities,
  guessChapterNumber,
  looksLikePageImage,
} from "../html.server";

const READER_CONTAINER =
  /<(?:div|section|article)[^>]*(?:id|class)="[^"]*(?:reading-content|reader-area|chapter-content|entry-content|viewer|page-?container|imageList|comic|chapter_?images)[^"]*"[\s\S]*/i;

/**
 * Last-resort adapter for the many reader themes (Madara, TS-reader, custom)
 * that simply list the page images in the chapter document.
 */
export const genericHtmlAdapter: ReaderAdapter = {
  id: "generic-html",
  label: "Generic reader page",

  canHandle() {
    return true;
  },

  async loadChapter(url) {
    const html = await fetchHtml(url);
    const scope = html.match(READER_CONTAINER)?.[0] ?? html;

    let urls = collectImageUrls(scope, url).filter(looksLikePageImage);
    if (urls.length < 2) {
      const scripted = collectScriptImageUrls(html, url).filter(looksLikePageImage);
      if (scripted.length > urls.length) urls = scripted;
    }
    if (urls.length < 2) {
      const all = collectImageUrls(html, url).filter(looksLikePageImage);
      if (all.length > urls.length) urls = all;
    }

    if (!urls.length) {
      throw new ChapterImportError(
        "no-pages",
        "No chapter images were found on that page. It may load pages with JavaScript, sit behind a login, or not be a chapter URL.",
      );
    }

    const host = new URL(url).hostname.replace(/^www\./, "");
    const title = decodeEntities(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? host)
      .replace(/\s+/g, " ")
      .replace(/\s*[-|–]\s*[^-|–]*$/, "")
      .trim();

    const pages: Page[] = urls.map((imageUrl, index) => ({
      index,
      imageUrl,
      width: 0,
      height: 0,
      referer: `${new URL(url).origin}/`,
    }));

    const chapter: Chapter = {
      id: `generic:${host}${new URL(url).pathname}`,
      title: title || host,
      chapterNumber: guessChapterNumber(url, html),
      source: url,
      pages,
    };
    return chapter;
  },
};
