import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
import { session, useSession } from "@/lib/session";
import { exportCbz } from "@/lib/export";
import type { PageRegion } from "@/lib/translate.server";

export const Route = createFileRoute("/reader")({
  head: () => ({
    meta: [
      { title: "Reader — MangaLens AI" },
      {
        name: "description",
        content:
          "Translated reader with predictive page translation, original/translated toggle and an opacity slider.",
      },
      { property: "og:title", content: "MangaLens AI Reader" },
      {
        property: "og:description",
        content: "Read translated manga pages rendered onto the original artwork.",
      },
    ],
  }),
  component: Reader,
});

function Reader() {
  const navigate = useNavigate();
  const snap = useSession();
  const [index, setIndex] = useState(0);
  const [showTranslation, setShowTranslation] = useState(true);
  const [opacity, setOpacity] = useState(1);
  const [inspect, setInspect] = useState<PageRegion | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);

  useEffect(() => {
    if (!session.hasSession()) void navigate({ to: "/" });
  }, [navigate]);

  useEffect(() => {
    if (snap.pages.length) session.ensure(index);
  }, [index, snap.pages.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setIndex((i) => Math.min(i + 1, snap.pages.length - 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(i - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snap.pages.length]);

  const page = snap.pages[index];
  const state = snap.states[index];
  const regions = state?.translation?.regions ?? [];
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

  async function handleExport() {
    setExporting("Rendering…");
    try {
      const entries = snap.pages.map((p) => ({
        page: p,
        regions: snap.states[p.index]?.translation?.regions ?? [],
      }));
      await exportCbz(snap.title, entries, (d, t) => setExporting(`Rendering ${d}/${t}…`));
    } catch (err) {
      setExporting(err instanceof Error ? err.message : "Export failed");
      setTimeout(() => setExporting(null), 2500);
      return;
    }
    setExporting(null);
  }

  return (
    <main className="min-h-screen pb-32">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
          <Link to="/" className="font-display tracking-[0.2em] text-primary">
            MANGALENS
          </Link>
          <span className="truncate text-sm text-muted-foreground">{snap.title}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {done}/{snap.pages.length} translated · {snap.stats.cacheHits} cached
            {snap.stats.avgMs ? ` · ${snap.stats.avgMs}ms avg` : ""}
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-4 py-6">
        <div className="relative">
          <PageView
            page={page}
            regions={regions}
            showTranslation={showTranslation}
            opacity={opacity}
            onRegionClick={setInspect}
          />

          {state?.status === "working" && (
            <div className="pointer-events-none absolute top-3 left-3 flex items-center gap-2 rounded-sm bg-background/90 px-3 py-1.5 text-xs">
              <Loader2 className="size-3.5 animate-spin text-primary" />
              Translating this page…
            </div>
          )}
          {state?.status === "error" && (
            <div className="absolute top-3 left-3 flex items-center gap-2 rounded-sm bg-destructive px-3 py-1.5 text-xs text-destructive-foreground">
              {state.error}
              <button type="button" onClick={() => session.retry(index)} className="underline">
                Retry
              </button>
            </div>
          )}
        </div>

        {inspect && (
          <aside className="mt-6 rounded-sm border border-border bg-card p-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-display tracking-widest text-primary">
                {inspect.kind.toUpperCase()}
                {inspect.emotion ? ` · ${inspect.emotion}` : ""}
                {inspect.intensity ? ` · intensity ${inspect.intensity}` : ""}
              </span>
              <button type="button" onClick={() => setInspect(null)} className="text-muted-foreground">
                close
              </button>
            </div>
            <p className="mt-3 text-muted-foreground">Original: {inspect.source || "—"}</p>
            <p className="mt-1">Translated: {inspect.target}</p>
          </aside>
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
