import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TextBlock } from "@/lib/blocks";
import { fitText, familyFor, makeMeasurer } from "@/lib/typography";
import { cn } from "@/lib/utils";

/**
 * Renders one translated text block: the cleaned artwork plate (original
 * lettering reconstructed away) plus fitted typography inside the bubble's
 * safe interior. Used by the reader and the inspector preview alike.
 */
export function BlockText({
  block,
  pageWidth,
  pageHeight,
}: {
  block: TextBlock;
  pageWidth: number;
  pageHeight: number;
}) {
  const typo = block.typography;
  const boxW = block.interior.w * pageWidth;
  const boxH = block.interior.h * pageHeight;

  const fit = useMemo(() => {
    const measure = makeMeasurer(typo);
    return fitText({
      text: block.target,
      boxW,
      boxH,
      typo,
      measure,
      maxFont: Math.max(8, pageWidth * typo.maxFontRatio),
    });
  }, [block.target, boxW, boxH, typo, pageWidth]);

  const stroke = fit.fontSize * typo.strokeWidth;

  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-hidden"
      style={{ opacity: typo.opacity }}
    >
      <div
        style={{
          fontFamily: familyFor(typo.fontId),
          fontWeight: typo.weight,
          fontStyle: typo.italic ? "italic" : "normal",
          fontSize: `${fit.fontSize}px`,
          lineHeight: fit.lineHeight,
          letterSpacing: `${fit.letterSpacing}em`,
          textAlign: typo.align,
          color: typo.color,
          WebkitTextStroke: stroke > 0.2 ? `${stroke}px ${typo.strokeColor}` : undefined,
          paintOrder: "stroke fill",
          textShadow:
            typo.shadow > 0
              ? `0 ${(fit.fontSize * 0.06).toFixed(2)}px ${(fit.fontSize * 0.08).toFixed(2)}px rgba(0,0,0,${typo.shadow.toFixed(2)})`
              : undefined,
          whiteSpace: "pre",
        }}
        className={cn("select-none", typo.fontId === "sfx" && "sfx-text")}
      >
        {fit.lines.map((line, i) => (
          <div key={`${i}-${line}`}>{line}</div>
        ))}
      </div>
    </div>
  );
}

/** Overlay for a whole page: cleaned plates first, then lettering. */
export function BlockLayer({
  blocks,
  pageWidth,
  pageHeight,
  opacity,
  onSelect,
  selectedId,
}: {
  blocks: TextBlock[];
  pageWidth: number;
  pageHeight: number;
  opacity: number;
  onSelect?: ((block: TextBlock) => void) | undefined;
  selectedId?: string | null | undefined;
}) {
  return (
    <div className="absolute inset-0" style={{ opacity }}>
      {/*
        Reconstruction plates. Each plate is a transparent PNG whose only opaque
        pixels are the removed original glyphs, so artwork is never covered by a
        rectangle. There is deliberately no solid-colour fallback.
      */}
      {blocks.map((block) =>
        block.cleaned ? (
          <img
            key={`${block.id}-plate`}
            src={block.cleaned.dataUrl}
            alt=""
            aria-hidden
            className="pointer-events-none absolute"
            style={{
              left: `${block.cleaned.box.x * 100}%`,
              top: `${block.cleaned.box.y * 100}%`,
              width: `${block.cleaned.box.w * 100}%`,
              height: `${block.cleaned.box.h * 100}%`,
            }}
          />
        ) : null,
      )}


      {blocks.map((block) => (
        <button
          key={block.id}
          type="button"
          onClick={() => onSelect?.(block)}
          aria-label={`${block.kind}: ${block.target}`}
          style={{
            left: `${block.interior.x * 100}%`,
            top: `${block.interior.y * 100}%`,
            width: `${block.interior.w * 100}%`,
            height: `${block.interior.h * 100}%`,
            transform: block.rotation ? `rotate(${block.rotation}deg)` : undefined,
          }}
          className={cn(
            "absolute overflow-visible text-left",
            selectedId === block.id && "outline-2 outline-dashed outline-primary",
          )}
        >
          <BlockText block={block} pageWidth={pageWidth} pageHeight={pageHeight} />
        </button>
      ))}
    </div>
  );
}

/** Measures its own box so blocks can be fitted in real pixels. */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}
