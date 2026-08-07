/** Small, dependency-free HTML helpers shared by scraping adapters. */

const IMG_EXT = /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i;
const JUNK = /(sprite|icon|logo|avatar|banner|advert|ads?[-_/]|placeholder|loading|blank|spinner|1x1|pixel)/i;

export function decodeEntities(input: string) {
  return input
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function absolute(src: string, base: string) {
  try {
    return new URL(src.trim().replace(/\\\//g, "/"), base).toString();
  } catch {
    return null;
  }
}

/** Reading order is preserved: images are returned in document order. */
export function collectImageUrls(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const tagRe = /<img\b[^>]*>/gi;
  const attrRe = /(?:data-src|data-original|data-lazy-src|data-url|data-image|srcset|src)\s*=\s*["']([^"']+)["']/gi;

  for (const tag of html.match(tagRe) ?? []) {
    let best: string | null = null;
    attrRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(tag))) {
      const raw = (m[1] ?? "").split(",")[0]?.split(" ")[0] ?? "";
      if (!raw || raw.startsWith("data:")) continue;
      const abs = absolute(raw, baseUrl);
      if (!abs || JUNK.test(abs)) continue;
      // Prefer lazy-loading attributes (they hold the real page image).
      if (!best || /data-/i.test(m[0])) best = abs;
    }
    if (best && !seen.has(best)) {
      seen.add(best);
      out.push(best);
    }
  }
  return out;
}

/** Madara / TS-reader themes embed the page list in a script tag. */
export function collectScriptImageUrls(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const jsonUrlRe = /["'](https?:(?:\\\/|\/)\/[^"'\s]+?\.(?:jpe?g|png|webp|avif)(?:\?[^"'\s]*)?)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = jsonUrlRe.exec(html))) {
    const abs = absolute(m[1] ?? "", baseUrl);
    if (!abs || JUNK.test(abs) || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

export function looksLikePageImage(url: string) {
  return IMG_EXT.test(url) && !JUNK.test(url);
}

export function guessChapterNumber(url: string, html?: string) {
  const fromUrl =
    url.match(/(?:chapter|chap|ch|episode|ep)[-_/]?(\d+(?:[.-]\d+)?)/i)?.[1] ??
    url.match(/[?&](?:episode_no|chapter)=(\d+)/i)?.[1];
  if (fromUrl) return fromUrl.replace("-", ".");
  const fromHtml = html?.match(/(?:chapter|episode)\s*#?\s*(\d+(?:\.\d+)?)/i)?.[1];
  return fromHtml ?? "";
}
