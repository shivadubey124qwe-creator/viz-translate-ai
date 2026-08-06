import { useSyncExternalStore } from "react";
import type { GlossaryEntry, PageTranslation } from "./translate.server";
import { translatePage } from "./translate.functions";
import { toDataUrl, type LoadedPage } from "./loaders";

export type PageStatus = "idle" | "queued" | "working" | "done" | "error";

export interface PageState {
  status: PageStatus;
  translation?: PageTranslation;
  error?: string;
  fromCache?: boolean;
}

export interface SessionSnapshot {
  title: string;
  pages: LoadedPage[];
  states: Record<number, PageState>;
  glossary: GlossaryEntry[];
  summary: string;
  targetLanguage: string;
  stats: { translated: number; cacheHits: number; avgMs: number };
}

const MAX_PARALLEL = 2;
const PREFETCH_DEPTH = 3;

function cacheKey(title: string, index: number) {
  return `mangalens:page:${title}:${index}`;
}
function tmKey(title: string) {
  return `mangalens:tm:${title}`;
}
function summaryKey(title: string) {
  return `mangalens:summary:${title}`;
}

class SessionStore {
  private listeners = new Set<() => void>();
  private running = 0;
  private queue: number[] = [];
  private latencies: number[] = [];

  private snapshot: SessionSnapshot = {
    title: "",
    pages: [],
    states: {},
    glossary: [],
    summary: "",
    targetLanguage: "English",
    stats: { translated: 0, cacheHits: 0, avgMs: 0 },
  };

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.snapshot;

  private emit(patch: Partial<SessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((l) => l());
  }

  private setPage(index: number, state: PageState) {
    this.emit({ states: { ...this.snapshot.states, [index]: state } });
  }

  hasSession() {
    return this.snapshot.pages.length > 0;
  }

  load(title: string, pages: LoadedPage[], targetLanguage = "English") {
    this.queue = [];
    this.running = 0;
    this.latencies = [];
    const glossary = readJson<GlossaryEntry[]>(tmKey(title)) ?? [];
    const summary = localStorage.getItem(summaryKey(title)) ?? "";
    this.snapshot = {
      title,
      pages,
      states: {},
      glossary,
      summary,
      targetLanguage,
      stats: { translated: 0, cacheHits: 0, avgMs: 0 },
    };
    this.listeners.forEach((l) => l());
  }

  setTargetLanguage(lang: string) {
    this.emit({ targetLanguage: lang });
  }

  /** Ensures page `index` is translated and keeps the next pages warm. */
  ensure(index: number) {
    this.request(index, true);
    for (let i = 1; i <= PREFETCH_DEPTH; i++) this.request(index + i, false);
  }

  /** Background pass over the rest of the chapter, never blocking the reader. */
  translateChapter(from: number) {
    for (let i = from; i < this.snapshot.pages.length; i++) this.request(i, false);
  }

  private request(index: number, priority: boolean) {
    const page = this.snapshot.pages[index];
    if (!page) return;
    const state = this.snapshot.states[index];
    if (state && state.status !== "error" && state.status !== "idle") return;

    const cached = readJson<PageTranslation>(cacheKey(this.snapshot.title, index));
    if (cached) {
      this.setPage(index, { status: "done", translation: cached, fromCache: true });
      this.emit({
        stats: {
          ...this.snapshot.stats,
          cacheHits: this.snapshot.stats.cacheHits + 1,
        },
      });
      return;
    }

    this.setPage(index, { status: "queued" });
    if (priority) this.queue.unshift(index);
    else this.queue.push(index);
    this.pump();
  }

  private pump() {
    while (this.running < MAX_PARALLEL && this.queue.length) {
      const next = this.queue.shift();
      if (next === undefined) return;
      this.running++;
      void this.work(next).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async work(index: number) {
    const page = this.snapshot.pages[index];
    if (!page) return;
    this.setPage(index, { status: "working" });
    try {
      const imageDataUrl = await toDataUrl(page.url);
      const result = await translatePage({
        data: {
          imageDataUrl,
          pageIndex: index,
          seriesTitle: this.snapshot.title,
          targetLanguage: this.snapshot.targetLanguage,
          glossary: this.snapshot.glossary.slice(0, 120),
          contextSummary: this.snapshot.summary,
        },
      });

      writeJson(cacheKey(this.snapshot.title, index), result);
      this.mergeGlossary(result.glossary);
      if (result.summary) {
        localStorage.setItem(summaryKey(this.snapshot.title), result.summary);
        this.emit({ summary: result.summary });
      }
      this.latencies.push(result.latencyMs);
      this.setPage(index, { status: "done", translation: result });
      this.emit({
        stats: {
          translated: this.snapshot.stats.translated + 1,
          cacheHits: this.snapshot.stats.cacheHits,
          avgMs: Math.round(
            this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length,
          ),
        },
      });
    } catch (err) {
      this.setPage(index, {
        status: "error",
        error: err instanceof Error ? err.message : "Translation failed.",
      });
    }
  }

  private mergeGlossary(entries: GlossaryEntry[]) {
    if (!entries.length) return;
    const map = new Map(this.snapshot.glossary.map((g) => [g.source, g]));
    for (const entry of entries) if (!map.has(entry.source)) map.set(entry.source, entry);
    const merged = [...map.values()].slice(0, 400);
    writeJson(tmKey(this.snapshot.title), merged);
    this.emit({ glossary: merged });
  }

  retry(index: number) {
    this.setPage(index, { status: "idle" });
    this.request(index, true);
  }

  clearCache() {
    const prefix = `mangalens:`;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
    this.emit({
      states: {},
      glossary: [],
      summary: "",
      stats: { translated: 0, cacheHits: 0, avgMs: 0 },
    });
  }
}

function readJson<T>(key: string): T | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* cache full — translations simply won't persist */
  }
}

export const session = new SessionStore();

export function useSession(): SessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}
