import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PageRegion } from "@/lib/translate.server";
import type { LoadedPage } from "@/lib/loaders";
import { cn } from "@/lib/utils";
import { renderBox } from "@/lib/regions";

interface Props {
  page: LoadedPage;
  regions: PageRegion[];
  showTranslation: boolean;
  opacity: number;
  onRegionClick?: (region: PageRegion) => void;
}

/** Samples the border pixels of every region so the patch blends into the art. */
function useRegionFills(url: string, regions: PageRegion[]) {
  const [fills, setFills] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    if (!regions.length) {
      setFills({});
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const next: Record<string, string> = {};
      for (const region of regions) {
        const box = renderBox(region);
        const x = Math.round(box.x * canvas.width);
        const y = Math.round(box.y * canvas.height);
        const w = Math.max(2, Math.round(box.w * canvas.width));
        const h = Math.max(2, Math.round(box.h * canvas.height));
        const samples: number[][] = [];
        const pad = 3;
        const points = [
          [x + w / 2, y - pad],
          [x + w / 2, y + h + pad],
          [x - pad, y + h / 2],
          [x + w + pad, y + h / 2],
          [x + pad, y + pad],
          [x + w - pad, y + h - pad],
        ];
        for (const [px, py] of points) {
          const cx = Math.min(canvas.width - 1, Math.max(0, Math.round(px ?? 0)));
          const cy = Math.min(canvas.height - 1, Math.max(0, Math.round(py ?? 0)));
          const d = ctx.getImageData(cx, cy, 1, 1).data;
          samples.push([d[0] ?? 0, d[1] ?? 0, d[2] ?? 0]);
        }
        const median = (i: number) => {
          const vals = samples.map((s) => s[i] ?? 0).sort((a, b) => a - b);
          return vals[Math.floor(vals.length / 2)] ?? 255;
        };
        next[region.id] = `rgb(${median(0)}, ${median(1)}, ${median(2)})`;
      }
      if (!cancelled) setFills(next);
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [url, regions]);

  return fills;
}

function FittedText({
  text,
  vertical,
  sfx,
  onDark,
}: {
  text: string;
  vertical: boolean;
  sfx: boolean;
  onDark: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(16);

  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    let lo = 7;
    let hi = Math.max(10, Math.min(parent.clientHeight, parent.clientWidth * (sfx ? 1.6 : 1)));
    let best = lo;
    for (let i = 0; i < 14 && hi - lo > 0.4; i++) {
      const mid = (lo + hi) / 2;
      el.style.fontSize = `${mid}px`;
      const fits = el.scrollHeight <= parent.clientHeight + 1 && el.scrollWidth <= parent.clientWidth + 1;
      if (fits) {
        best = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    el.style.fontSize = `${best}px`;
    setSize(best);
  }, [text, vertical, sfx]);

  return (
    <div
      ref={ref}
      style={{
        fontSize: size,
        writingMode: vertical && !sfx ? "vertical-rl" : "horizontal-tb",
        WebkitTextStroke: sfx ? `0.07em ${onDark ? "#111" : "#fff"}` : undefined,
        paintOrder: "stroke fill",
        color: sfx ? (onDark ? "#f7f4ee" : "#141210") : undefined,
      }}
      className={cn(
        "flex h-full w-full items-center justify-center text-center break-words hyphens-auto",
        sfx ? "sfx-text drop-shadow-[0_2px_0_rgba(0,0,0,0.35)]" : "font-bubble leading-[1.06] text-ink",
      )}
    >
      {text}
    </div>
  );
}

export function PageView({ page, regions, showTranslation, opacity, onRegionClick }: Props) {
  const fills = useRegionFills(page.url, regions);

  return (
    <div className="relative mx-auto w-full max-w-3xl select-none">
      <img
        src={page.url}
        alt={`Page ${page.index + 1}`}
        className="block w-full"
        draggable={false}
      />
      {showTranslation && (
        <div className="absolute inset-0" style={{ opacity }}>
          {regions.map((region) => {
            const sfx = region.kind === "sfx";
            const box = renderBox(region);
            return (
              <button
                key={region.id}
                type="button"
                onClick={() => onRegionClick?.(region)}
                aria-label={`${region.kind}: ${region.target}`}
                style={{
                  left: `${box.x * 100}%`,
                  top: `${box.y * 100}%`,
                  width: `${box.w * 100}%`,
                  height: `${box.h * 100}%`,
                  transform: region.rotation ? `rotate(${region.rotation}deg)` : undefined,
                  background: sfx ? "transparent" : fills[region.id] ?? "rgb(250,249,245)",
                  padding: sfx ? 0 : "2%",
                }}
                className={cn(
                  "absolute overflow-hidden text-left",
                  sfx ? "" : "rounded-[6px]",
                )}
              >
                <FittedText
                  text={region.target || region.source}
                  vertical={region.vertical}
                  sfx={sfx}
                  onDark={region.onDark}
                />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
