import { useSyncExternalStore } from "react";
import type { GlossaryEntry, PageTranslation } from "./translate.server";
import { translatePage } from "./translate.functions";
import { toDataUrl, type LoadedPage } from "./loaders";
import { analyzeRegions, type BlockVision } from "./vision";
import type { BlockOverride } from "./blocks";
import {
  renderCache,
  translationCache,
  idbClearAll,
  loadReadingPosition,
  saveReadingPosition,
  type CacheIdentity,
} from "./cache";

export type PageStatus =
  | "idle"
  | "queued"
  | "translating"
  | "cleaning"
  | "done"
  | "error";

export interface PageState {
  status: PageStatus;
  translation?: PageTranslation;
  error?: string;
  /** Where the result came from: "memory" | "cache" | "network". */
  origin?: "memory" | "cache" | "network";
}

export interface SessionSnapshot {
  title: string;
  pages: LoadedPage[];
  states: Record<number, PageState>;
  glossary: GlossaryEntry[];
  summary: string;
  targetLanguage: string;
  /** Bubble/cleanup analysis per page, keyed by region id (in-memory window). */
  visions: Record<number, Record<string, BlockVision>>;
  /** Manual block edits, keyed by region id. */
  overrides: Record<string, BlockOverride>;
  canUndo: boolean;
  canRedo: boolean;
  stats: { translated: number; cacheHits: number; avgMs: number };
}

const MAX_PARALLEL = 2;

function tmKey(title: string) {
  return `mangalens:tm:${title}`;
}
function summaryKey(title: string) {
  return `mangalens:summary:${title}`;
}
function overrideKey(title: string) {
  return `mangalens:blocks:${title}`;
}

interface QueueItem {
  index: number;
  priority: number;
}

class SessionStore {
  private listeners = new Set<() => void>();
  private running = 0;
  private queue: QueueItem[] = [];
  private latencies: number[] = [];
  private analyzing = new Set<number>();
  private undoStack: Record<string, BlockOverride>[] = [];
  private redoStack: Record<string, BlockOverride>[] = [];
  /** Vision results survive DOM unmount; only the snapshot window is pruned. */
  private visionMemory = new Map<number, Record<string, BlockVision>>();
  private translationMemory = new Map<number, PageTranslation>();
  private hydrating = new Set<number>();

  private snapshot: SessionSnapshot = {
    title: "",
    pages: [],
    states: {},
    glossary: [],
    summary: "",
    targetLanguage: "English",
    visions: {},
    overrides: {},
    canUndo: false,
    canRedo: false,
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

  private identity(index: number): CacheIdentity {
    const page = this.snapshot.pages[index];
    return {
      chapterId: this.snapshot.title || "chapter",
      pageIndex: index,
      sourceKey: `${page?.name ?? index}|${page?.width ?? 0}x${page?.height ?? 0}`,
      targetLanguage: this.snapshot.targetLanguage,
    };
  }

  load(title: string, pages: LoadedPage[], targetLanguage = "English") {
    this.queue = [];
    this.running = 0;
    this.latencies = [];
    this.analyzing.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.visionMemory.clear();
    this.translationMemory.clear();
    this.hydrating.clear();
    const glossary = readJson<GlossaryEntry[]>(tmKey(title)) ?? [];
    const summary = localStorage.getItem(summaryKey(title)) ?? "";
    const overrides = readJson<Record<string, BlockOverride>>(overrideKey(title)) ?? {};
    this.snapshot = {
      title,
      pages,
      states: {},
      glossary,
      summary,
      targetLanguage,
      visions: {},
      overrides,
      canUndo: false,
      canRedo: false,
      stats: { translated: 0, cacheHits: 0, avgMs: 0 },
    };
    this.listeners.forEach((l) => l());
  }

  setTargetLanguage(lang: string) {
    this.emit({ targetLanguage: lang });
  }

  savePosition(pageIndex: number, scrollY: number, mode: string, fullscreen: boolean) {
    if (!this.snapshot.title) return;
    void saveReadingPosition({
      chapterId: this.snapshot.title,
      pageIndex,
      scrollY,
      mode,
      targetLanguage: this.snapshot.targetLanguage,
      fullscreen,
      updatedAt: Date.now(),
    });
  }

  position() {
    return this.snapshot.title ? loadReadingPosition(this.snapshot.title) : Promise.resolve(null);
  }

  /**
   * Ensures the reading position is translated and keeps pages warm in the
   * direction of travel. Never re-runs work that is already cached.
   */
  ensure(index: number, direction: 1 | -1 = 1, depth = 3) {
    void this.request(index, 0);
    for (let i = 1; i <= depth; i++) void this.request(index + i * direction, i);
    void this.request(index - direction, depth + 1);
  }

  /** Background pass over the rest of the chapter, never blocking scrolling. */
  translateChapter(from: number) {
    for (let i = from; i < this.snapshot.pages.length; i++) void this.request(i, 100 + i);
  }

  private async request(index: number, priority: number) {
    const page = this.snapshot.pages[index];
    if (!page) return;
    const state = this.snapshot.states[index];
    if (state && state.status !== "error" && state.status !== "idle") return;
    if (this.hydrating.has(index)) return;

    // 1. in-memory result (survives page unmount)
    const inMemory = this.translationMemory.get(index);
    if (inMemory) {
      this.setPage(index, { status: "done", translation: inMemory, origin: "memory" });
      return;
    }

    // 2. persistent cache — instant, no OCR/translation/API call
    this.hydrating.add(index);
    const cached = await translationCache.get<PageTranslation>(this.identity(index));
    this.hydrating.delete(index);
    if (cached) {
      this.translationMemory.set(index, cached);
      this.setPage(index, { status: "done", translation: cached, origin: "cache" });
      this.emit({
        stats: { ...this.snapshot.stats, cacheHits: this.snapshot.stats.cacheHits + 1 },
      });
      return;
    }

    // 3. queue for processing
    if (this.queue.some((q) => q.index === index)) return;
    this.setPage(index, { status: "queued" });
    this.queue.push({ index, priority });
    this.queue.sort((a, b) => a.priority - b.priority);
    this.pump();
  }

  private pump() {
    while (this.running < MAX_PARALLEL && this.queue.length) {
      const next = this.queue.shift();
      if (!next) return;
      this.running++;
      void this.work(next.index).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private previousPageText(index: number) {
    const prev = this.translationMemory.get(index - 1);
    if (!prev) return "";
    return prev.regions
      .map((r) => r.target)
      .filter(Boolean)
      .join(" / ");
  }

  private async work(index: number) {
    const page = this.snapshot.pages[index];
    if (!page) return;
    this.setPage(index, { status: "translating" });
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
          previousPageText: this.previousPageText(index),
        },
      });

      this.translationMemory.set(index, result);
      void translationCache.set(this.identity(index), result);
      this.mergeGlossary(result.glossary);
      if (result.summary) {
        localStorage.setItem(summaryKey(this.snapshot.title), result.summary);
        this.emit({ summary: result.summary });
      }
      this.latencies.push(result.latencyMs);
      this.setPage(index, { status: "done", translation: result, origin: "network" });
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
      // A provider failure is scoped to this page only: the reader, cached
      // pages and navigation all stay usable.
      this.setPage(index, {
        status: "error",
        error: err instanceof Error ? err.message : "Translation failed.",
      });
    }
  }

  // ---- vision (bubble geometry + glyph cleanup) ----------------------------

  /**
   * Measures bubbles and builds transparent reconstruction plates for a page.
   * Runs at most once per page: results are held in memory and mirrored into the
   * render cache, so scrolling back never reprocesses anything.
   */
  analyze(index: number) {
    const page = this.snapshot.pages[index];
    const regions = this.snapshot.states[index]?.translation?.regions;
    if (!page || !regions?.length) return;
    if (this.snapshot.visions[index] || this.analyzing.has(index)) return;

    const remembered = this.visionMemory.get(index);
    if (remembered) {
      this.emit({ visions: { ...this.snapshot.visions, [index]: remembered } });
      return;
    }

    this.analyzing.add(index);
    void (async () => {
      try {
        const id = this.identity(index);
        const stored = await renderCache.get<Record<string, BlockVision>>(id);
        if (stored && regions.every((r) => stored[r.id])) {
          this.visionMemory.set(index, stored);
          this.emit({ visions: { ...this.snapshot.visions, [index]: stored } });
          return;
        }
        this.setPage(index, { ...(this.snapshot.states[index] ?? { status: "done" }), status: "cleaning" });
        const visions = await analyzeRegions(
          page.url,
          regions.map((r) => ({
            id: r.id,
            box: r.box,
            sfx: (this.snapshot.overrides[r.id]?.kind ?? r.kind) === "sfx",
          })),
        );
        this.visionMemory.set(index, visions);
        void renderCache.set(id, visions);
        this.emit({ visions: { ...this.snapshot.visions, [index]: visions } });
      } catch {
        /* cleanup failure leaves the original artwork untouched */
      } finally {
        this.analyzing.delete(index);
        const state = this.snapshot.states[index];
        if (state?.status === "cleaning") this.setPage(index, { ...state, status: "done" });
      }
    })();
  }

  /**
   * Cleanup plates for an export, taken from memory or the render cache only —
   * never recomputed. Export therefore reuses exactly what the reader showed.
   */
  async cachedVisions(index: number): Promise<Record<string, BlockVision> | undefined> {
    const remembered = this.visionMemory.get(index);
    if (remembered) return remembered;
    const stored = await renderCache.get<Record<string, BlockVision>>(this.identity(index));
    return stored ?? undefined;
  }


  /**
   * Releases the snapshot's active rendering window. Results stay in memory and
   * in the persistent cache, so re-entry is instant and never reprocesses.
   */
  prune(keep: number[]) {
    const set = new Set(keep);
    const next: Record<number, Record<string, BlockVision>> = {};
    let changed = false;
    for (const [key, value] of Object.entries(this.snapshot.visions)) {
      if (set.has(Number(key))) next[Number(key)] = value;
      else changed = true;
    }
    if (changed) this.emit({ visions: next });

    // Bound in-memory plates for very long chapters; the cache still has them.
    if (this.visionMemory.size > 24) {
      const far = [...this.visionMemory.keys()]
        .filter((k) => !set.has(k))
        .sort((a, b) => Math.abs(b - (keep[0] ?? 0)) - Math.abs(a - (keep[0] ?? 0)));
      for (const key of far.slice(0, this.visionMemory.size - 24)) {
        this.visionMemory.delete(key);
      }
    }
  }

  // ---- manual block editing ----------------------------------------------

  private commit(overrides: Record<string, BlockOverride>) {
    this.undoStack.push(this.snapshot.overrides);
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
    writeJson(overrideKey(this.snapshot.title), overrides);
    this.emit({ overrides, canUndo: true, canRedo: false });
  }

  setOverride(id: string, patch: BlockOverride) {
    const current = this.snapshot.overrides[id] ?? {};
    const merged: BlockOverride = { ...current, ...patch };
    if (patch.typography) merged.typography = { ...current.typography, ...patch.typography };
    if (patch.position) merged.position = { ...current.position, ...patch.position };
    this.commit({ ...this.snapshot.overrides, [id]: merged });
  }

  resetTypography(id: string) {
    const current = { ...(this.snapshot.overrides[id] ?? {}) };
    delete current.typography;
    this.commit({ ...this.snapshot.overrides, [id]: current });
  }

  resetPosition(id: string) {
    const current = { ...(this.snapshot.overrides[id] ?? {}) };
    delete current.position;
    this.commit({ ...this.snapshot.overrides, [id]: current });
  }

  autoFit(id: string) {
    const current = { ...(this.snapshot.overrides[id] ?? {}) };
    delete current.typography;
    delete current.position;
    this.commit({ ...this.snapshot.overrides, [id]: current });
  }

  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.snapshot.overrides);
    writeJson(overrideKey(this.snapshot.title), prev);
    this.emit({
      overrides: prev,
      canUndo: this.undoStack.length > 0,
      canRedo: true,
    });
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot.overrides);
    writeJson(overrideKey(this.snapshot.title), next);
    this.emit({
      overrides: next,
      canUndo: true,
      canRedo: this.redoStack.length > 0,
    });
  }

  // ---- translation memory -------------------------------------------------

  /** Explicit, user-confirmed correction stored for the rest of the series. */
  saveToMemory(entry: GlossaryEntry) {
    if (!entry.source.trim() || !entry.target.trim()) return;
    const map = new Map(this.snapshot.glossary.map((g) => [g.source, g]));
    map.set(entry.source, entry);
    const merged = [...map.values()].slice(0, 400);
    writeJson(tmKey(this.snapshot.title), merged);
    this.emit({ glossary: merged });
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
    const id = this.identity(index);
    void translationCache.drop(id);
    void renderCache.drop(id);
    this.translationMemory.delete(index);
    this.visionMemory.delete(index);
    const visions = { ...this.snapshot.visions };
    delete visions[index];
    this.emit({ visions });
    this.setPage(index, { status: "idle" });
    void this.request(index, 0);
  }

  clearCache() {
    const prefix = `mangalens:`;
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(prefix)) localStorage.removeItem(key);
    }
    void idbClearAll();
    this.undoStack = [];
    this.redoStack = [];
    this.visionMemory.clear();
    this.translationMemory.clear();
    this.emit({
      states: {},
      glossary: [],
      summary: "",
      visions: {},
      overrides: {},
      canUndo: false,
      canRedo: false,
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
    /* storage full — small metadata simply isn't persisted */
  }
}

export const session = new SessionStore();

export function useSession(): SessionSnapshot {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}
