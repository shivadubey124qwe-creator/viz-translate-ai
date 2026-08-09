import { memo, useMemo } from "react";
import type { PageRegion } from "@/lib/translate.server";
import type { BlockVision } from "@/lib/vision";
import { buildBlocks, type BlockOverride, type TextBlock } from "@/lib/blocks";
import type { LoadedPage } from "@/lib/loaders";
import { BlockLayer, useElementSize } from "./BlockLayer";

interface Props {
  page: LoadedPage;
  regions: PageRegion[];
  visions: Record<string, BlockVision> | undefined;
  overrides: Record<string, BlockOverride>;
  showTranslation: boolean;
  opacity: number;
  /** Overlay is composited only for pages inside the active window. */
  active: boolean;
  priority: boolean;
  continuous: boolean;
  selectedId: string | null;
  onBlockClick?: ((block: TextBlock) => void) | undefined;
}

/**
 * One page in the reader. The artwork element is never unmounted while the
 * chapter is open — the space it occupies is reserved from the source aspect
 * ratio, so scrolling back never re-lays-out or reprocesses a page.
 */
function PageSlotInner({
  page,
  regions,
  visions,
  overrides,
  showTranslation,
  opacity,
  active,
  priority,
  continuous,
  selectedId,
  onBlockClick,
}: Props) {
  const { ref, size } = useElementSize<HTMLDivElement>();
  const blocks = useMemo(
    () => buildBlocks(regions, visions, overrides, page.index),
    [regions, visions, overrides, page.index],
  );

  const ratio = page.width && page.height ? `${page.width} / ${page.height}` : undefined;

  return (
    <div
      ref={ref}
      data-page-index={page.index}
      className={
        continuous
          ? "relative w-full select-none"
          : "relative mx-auto w-full max-w-3xl select-none"
      }
      style={ratio ? { aspectRatio: ratio } : undefined}
    >
      <img
        src={page.url}
        alt={`Page ${page.index + 1}`}
        className="block h-full w-full"
        draggable={false}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        style={{ contentVisibility: "auto" }}
      />
      {showTranslation && active && blocks.length > 0 && size.width > 0 && (
        <BlockLayer
          blocks={blocks}
          pageWidth={size.width}
          pageHeight={size.height || (size.width * (page.height || 1)) / (page.width || 1)}
          opacity={opacity}
          onSelect={onBlockClick}
          selectedId={selectedId}
        />
      )}
    </div>
  );
}

export const PageSlot = memo(PageSlotInner);
