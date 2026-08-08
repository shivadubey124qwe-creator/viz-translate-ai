import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { PageView } from "@/components/PageView";
import { BlockInspector } from "@/components/BlockInspector";
import { session, useSession } from "@/lib/session";
import { exportCbz } from "@/lib/export";
import { buildBlocks, type TextBlock } from "@/lib/blocks";
import {
  readModePreference,
  resolveMode,
  writeModePreference,
  type ReaderModePreference,
} from "@/lib/readerMode";

export const Route = createFileRoute("/reader")({
  head: () => ({
    meta: [
      { title: "Reader — MangaLens AI" },
      {
        name: "description",
        content:
          "Vertical-scroll and page-by-page translated reader with bubble-fitted lettering and a live text-block editor.",
      },
      { property: "og:title", content: "MangaLens AI Reader" },
      {
        property: "og:description",
        content: "Read translated manga and manhwa rendered onto the original artwork.",
      },
    ],
  }),
  component: Reader,
});

/** Pages within this distance of the reading position stay fully rendered. */
const WINDOW = 2;

function Reader() {
  const navigate = useNavigate();
  const snap = useSession();
  const [index, setIndex] = useState(0);
  const [modePref, setModePref] = useState<ReaderModePreference>("auto");
  const [showTranslation, setShowTranslation] = useState(true);
  const [opacity, setOpacity] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const restoreTo = useRef<number | null>(null);

  useEffect(() => {
    if (!session.hasSession()) void navigate({ to: "/" });
    setModePref(readModePreference());
  }, [navigate]);

  const mode = resolveMode(modePref, snap.pages);

  // Translation + analysis follow the reading position only — switching modes
  // never re-runs OCR or translation.
  useEffect(() => {
    if (snap.pages.length) session.ensure(index);
  }, [index, snap.pages.length]);

  useEffect(() => {
    const keep: number[] = [];
    for (let i = index - WINDOW; i <= index + WINDOW; i++) {
      if (i >= 0 && i < snap.pages.length) {
        keep.push(i);
        session.analyze(i);
      }
    }
    session.prune(keep);
  }, [index, snap.pages.length, snap.states, snap.overrides]);

  // Keep the reading position when the mode changes.
  useEffect(() => {
    if (mode !== "vertical") return;
    const target = restoreTo.current ?? index;
    restoreTo.current = null;
    const el = pageRefs.current[target];
    if (el) el.scrollIntoView({ block: "start" });
  }, [mode]);

  useEffect(() => {
    if (mode !== "paged") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, snap.pages.length - 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, snap.pages.length]);

  // Vertical mode: the most visible page defines the current position.
  useEffect(() => {
    if (mode !== "vertical" || !snap.pages.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        let best: { i: number; ratio: number } | null = null;
        for (const entry of entries) {
          const i = Number((entry.target as HTMLElement).dataset["pageIndex"]);
          if (!Number.isFinite(i)) continue;
          if (!best || entry.intersectionRatio > best.ratio) {
            best = { i, ratio: entry.intersectionRatio };
          }
        }
        if (best && best.ratio > 0.15) setIndex(best.i);
      },
      { threshold: [0.15, 0.4, 0.75] },
    );
    for (const el of Object.values(pageRefs.current)) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [mode, snap.pages.length]);

  const blocksFor = (pageIndex: number): TextBlock[] => {
    const regions = snap.states[pageIndex]?.translation?.regions ?? [];
    return buildBlocks(regions, snap.visions[pageIndex], snap.overrides, pageIndex);
  };

  const page = snap.pages[index];
  const state = snap.states[index];
  const currentBlocks = useMemo(
    () => blocksFor(index),
    [index, snap.states, snap.visions, snap.overrides],
  );
  const selectedBlock = useMemo(() => {
    if (!selected) return null;
    for (let i = 0; i < snap.pages.length; i++) {
      const found = blocksFor(i).find((b) => b.id === selected);
      if (found) return found;
    }
    return null;
  }, [selected, snap.states, snap.visions, snap.overrides]);

  const done = useMemo(
    () => Object.values(snap.states).filter((s) => s.status === "done").length,
    [snap.states],
  );

  if (!page) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6 text-center">
        <div>
          <h1 className="text-3xl">No chapter open</h1>
          <Link to="/" className="mt-4 inline-block text-primary underline">
            Open a chapter
          </Link>
        </div>
      </main>
    );
  }

  function changeMode(pref: ReaderModePreference) {
    restoreTo.current = index;
    setModePref(pref);
    writeModePreference(pref);
  }

  async function handleExport() {
    setExporting("Rendering…");
    try {
      const entries = snap.pages.map((p) => ({
        page: p,
        regions: snap.states[p.index]?.translation?.regions ?? [],
      }));
      await exportCbz(
        snap.title,
        entries,
        (d, t) => setExporting(`Rendering ${d}/${t}…`),
        snap.overrides,
      );
    } catch (err) {
      setExporting(err instanceof Error ? err.message : "Export failed");
      setTimeout(() => setExporting(null), 2500);
      return;
    }
    setExporting(null);
  }

  // Page-by-page swipe support.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = t ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchStart.current;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(t.clientY - start.y)) {
      if (dx < 0) setIndex((i) => Math.min(i + 1, snap.pages.length - 1));
      else setIndex((i) => Math.max(i - 1, 0));
    }
    touchStart.current = null;
  };

  return (
    <main className="min-h-screen pb-32">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
          <Link to="/" className="font-display tracking-[0.2em] text-primary">
            MANGALENS
          </Link>
          <span className="truncate text-sm text-muted-foreground">{snap.title}</span>
          <div className="flex items-center gap-1 text-xs">
            {(["vertical", "paged", "auto"] as ReaderModePreference[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => changeMode(m)}
                className={
                  "rounded-sm border border-border px-2 py-1 capitalize " +
                  (modePref === m ? "bg-primary text-primary-foreground" : "")
                }
              >
                {m === "paged" ? "Page" : m === "vertical" ? "Scroll" : "Auto"}
              </button>
            ))}
          </div>
          <span className="ml-auto text-xs text-muted-foreground">
            {done}/{snap.pages.length} translated · {snap.stats.cacheHits} cached
            {snap.stats.avgMs ? ` · ${snap.stats.avgMs}ms avg` : ""}
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-6">
        {mode === "vertical" ? (
          <div className="flex flex-col">
            {snap.pages.map((p) => {
              const near = Math.abs(p.index - index) <= WINDOW + 2;
              return (
                <div
                  key={p.index}
                  data-page-index={p.index}
                  ref={(el) => {
                    pageRefs.current[p.index] = el;
                  }}
                  style={
                    !near && p.width && p.height
                      ? { aspectRatio: `${p.width} / ${p.height}` }
                      : undefined
                  }
                  className="w-full"
                >
                  {near ? (
                    <PageView
                      page={p}
                      blocks={blocksFor(p.index)}
                      showTranslation={showTranslation}
                      opacity={opacity}
                      onBlockClick={(b) => setSelected(b.id)}
                      selectedId={selected}
                      continuous
                      priority={p.index === index}
                    />
                  ) : (
                    <div className="h-full w-full bg-muted/30" aria-hidden />
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="relative" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            <PageView
              page={page}
              blocks={currentBlocks}
              showTranslation={showTranslation}
              opacity={opacity}
              onBlockClick={(b) => setSelected(b.id)}
              selectedId={selected}
              priority
            />
            {/* Tap zones for page turning. */}
            <button
              type="button"
              aria-label="Previous page"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              className="absolute inset-y-0 left-0 w-[12%] cursor-w-resize"
            />
            <button
              type="button"
              aria-label="Next page"
              onClick={() => setIndex((i) => Math.min(snap.pages.length - 1, i + 1))}
              className="absolute inset-y-0 right-0 w-[12%] cursor-e-resize"
            />
          </div>
        )}

        {state?.status === "working" && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-sm bg-card px-3 py-1.5 text-xs">
            <Loader2 className="size-3.5 animate-spin text-primary" />
            Translating page {index + 1}…
          </div>
        )}
        {state?.status === "error" && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-sm bg-destructive px-3 py-1.5 text-xs text-destructive-foreground">
            {state.error}
            <button type="button" onClick={() => session.retry(index)} className="underline">
              Retry
            </button>
          </div>
        )}

        {snap.glossary.length > 0 && (
          <section className="mt-8">
            <h2 className="text-sm tracking-widest text-muted-foreground">Series memory</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {snap.glossary.slice(0, 24).map((g) => (
                <span
                  key={g.source + g.target}
                  className="rounded-sm border border-border px-2 py-1 text-xs text-muted-foreground"
                >
                  {g.source} → <span className="text-foreground">{g.target}</span>
                </span>
              ))}
            </div>
          </section>
        )}
      </div>

      {selectedBlock && (
        <BlockInspector
          block={selectedBlock}
          onClose={() => setSelected(null)}
          canUndo={snap.canUndo}
          canRedo={snap.canRedo}
        />
      )}

      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
          <button
            type="button"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
            className="rounded-sm border border-border p-2 disabled:opacity-40"
            aria-label="Previous page"
          >
            <ChevronLeft className="size-5" />
          </button>
          <span className="font-display text-lg">
            {index + 1}
            <span className="text-muted-foreground">/{snap.pages.length}</span>
          </span>
          <button
            type="button"
            onClick={() => setIndex((i) => Math.min(snap.pages.length - 1, i + 1))}
            disabled={index >= snap.pages.length - 1}
            className="rounded-sm border border-border p-2 disabled:opacity-40"
            aria-label="Next page"
          >
            <ChevronRight className="size-5" />
          </button>

          <button
            type="button"
            onClick={() => setShowTranslation((v) => !v)}
            className="inline-flex items-center gap-2 rounded-sm border border-border px-3 py-2 text-sm"
          >
            {showTranslation ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
            {showTranslation ? "Translated" : "Original"}
          </button>

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Opacity
            <input
              type="range"
              min={0.2}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              className="accent-primary"
              aria-label="Translation opacity"
            />
          </label>

          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => session.retry(index)}
              className="inline-flex items-center gap-2 rounded-sm border border-border px-3 py-2 text-sm"
            >
              <RefreshCw className="size-4" />
              Retranslate
            </button>
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={Boolean(exporting)}
              className="inline-flex items-center gap-2 rounded-sm bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-60"
            >
              <Download className="size-4" />
              {exporting ?? "Export CBZ"}
            </button>
            <button
              type="button"
              onClick={() => session.clearCache()}
              className="rounded-sm border border-border p-2"
              aria-label="Clear cache"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        </div>
      </nav>
    </main>
  );
}
