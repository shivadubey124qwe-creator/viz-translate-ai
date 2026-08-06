import { zipSync } from "fflate";
import type { PageRegion } from "./translate.server";
import type { LoadedPage } from "./loaders";
import { renderBox } from "./regions";

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\n+/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function drawRegion(
  ctx: CanvasRenderingContext2D,
  region: PageRegion,
  width: number,
  height: number,
) {
  const box = renderBox(region);
  const x = box.x * width;
  const y = box.y * height;
  const w = Math.max(8, box.w * width);
  const h = Math.max(8, box.h * height);
  const sfx = region.kind === "sfx";
  const text = (region.target || region.source).trim();
  if (!text) return;

  if (!sfx) {
    const sample = ctx.getImageData(
      Math.min(width - 1, Math.max(0, Math.round(x + w / 2))),
      Math.min(height - 1, Math.max(0, Math.round(y - 3))),
      1,
      1,
    ).data;
    ctx.fillStyle = `rgb(${sample[0]}, ${sample[1]}, ${sample[2]})`;
    ctx.fillRect(x, y, w, h);
  }

  const padding = sfx ? 0 : Math.min(w, h) * 0.08;
  const innerW = w - padding * 2;
  const innerH = h - padding * 2;
  const family = sfx ? "Anton, Impact, sans-serif" : "'Comic Neue', Barlow, sans-serif";

  let fontSize = Math.floor(innerH);
  let lines: string[] = [];
  while (fontSize > 6) {
    ctx.font = `${sfx ? "" : "700 "}${fontSize}px ${family}`;
    lines = wrap(ctx, sfx ? text.toUpperCase() : text, innerW);
    const lineHeight = fontSize * (sfx ? 0.9 : 1.1);
    if (lines.length * lineHeight <= innerH) break;
    fontSize -= 1;
  }

  const lineHeight = fontSize * (sfx ? 0.9 : 1.1);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (region.rotation) {
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate((region.rotation * Math.PI) / 180);
    ctx.translate(-(x + w / 2), -(y + h / 2));
  }
  const startY = y + h / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => {
    const ly = startY + i * lineHeight;
    if (sfx) {
      ctx.lineWidth = fontSize * 0.14;
      ctx.strokeStyle = region.onDark ? "#111111" : "#ffffff";
      ctx.strokeText(line, x + w / 2, ly);
      ctx.fillStyle = region.onDark ? "#f7f4ee" : "#141210";
    } else {
      ctx.fillStyle = "#141210";
    }
    ctx.fillText(line, x + w / 2, ly);
  });
  ctx.restore();
}

export async function renderPage(page: LoadedPage, regions: PageRegion[]): Promise<Blob> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not read a page image."));
    el.src = page.url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is unavailable in this browser.");
  ctx.drawImage(img, 0, 0);
  for (const region of regions) drawRegion(ctx, region, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.92));
  if (!blob) throw new Error("Could not render that page.");
  return blob;
}

export async function exportCbz(
  title: string,
  pages: { page: LoadedPage; regions: PageRegion[] }[],
  onProgress?: (done: number, total: number) => void,
) {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < pages.length; i++) {
    const entry = pages[i];
    if (!entry) continue;
    const blob = await renderPage(entry.page, entry.regions);
    files[`${String(i + 1).padStart(4, "0")}.jpg`] = new Uint8Array(await blob.arrayBuffer());
    onProgress?.(i + 1, pages.length);
  }
  const zipped = zipSync(files, { level: 0 });
  const url = URL.createObjectURL(
    new Blob([zipped as Uint8Array<ArrayBuffer>], { type: "application/vnd.comicbook+zip" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title || "mangalens"}-translated.cbz`;
  a.click();
  URL.revokeObjectURL(url);
}
