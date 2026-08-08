import type { TextBlock } from "@/lib/blocks";
import type { LoadedPage } from "@/lib/loaders";
import { BlockLayer, useElementSize } from "./BlockLayer";

interface Props {
  page: LoadedPage;
  blocks: TextBlock[];
  showTranslation: boolean;
  opacity: number;
  onBlockClick?: (block: TextBlock) => void;
  selectedId?: string | null;
  /** Vertical mode renders pages edge to edge with no max width. */
  continuous?: boolean;
  priority?: boolean;
}

export function PageView({
  page,
  blocks,
  showTranslation,
  opacity,
  onBlockClick,
  selectedId,
  continuous,
  priority,
}: Props) {
  const { ref, size } = useElementSize<HTMLDivElement>();

  return (
    <div
      ref={ref}
      className={continuous ? "relative w-full select-none" : "relative mx-auto w-full max-w-3xl select-none"}
      style={
        page.width && page.height
          ? { aspectRatio: `${page.width} / ${page.height}` }
          : undefined
      }
    >
      <img
        src={page.url}
        alt={`Page ${page.index + 1}`}
        className="block w-full"
        draggable={false}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
      />
      {showTranslation && size.width > 0 && (
        <BlockLayer
          blocks={blocks}
          pageWidth={size.width}
          pageHeight={size.height || (size.width * (page.height || 1)) / (page.width || 1)}
          opacity={opacity}
          onSelect={onBlockClick}
          selectedId={selectedId ?? null}
        />
      )}
    </div>
  );
}
