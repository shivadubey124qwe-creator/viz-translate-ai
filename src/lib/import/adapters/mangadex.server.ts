import type { Chapter, Page, ReaderAdapter } from "../types";
import { ChapterImportError } from "../types";
import { fetchJson } from "../http.server";

interface AtHome {
  baseUrl: string;
  chapter: { hash: string; data: string[]; dataSaver: string[] };
}
interface ChapterMeta {
  data: {
    id: string;
    attributes: { chapter: string | null; title: string | null; volume: string | null };
    relationships: { type: string; attributes?: { title?: Record<string, string> } }[];
  };
}

const ID_RE = /\/chapter\/([0-9a-f-]{36})/i;

/** MangaDex exposes a documented public API, so no scraping is needed. */
export const mangadexAdapter: ReaderAdapter = {
  id: "mangadex",
  label: "MangaDex",

  canHandle(url) {
    try {
      const u = new URL(url);
      return /(^|\.)mangadex\.org$/i.test(u.hostname) && ID_RE.test(u.pathname);
    } catch {
      return false;
    }
  },

  async loadChapter(url) {
    const id = new URL(url).pathname.match(ID_RE)?.[1];
    if (!id) throw new ChapterImportError("invalid-url", "That MangaDex link has no chapter id.");

    const meta = await fetchJson<ChapterMeta>(
      `https://api.mangadex.org/chapter/${id}?includes[]=manga`,
    );
    const athome = await fetchJson<AtHome>(`https://api.mangadex.org/at-home/server/${id}`);
    const files = athome.chapter.data?.length ? athome.chapter.data : athome.chapter.dataSaver;
    const quality = athome.chapter.data?.length ? "data" : "data-saver";
    if (!files?.length) {
      throw new ChapterImportError("no-pages", "MangaDex returned no page images for that chapter.");
    }

    const manga = meta.data.relationships.find((r) => r.type === "manga");
    const titles = manga?.attributes?.title ?? {};
    const seriesTitle = titles["en"] ?? Object.values(titles)[0] ?? "MangaDex chapter";
    const chapterNumber = meta.data.attributes.chapter ?? "";

    const pages: Page[] = files.map((file, index) => ({
      index,
      imageUrl: `${athome.baseUrl}/${quality}/${athome.chapter.hash}/${file}`,
      width: 0,
      height: 0,
      referer: "https://mangadex.org/",
    }));

    const chapter: Chapter = {
      id: `mangadex:${id}`,
      title: [seriesTitle, chapterNumber && `Ch. ${chapterNumber}`, meta.data.attributes.title]
        .filter(Boolean)
        .join(" · "),
      chapterNumber,
      source: url,
      pages,
    };
    return chapter;
  },
};
