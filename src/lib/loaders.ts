import { unzipSync } from "fflate";
import type { Chapter } from "./import/types";
import { proxiedImageUrl } from "./import/client";


export interface LoadedPage {
  index: number;
  name: string;
  url: string;
  width: number;
  height: number;
}

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

async function measure(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = url;
  });
}

function naturalSort(a: string, b: string) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

async function toPages(entries: { name: string; blob: Blob }[]): Promise<LoadedPage[]> {
  const sorted = [...entries].sort((a, b) => naturalSort(a.name, b.name));
  return Promise.all(
    sorted.map(async (entry, index) => {
      const url = URL.createObjectURL(entry.blob);
      const { width, height } = await measure(url);
      return { index, name: entry.name, url, width, height };
    }),
  );
}

async function fromArchive(file: File): Promise<LoadedPage[]> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const files = unzipSync(buf, {
    filter: (f) => IMAGE_RE.test(f.name) && !f.name.startsWith("__MACOSX"),
  });
  const entries = Object.entries(files).map(([name, bytes]) => ({
    name,
    blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeFor(name) }),
  }));
  if (!entries.length) throw new Error("No images found inside that archive.");
  return toPages(entries);
}

function mimeFor(name: string) {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "avif") return "image/avif";
  return "image/jpeg";
}

async function fromPdf(file: File): Promise<LoadedPage[]> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const entries: { name: string; blob: Blob }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable in this browser.");
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.92));
    if (blob) entries.push({ name: `page-${String(i).padStart(4, "0")}.jpg`, blob });
  }
  if (!entries.length) throw new Error("That PDF has no renderable pages.");
  return toPages(entries);
}

export async function loadFiles(files: File[]): Promise<{ title: string; pages: LoadedPage[] }> {
  const archives = files.filter((f) => /\.(cbz|zip)$/i.test(f.name));
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
  const images = files.filter((f) => IMAGE_RE.test(f.name) || f.type.startsWith("image/"));

  if (archives[0]) return { title: stripExt(archives[0].name), pages: await fromArchive(archives[0]) };
  if (pdfs[0]) return { title: stripExt(pdfs[0].name), pages: await fromPdf(pdfs[0]) };
  if (images.length) {
    const pages = await toPages(
      images.map((f) => ({ name: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, blob: f })),
    );
    return { title: folderTitle(images) ?? "Local images", pages };
  }
  throw new Error("Drop a CBZ, ZIP, PDF, or a folder of images.");
}

function folderTitle(files: File[]) {
  const path = (files[0] as File & { webkitRelativePath?: string })?.webkitRelativePath;
  return path?.includes("/") ? path.split("/")[0] : undefined;
}

function stripExt(name: string) {
  return name.replace(/\.[^.]+$/, "");
}

export async function fetchRemotePages(urls: string[]): Promise<LoadedPage[]> {
  return Promise.all(
    urls.map(async (url, index) => {
      const { width, height } = await measure(url);
      return { index, name: `remote-${index}`, url, width, height };
    }),
  );
}

export async function toDataUrl(url: string, maxEdge = 1400): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not read that page image."));
    el.src = url;
  });
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is unavailable in this browser.");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}
