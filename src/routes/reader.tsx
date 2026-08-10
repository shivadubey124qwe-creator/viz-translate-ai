import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { PageSlot } from "@/components/PageSlot";
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
          "Continuous vertical and page-by-page translated reader with fullscreen reading, bubble-fitted lettering and a live text-block editor.",
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

/** Pages within this distance of the reading position composite their overlay. */
const WINDOW = 3;
const HIDE_CONTROLS_MS = 2600;

function Reader() {
  const navigate = useNavigate();
  const snap = useSession();
  const [index, setIndex] = useState(0);
  const [modePref, setModePref] = useState<ReaderModePreference>("auto");
  const [showTranslation, setShowTranslation] = useState(true);
  const [opacity, setOpacity] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const restoreTo = useRef<number | null>(null);
  const direction = useRef<1 | -1>(1);
  const lastScroll = useRef(0);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!session.hasSession()) void navigate({ to: "/" });
    setModePref(readModePreference());
  }, [navigate]);

  const mode = resolveMode(modePref, snap.pages);

  // Restore the previous reading position for this chapter.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !snap.pages.length) return;
    restored.current = true;
    void session.position().then((pos) => {
      if (!pos) return;
      const target = Math.min(Math.max(0, pos.pageIndex), snap.pages.length - 1);
      setIndex(target);
      restoreTo.current = target;
      if (pos.fullscreen) setFullscreen(true);
    });
  }, [snap.pages.length]);

  // Translation follows the reading position and the direction of travel.
  // Switching modes never re-runs OCR, translation or cleanup.
  useEffect(() => {
    if (snap.pages.length) session.ensure(index, direction.current);
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

  // Persist reading position (page, scroll, mode, fullscreen).
  useEffect(() => {
    if (!snap.pages.length) return;
    const t = setTimeout(
      () => session.savePosition(index, window.scrollY, mode, fullscreen),
      400,
    );
    return () => clearTimeout(t);
  }, [index, mode, fullscreen, snap.pages.length]);

  const scrollToPage = useCallback((target: number) => {
    const el = pageRefs.current[target];
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    else setIndex(target);
  }, []);

  // Keep the reading position when the mode changes.
  useEffect(() => {
    if (mode !== "vertical") return;
    const target = restoreTo.current ?? index;
    restoreTo.current = null;
    const el = pageRefs.current[target];
    if (el) el.scrollIntoView({ block: "start" });
  }, [mode]);

  // Scroll direction drives preload priority.
  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      if (Math.abs(y - lastScroll.current) > 24) {
        direction.current = y > lastScroll.current ? 1 : -1;
        lastScroll.current = y;
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
      if (mode !== "paged") return;
      if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, snap.pages.length - 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, snap.pages.length]);

  // Native fullscreen where available; the layout change is independent of it.
  useEffect(() => {
    const el = document.documentElement;
    if (fullscreen && !document.fullscreenElement) void el.requestFullscreen?.().catch(() => {});
    if (!fullscreen && document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    const onChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [fullscreen]);

  // Controls fade away while reading in fullscreen.
  const bumpChrome = useCallback(() => {
    setChromeVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setChromeVisible(false), HIDE_CONTROLS_MS);
  }, []);

  useEffect(() => {
    if (!fullscreen) {
      setChromeVisible(true);
      if (hideTimer.current) clearTimeout(hideTimer.current);
      return;
    }
    bumpChrome();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [fullscreen, bumpChrome]);

  // Current page detection: the most visible page wins, regardless of height.
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
        if (best && best.ratio > 0.12) setIndex(best.i);
      },
      { threshold: [0.12, 0.35, 0.7] },
    );
    for (const el of Object.values(pageRefs.current)) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [mode, snap.pages.length]);

  const blocksFor = useCallback(
    (pageIndex: number): TextBlock[] => {
      const regions = snap.states[pageIndex]?.translation?.regions ?? [];
      return buildBlocks(regions, snap.visions[pageIndex], snap.overrides, pageIndex);
    },
    [snap.states, snap.visions, snap.overrides],
  );

  const page = snap.pages[index];
  const state = snap.states[index];
  const selectedBlock = useMemo(() => {
    if (!selected) return null;
    for (let i = 0; i < snap.pages.length; i++) {
      const found = blocksFor(i).find((b) => b.id === selected);
      if (found) return found;
    }
    return null;
  }, [selected, snap.pages.length, blocksFor]);

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
      // Reuse the cleanup plates the reader already produced: exporting a
      // translated chapter never re-runs OCR, translation or cleanup.
      const entries = await Promise.all(
        snap.pages.map(async (p) => ({
          page: p,
          regions: snap.states[p.index]?.translation?.regions ?? [],
          visions: await session.cachedVisions(p.index),
        })),
      );
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

  const goPrev = () => {
    direction.current = -1;
    if (mode === "vertical") scrollToPage(Math.max(0, index - 1));
    else setIndex((i) => Math.max(0, i - 1));
  };
  const goNext = () => {
    direction.current = 1;
    if (mode === "vertical") scrollToPage(Math.min(snap.pages.length - 1, index + 1));
    else setIndex((i) => Math.min(snap.pages.length - 1, i + 1));
  };

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
      if (dx < 0) goNext();
      else goPrev();
    }
    touchStart.current = null;
  };

  const immersive = fullscreen;
  const chrome = !immersive || chromeVisible;

  return (
    <main
      className={immersive ? "min-h-screen bg-background" : "min-h-screen pb-32"}
      onPointerDown={immersive ? () => setChromeVisible((v) => !v) : undefined}
    >
      {!immersive && (
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
            <button
              type="button"
              onClick={() => setFullscreen(true)}
              className="inline-flex items-center gap-2 rounded-sm border border-border px-2 py-1 text-xs"
            >
              <Maximize2 className="size-3.5" />
              Fullscreen
            </button>
            <span className="ml-auto text-xs text-muted-foreground">
              {done}/{snap.pages.length} translated · {snap.stats.cacheHits} cached
              {snap.stats.avgMs ? ` · ${snap.stats.avgMs}ms avg` : ""}
            </span>
          </div>
        </header>
      )}

      <div className={immersive ? "w-full" : "mx-auto max-w-5xl px-4 py-6"}>
        {mode === "vertical" ? (
          // Continuous vertical reader: every page stays mounted, its height is
          // reserved from the source ratio, and only the overlay window changes.
          <div className="flex flex-col">
            {snap.pages.map((p) => (
              <div
                key={p.index}
                ref={(el) => {
                  pageRefs.current[p.index] = el;
                }}
                className="w-full"
              >
                <PageSlot
                  page={p}
                  regions={snap.states[p.index]?.translation?.regions ?? []}
                  visions={snap.visions[p.index]}
                  overrides={snap.overrides}
                  showTranslation={showTranslation}
                  opacity={opacity}
                  active={Math.abs(p.index - index) <= WINDOW}
                  priority={p.index === index}
                  continuous
                  selectedId={selected}
                  onBlockClick={immersive ? undefined : (b) => setSelected(b.id)}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="relative" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            <PageSlot
              page={page}
              regions={state?.translation?.regions ?? []}
              visions={snap.visions[index]}
              overrides={snap.overrides}
              showTranslation={showTranslation}
              opacity={opacity}
              active
              priority
              continuous={immersive}
              selectedId={selected}
              onBlockClick={immersive ? undefined : (b) => setSelected(b.id)}
            />
            <button
              type="button"
              aria-label="Previous page"
              onClick={goPrev}
              className="absolute inset-y-0 left-0 w-[12%] cursor-w-resize"
            />
            <button
              type="button"
              aria-label="Next page"
              onClick={goNext}
              className="absolute inset-y-0 right-0 w-[12%] cursor-e-resize"
            />
          </div>
        )}

        {!immersive && state?.status === "translating" && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-sm bg-card px-3 py-1.5 text-xs">
            <Loader2 className="size-3.5 animate-spin text-primary" />
            Translating page {index + 1}…
          </div>
        )}
        {!immersive && state?.status === "cleaning" && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-sm bg-card px-3 py-1.5 text-xs">
            <Loader2 className="size-3.5 animate-spin text-primary" />
            Cleaning page {index + 1}…
          </div>
        )}
        {!immersive && state?.status === "error" && (
          <div className="mt-3 inline-flex flex-wrap items-center gap-2 rounded-sm border border-destructive bg-card px-3 py-1.5 text-xs">
            <span className="text-destructive">Page {index + 1}: {state.error}</span>
            <button type="button" onClick={() => session.retry(index)} className="underline">
              Retry
            </button>
          </div>
        )}

        {!immersive && snap.glossary.length > 0 && (
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

      {selectedBlock && !immersive && (
        <BlockInspector
          block={selectedBlock}
          onClose={() => setSelected(null)}
          canUndo={snap.canUndo}
          canRedo={snap.canRedo}
        />
      )}

      {immersive ? (
        // Minimal fullscreen controls: back, indicator, settings, exit.
        <div
          className={
            "fixed inset-x-0 bottom-0 z-30 transition-opacity duration-300 " +
            (chrome ? "opacity-100" : "pointer-events-none opacity-0")
          }
          onPointerDown={(e) => e.stopPropagation()}
        >
          {showSettings && (
            <div className="mx-auto mb-2 flex max-w-md flex-wrap items-center gap-3 rounded-sm bg-background/95 px-4 py-3 text-xs backdrop-blur">
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
              <button
                type="button"
                onClick={() => setShowTranslation((v) => !v)}
                className="inline-flex items-center gap-1 rounded-sm border border-border px-2 py-1"
              >
                {showTranslation ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                {showTranslation ? "Translated" : "Original"}
              </button>
            </div>
          )}
          <div className="mx-auto flex max-w-md items-center gap-3 rounded-t-sm bg-background/90 px-4 py-3 backdrop-blur">
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="rounded-sm border border-border px-2 py-1 text-xs"
            >
              Back
            </button>
            <span className="font-display text-sm">
              {index + 1}
              <span className="text-muted-foreground">/{snap.pages.length}</span>
            </span>
            <button
              type="button"
              onClick={() => setShowSettings((v) => !v)}
              className="ml-auto rounded-sm border border-border p-2"
              aria-label="Reader settings"
            >
              <Settings2 className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="rounded-sm border border-border p-2"
              aria-label="Exit fullscreen"
            >
              <Minimize2 className="size-4" />
            </button>
          </div>
        </div>
      ) : (
        <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/95 backdrop-blur">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
            <button
              type="button"
              onClick={goPrev}
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
              onClick={goNext}
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
                onClick={() => session.translateChapter(index)}
                className="inline-flex items-center gap-2 rounded-sm border border-border px-3 py-2 text-sm"
              >
                Pre-translate
              </button>
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
      )}
    </main>
  );
}
