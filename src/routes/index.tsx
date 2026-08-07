import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { BookOpen, FileArchive, FolderOpen, Languages, Link2, Loader2, Zap } from "lucide-react";
import { loadFiles, pagesFromChapter } from "@/lib/loaders";
import { importChapter } from "@/lib/import.functions";
import { SUPPORTED_SITES } from "@/lib/import/client";
import { session } from "@/lib/session";


export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MangaLens AI — Manga, Manhwa & Webtoon Translator" },
      {
        name: "description",
        content:
          "Open a CBZ, ZIP, PDF or image folder and read manga, manhwa and webtoons translated onto the artwork, page ahead of you.",
      },
      { property: "og:title", content: "MangaLens AI" },
      {
        property: "og:description",
        content: "Read manga in your language, rendered like an official localization.",
      },
    ],
  }),
  component: Home,
});

const LANGUAGES = ["English", "Spanish", "Portuguese", "French", "German", "Indonesian"];

function Home() {
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState("English");
  const [chapterUrl, setChapterUrl] = useState("");

  function start(title: string, pages: Awaited<ReturnType<typeof pagesFromChapter>>) {
    session.load(title, pages, language);
    session.ensure(0);
    session.translateChapter(0);
    void navigate({ to: "/reader" });
  }

  async function handle(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setBusy("Unpacking pages…");
    try {
      const { title, pages } = await loadFiles(Array.from(files));
      start(title, pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that.");
    } finally {
      setBusy(null);
    }
  }

  async function handleUrl(event: React.FormEvent) {
    event.preventDefault();
    if (!chapterUrl.trim() || busy) return;
    setError(null);
    setBusy("Importing chapter…");
    try {
      const result = await importChapter({ data: { url: chapterUrl } });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      const pages = await pagesFromChapter(result.chapter);
      start(result.chapter.title, pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That chapter could not be imported.");
    } finally {
      setBusy(null);
    }
  }


  return (
    <main className="min-h-screen">
      <section className="relative overflow-hidden border-b border-border">
        <div className="halftone pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative mx-auto max-w-5xl px-6 pt-20 pb-16">
          <p className="font-display text-sm tracking-[0.3em] text-primary">MangaLens AI</p>
          <h1 className="mt-4 max-w-3xl text-5xl leading-[0.92] sm:text-7xl">
            Read it in your language,
            <span className="text-primary"> drawn back into the art</span>
          </h1>
          <p className="mt-6 max-w-xl text-lg text-muted-foreground">
            OCR, bubble and SFX detection, series-aware translation memory, text removal and
            typography reconstruction — running three pages ahead of you.
          </p>

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={Boolean(busy)}
              className="inline-flex items-center gap-2 rounded-sm bg-primary px-6 py-3 font-display text-lg tracking-wide text-primary-foreground transition hover:brightness-110 disabled:opacity-60"
            >
              {busy ? <Loader2 className="size-5 animate-spin" /> : <FileArchive className="size-5" />}
              {busy ?? "Open CBZ / ZIP / PDF"}
            </button>
            <button
              type="button"
              onClick={() => folderInput.current?.click()}
              disabled={Boolean(busy)}
              className="inline-flex items-center gap-2 rounded-sm border border-border px-6 py-3 font-display text-lg tracking-wide transition hover:bg-secondary disabled:opacity-60"
            >
              <FolderOpen className="size-5" />
              Image folder
            </button>
            <label className="inline-flex items-center gap-2 rounded-sm border border-border px-4 py-3 text-sm text-muted-foreground">
              <Languages className="size-4" />
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="bg-transparent text-foreground outline-none"
              >
                {LANGUAGES.map((l) => (
                  <option key={l} value={l} className="bg-card">
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <form onSubmit={handleUrl} className="mt-6 max-w-2xl">
            <label
              htmlFor="chapter-url"
              className="font-display text-sm tracking-[0.2em] text-muted-foreground"
            >
              PASTE CHAPTER URL
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <div className="flex flex-1 items-center gap-2 rounded-sm border border-border bg-card px-3">
                <Link2 className="size-4 shrink-0 text-muted-foreground" />
                <input
                  id="chapter-url"
                  type="url"
                  inputMode="url"
                  value={chapterUrl}
                  onChange={(e) => setChapterUrl(e.target.value)}
                  placeholder="https://mangadex.org/chapter/…"
                  className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
              <button
                type="submit"
                disabled={Boolean(busy) || !chapterUrl.trim()}
                className="inline-flex items-center justify-center gap-2 rounded-sm border border-primary px-6 py-3 font-display tracking-wide text-primary transition hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
              >
                {busy === "Importing chapter…" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Link2 className="size-4" />
                )}
                Import
              </button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Supported: {SUPPORTED_SITES.join(" · ")}. Pages load through this site so they can be
              translated.
            </p>
          </form>


          {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

          <input
            ref={fileInput}
            type="file"
            accept=".cbz,.zip,.pdf,image/*"
            multiple
            hidden
            onChange={(e) => void handle(e.target.files)}
          />
          <input
            ref={folderInput}
            type="file"
            hidden
            multiple
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            {...({ webkitdirectory: "", directory: "" } as any)}
            onChange={(e) => void handle(e.target.files)}
          />
        </div>
      </section>

      <section className="mx-auto grid max-w-5xl gap-px bg-border px-0 sm:grid-cols-3">
        {[
          {
            icon: Zap,
            title: "Never waits",
            body: "Pages N+1 to N+3 translate while you read, then the rest of the chapter in the background. Cached pages come back instantly.",
          },
          {
            icon: BookOpen,
            title: "Series memory",
            body: "Names, skills, places and honorifics are stored per series and forced into every later page, so nothing drifts.",
          },
          {
            icon: Languages,
            title: "SFX, not letters",
            body: "Sound effects are read separately and localized by meaning and intensity — ドン becomes THUD or BOOM, set in comic lettering.",
          },
        ].map(({ icon: Icon, title, body }) => (
          <article key={title} className="bg-background p-8">
            <Icon className="size-6 text-primary" />
            <h2 className="mt-4 text-xl">{title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
          </article>
        ))}
      </section>

      <footer className="mx-auto max-w-5xl px-6 py-12 text-sm text-muted-foreground">
        Pages stay on your device; only the page image is sent for translation. Translations and the
        series glossary are cached locally.
      </footer>
    </main>
  );
}
