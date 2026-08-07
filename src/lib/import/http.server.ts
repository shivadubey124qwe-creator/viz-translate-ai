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

export async function fetchHtml(url: string, referer?: string): Promise<string> {
  const res = await guarded(url, { headers: browserHeaders(url, referer) });
  return res.text();
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await guarded(url, {
    headers: { ...browserHeaders(url), Accept: "application/json" },
  });
  return (await res.json()) as T;
}
