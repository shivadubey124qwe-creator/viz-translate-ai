import { zipSync } from "fflate";
import type { PageRegion } from "./translate.server";
import type { LoadedPage } from "./loaders";
import { buildBlocks, type BlockOverride, type TextBlock } from "./blocks";
import { analyzeRegions } from "./vision";
import { familyFor, fitText, makeMeasurer } from "./typography";

async function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not read a page image."));
    el.src = url;
  });
}

function drawBlock(
  ctx: CanvasRenderingContext2D,
  block: TextBlock,
  width: number,
  height: number,
) {
  const typo = block.typography;
  const boxW = block.interior.w * width;
  const boxH = block.interior.h * height;
  const text = block.target.trim();
  if (!text) return;

  const fit = fitText({
    text,
    boxW,
    boxH,
    typo,
    measure: makeMeasurer(typo),
    maxFont: Math.max(8, width * typo.maxFontRatio),
  });

  const cx = (block.interior.x + block.interior.w / 2) * width;
  const cy = (block.interior.y + block.interior.h / 2) * height;
  const lineHeight = fit.fontSize * fit.lineHeight;

  ctx.save();
  ctx.globalAlpha = typo.opacity;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `${typo.italic ? "italic " : ""}${typo.weight} ${fit.fontSize}px ${familyFor(typo.fontId)}`;
  if (block.rotation) {
    ctx.translate(cx, cy);
    ctx.rotate((block.rotation * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }
  const startY = cy - ((fit.lines.length - 1) * lineHeight) / 2;
  fit.lines.forEach((line, i) => {
    const y = startY + i * lineHeight;
    if (typo.strokeWidth > 0) {
      ctx.lineWidth = fit.fontSize * typo.strokeWidth * 2;
      ctx.lineJoin = "round";
      ctx.strokeStyle = typo.strokeColor;
      ctx.strokeText(line, cx, y);
    }
    ctx.fillStyle = typo.color;
    ctx.fillText(line, cx, y);
  });
  ctx.restore();
}

export async function renderPage(
  page: LoadedPage,
  regions: PageRegion[],
  overrides: Record<string, BlockOverride> = {},
  /** Cleanup plates already produced by the reader; skips re-analysis. */
  cachedVisions?: Record<string, BlockVision> | undefined,
): Promise<Blob> {
  const img = await loadImage(page.url);
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is unavailable in this browser.");
  ctx.drawImage(img, 0, 0);

  const complete =
    cachedVisions && regions.length > 0 && regions.every((r) => cachedVisions[r.id]);
  const visions = complete
    ? cachedVisions
    : await analyzeRegions(
        page.url,
        regions.map((r) => ({
          id: r.id,
          box: r.box,
          sfx: (overrides[r.id]?.kind ?? r.kind) === "sfx",
        })),
        { maxEdge: Math.min(2000, Math.max(canvas.width, canvas.height)) },
      );
  const blocks = buildBlocks(regions, visions, overrides, page.index);

  // Cleaned plates first, then the lettering on top.
  for (const block of blocks) {
    if (!block.cleaned) continue;
    const plate = await loadImage(block.cleaned.dataUrl);
    ctx.drawImage(
      plate,
      block.cleaned.box.x * canvas.width,
      block.cleaned.box.y * canvas.height,
      block.cleaned.box.w * canvas.width,
      block.cleaned.box.h * canvas.height,
    );
  }
  for (const block of blocks) drawBlock(ctx, block, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.92));
  if (!blob) throw new Error("Could not render that page.");
  return blob;
}

export async function exportCbz(
  title: string,
  pages: {
    page: LoadedPage;
    regions: PageRegion[];
    visions?: Record<string, BlockVision> | undefined;
  }[],
  onProgress?: (done: number, total: number) => void,
  overrides: Record<string, BlockOverride> = {},
) {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < pages.length; i++) {
    const entry = pages[i];
    if (!entry) continue;
    const blob = await renderPage(entry.page, entry.regions, overrides, entry.visions);
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
