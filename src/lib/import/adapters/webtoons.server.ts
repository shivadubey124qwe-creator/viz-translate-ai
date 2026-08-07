import type { Chapter, Page, ReaderAdapter } from "../types";
import { ChapterImportError } from "../types";
import { fetchHtml } from "../http.server";
import { collectImageUrls, decodeEntities, guessChapterNumber } from "../html.server";

/**
 * Naver / LINE WEBTOON viewer pages. Images live in `#_imageList img` and the
 * CDN requires a webtoons.com referer, which the image proxy replays.
 */
export const webtoonsAdapter: ReaderAdapter = {
  id: "webtoons",
  label: "WEBTOON (webtoons.com)",

  canHandle(url) {
    try {
      const u = new URL(url);
      return /(^|\.)webtoons\.com$/i.test(u.hostname) && /viewer/i.test(u.pathname + u.search);
    } catch {
      return false;
    }
  },

  async loadChapter(url) {
    const html = await fetchHtml(url);
    const list = html.match(/id="_imageList"[\s\S]*?<\/div>/i)?.[0] ?? html;
    const urls = collectImageUrls(list, url).filter((u) =>
      /pstatic\.net|webtoon/i.test(u) ? !/thumb|banner|logo/i.test(u) : true,
    );
    if (!urls.length) {
      throw new ChapterImportError(
        "no-pages",
        "No page images were found on that WEBTOON viewer page. Age-restricted or paid episodes cannot be imported.",
      );
    }

    const title = decodeEntities(
      html.match(/<h1[^>]*class="subj[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ??
        html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ??
        "WEBTOON episode",
    ).replace(/\s+/g, " ").trim();

    const pages: Page[] = urls.map((imageUrl, index) => ({
      index,
      imageUrl,
      width: 0,
      height: 0,
      referer: "https://www.webtoons.com/",
    }));

    const chapter: Chapter = {
      id: `webtoons:${new URL(url).search || new URL(url).pathname}`,
      title,
      chapterNumber: guessChapterNumber(url, html),
      source: url,
      pages,
    };
    return chapter;
  },
};
