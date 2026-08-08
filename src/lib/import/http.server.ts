import { ChapterImportError, isPrivateHost } from "./types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export function browserHeaders(url: string, referer?: string) {
  const origin = new URL(url).origin;
  return {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: referer ?? `${origin}/`,
  };
}

async function guarded(url: string, init?: RequestInit) {
  if (isPrivateHost(new URL(url).hostname)) {
    throw new ChapterImportError("blocked", "That address is not publicly reachable.");
  }
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", ...init });
  } catch {
    throw new ChapterImportError("unreachable", `Could not reach ${new URL(url).hostname}.`);
  }
  if (!res.ok) {
    const why =
      res.status === 403 || res.status === 401
        ? "the site refused the request (it may require login or block automated readers)"
        : res.status === 404
          ? "the page was not found"
          : `the site responded with ${res.status}`;
    throw new ChapterImportError("unreachable", `Could not load that chapter — ${why}.`);
  }
  return res;
}

/**
 * Decodes with the charset the site actually uses. Many Korean/Japanese readers
 * still serve EUC-KR / Shift_JIS and only declare it in a <meta> tag, which is
 * where the U+FFFD replacement characters came from.
 */
function decodeHtml(buffer: ArrayBuffer, contentType: string | null): string {
  const bytes = new Uint8Array(buffer);
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  const ascii = new TextDecoder("utf-8").decode(bytes.subarray(0, 4096));
  const fromMeta =
    /<meta[^>]+charset=["']?([\w-]+)/i.exec(ascii)?.[1] ??
    /<meta[^>]+content=["'][^"']*charset=([\w-]+)/i.exec(ascii)?.[1];
  const label = (fromHeader ?? fromMeta ?? "utf-8").toLowerCase();
  for (const candidate of [label, "utf-8"]) {
    try {
      return new TextDecoder(candidate, { fatal: false }).decode(bytes);
    } catch {
      /* unknown label — fall through to utf-8 */
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export async function fetchHtml(url: string, referer?: string): Promise<string> {
  const res = await guarded(url, { headers: browserHeaders(url, referer) });
  return decodeHtml(await res.arrayBuffer(), res.headers.get("content-type"));
}


export async function fetchJson<T>(url: string): Promise<T> {
  const res = await guarded(url, {
    headers: { ...browserHeaders(url), Accept: "application/json" },
  });
  return (await res.json()) as T;
}
