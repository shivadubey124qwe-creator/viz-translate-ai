import { useEffect, useState } from "react";
import { Redo2, Undo2, X } from "lucide-react";
import type { TextBlock } from "@/lib/blocks";
import { BLOCK_KINDS, FONT_CHOICES, type BlockKind, type FontId } from "@/lib/typography";
import { session } from "@/lib/session";
import { BlockText, useElementSize } from "./BlockLayer";
import { cn } from "@/lib/utils";

type Tab = "original" | "cleaned" | "translation";

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="w-24 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-primary"
        aria-label={label}
      />
      <span className="w-12 shrink-0 text-right text-foreground">
        {format ? format(value) : value}
      </span>
    </label>
  );
}

/**
 * Interactive text-block editor. Editing text or typography re-renders only
 * this block — OCR and translation are never re-run.
 */
export function BlockInspector({
  block,
  onClose,
  canUndo,
  canRedo,
}: {
  block: TextBlock;
  onClose: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  const [tab, setTab] = useState<Tab>("translation");
  const [source, setSource] = useState(block.source);
  const [target, setTarget] = useState(block.target);
  const { ref, size } = useElementSize<HTMLDivElement>();
  const typo = block.typography;

  useEffect(() => {
    setSource(block.source);
    setTarget(block.target);
  }, [block.id, block.source, block.target]);

  const set = (patch: Parameters<typeof session.setOverride>[1]) =>
    session.setOverride(block.id, patch);

  const aspect = block.bubbleBounds.h / Math.max(0.0001, block.bubbleBounds.w);

  return (
    <aside className="fixed inset-x-0 bottom-0 z-40 max-h-[72vh] overflow-y-auto border-t border-border bg-card/98 backdrop-blur md:inset-y-0 md:right-0 md:left-auto md:w-[420px] md:max-h-none md:border-l">
      <header className="sticky top-0 flex items-center gap-2 border-b border-border bg-card px-4 py-3">
        <span className="font-display tracking-widest text-primary">TEXT BLOCK</span>
        <span className="text-xs text-muted-foreground">
          {block.hasBubble ? "bubble detected" : "no bubble contour"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => session.undo()}
            disabled={!canUndo}
            className="rounded-sm border border-border p-1.5 disabled:opacity-40"
            aria-label="Undo"
          >
            <Undo2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => session.redo()}
            disabled={!canRedo}
            className="rounded-sm border border-border p-1.5 disabled:opacity-40"
            aria-label="Redo"
          >
            <Redo2 className="size-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-border p-1.5"
            aria-label="Close inspector"
          >
            <X className="size-4" />
          </button>
        </div>
      </header>

      <div className="space-y-5 px-4 py-4">
        {/* ---- previews: all three are the same block ---- */}
        <div>
          <div className="flex gap-1 text-xs">
            {(["original", "cleaned", "translation"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={cn(
                  "rounded-sm border border-border px-2 py-1 capitalize",
                  tab === t && "bg-primary text-primary-foreground",
                )}
              >
                {t === "cleaned" ? "cleaned image" : t}
              </button>
            ))}
          </div>
          <div
            ref={ref}
            className="relative mt-2 w-full overflow-hidden rounded-sm border border-border bg-muted"
            style={{ aspectRatio: `${block.bubbleBounds.w} / ${block.bubbleBounds.h}` }}
          >
            {tab !== "translation" && (
              <img
                src={(tab === "cleaned" ? block.cleaned?.dataUrl : block.crop?.dataUrl) ?? ""}
                alt={tab === "cleaned" ? "Cleaned artwork" : "Original text"}
                className="absolute inset-0 h-full w-full object-fill"
              />
            )}
            {tab === "translation" && (
              <>
                {block.cleaned ? (
                  <img
                    src={block.cleaned.dataUrl}
                    alt=""
                    aria-hidden
                    className="absolute inset-0 h-full w-full object-fill"
                  />
                ) : (
                  <div className="absolute inset-0" style={{ background: block.fill }} />
                )}
                <div
                  className="absolute"
                  style={{
                    left: `${((block.interior.x - block.bubbleBounds.x) / block.bubbleBounds.w) * 100}%`,
                    top: `${((block.interior.y - block.bubbleBounds.y) / block.bubbleBounds.h) * 100}%`,
                    width: `${(block.interior.w / block.bubbleBounds.w) * 100}%`,
                    height: `${(block.interior.h / block.bubbleBounds.h) * 100}%`,
                  }}
                >
                  <BlockText
                    block={block}
                    pageWidth={size.width / Math.max(0.0001, block.bubbleBounds.w)}
                    pageHeight={(size.width * aspect) / Math.max(0.0001, block.bubbleBounds.h)}
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {/* ---- text editing ---- */}
        <div className="space-y-2">
          <label className="block text-xs tracking-widest text-muted-foreground">
            RAW / OCR TEXT
            <textarea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onBlur={() => source !== block.source && set({ source })}
              rows={2}
              className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </label>
          <label className="block text-xs tracking-widest text-muted-foreground">
            TRANSLATED TEXT
            <textarea
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                set({ target: e.target.value });
              }}
              rows={2}
              className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-sm text-foreground"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              session.saveToMemory({
                source: source.trim(),
                target: target.trim(),
                kind: block.kind,
              })
            }
            className="w-full rounded-sm border border-primary px-3 py-2 text-xs tracking-widest text-primary"
          >
            SAVE TO TRANSLATION MEMORY
          </button>
        </div>

        {/* ---- type ---- */}
        <label className="block text-xs tracking-widest text-muted-foreground">
          TEXT TYPE
          <select
            value={block.kind}
            onChange={(e) => set({ kind: e.target.value as BlockKind })}
            className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            {BLOCK_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>

        {/* ---- typography ---- */}
        <div className="space-y-2">
          <h3 className="text-xs tracking-widest text-muted-foreground">TYPOGRAPHY</h3>
          <select
            value={typo.fontId}
            onChange={(e) => set({ typography: { fontId: e.target.value as FontId } })}
            className="w-full rounded-sm border border-border bg-background px-2 py-1.5 text-sm text-foreground"
          >
            {FONT_CHOICES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <div className="flex gap-2 text-xs">
            <button
              type="button"
              onClick={() => set({ typography: { weight: typo.weight >= 700 ? 500 : 800 } })}
              className={cn(
                "rounded-sm border border-border px-2 py-1 font-bold",
                typo.weight >= 700 && "bg-primary text-primary-foreground",
              )}
            >
              Bold
            </button>
            <button
              type="button"
              onClick={() => set({ typography: { italic: !typo.italic } })}
              className={cn(
                "rounded-sm border border-border px-2 py-1 italic",
                typo.italic && "bg-primary text-primary-foreground",
              )}
            >
              Italic
            </button>
            <button
              type="button"
              onClick={() => set({ typography: { uppercase: !typo.uppercase } })}
              className={cn(
                "rounded-sm border border-border px-2 py-1",
                typo.uppercase && "bg-primary text-primary-foreground",
              )}
            >
              AA
            </button>
            {(["left", "center", "right"] as const).map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => set({ typography: { align: a } })}
                className={cn(
                  "rounded-sm border border-border px-2 py-1",
                  typo.align === a && "bg-primary text-primary-foreground",
                )}
              >
                {a[0]?.toUpperCase()}
              </button>
            ))}
          </div>
          <Slider
            label="Max size"
            value={typo.maxFontRatio}
            min={0.02}
            max={0.3}
            step={0.005}
            onChange={(v) => set({ typography: { maxFontRatio: v } })}
            format={(v) => `${(v * 100).toFixed(1)}%`}
          />
          <Slider
            label="Letter space"
            value={typo.letterSpacing}
            min={-0.06}
            max={0.15}
            step={0.005}
            onChange={(v) => set({ typography: { letterSpacing: v } })}
            format={(v) => v.toFixed(3)}
          />
          <Slider
            label="Line space"
            value={typo.lineHeight}
            min={0.8}
            max={1.8}
            step={0.02}
            onChange={(v) => set({ typography: { lineHeight: v } })}
            format={(v) => v.toFixed(2)}
          />
          <Slider
            label="Stroke"
            value={typo.strokeWidth}
            min={0}
            max={0.2}
            step={0.005}
            onChange={(v) => set({ typography: { strokeWidth: v } })}
            format={(v) => v.toFixed(3)}
          />
          <Slider
            label="Shadow"
            value={typo.shadow}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => set({ typography: { shadow: v } })}
            format={(v) => v.toFixed(2)}
          />
          <Slider
            label="Opacity"
            value={typo.opacity}
            min={0.2}
            max={1}
            step={0.05}
            onChange={(v) => set({ typography: { opacity: v } })}
            format={(v) => v.toFixed(2)}
          />
        </div>

        {/* ---- position ---- */}
        <div className="space-y-2">
          <h3 className="text-xs tracking-widest text-muted-foreground">POSITION</h3>
          <Slider
            label="X"
            value={block.position.dx}
            min={-0.2}
            max={0.2}
            step={0.002}
            onChange={(v) => set({ position: { dx: v } })}
            format={(v) => v.toFixed(3)}
          />
          <Slider
            label="Y"
            value={block.position.dy}
            min={-0.2}
            max={0.2}
            step={0.002}
            onChange={(v) => set({ position: { dy: v } })}
            format={(v) => v.toFixed(3)}
          />
          <Slider
            label="Width"
            value={block.position.dw}
            min={-0.6}
            max={1}
            step={0.02}
            onChange={(v) => set({ position: { dw: v } })}
            format={(v) => v.toFixed(2)}
          />
          <Slider
            label="Height"
            value={block.position.dh}
            min={-0.6}
            max={1}
            step={0.02}
            onChange={(v) => set({ position: { dh: v } })}
            format={(v) => v.toFixed(2)}
          />
          <Slider
            label="Rotation"
            value={block.position.rotation}
            min={-45}
            max={45}
            step={1}
            onChange={(v) => set({ position: { rotation: v } })}
          />
          <Slider
            label="Scale"
            value={block.position.scale}
            min={0.5}
            max={2}
            step={0.02}
            onChange={(v) => set({ position: { scale: v } })}
            format={(v) => v.toFixed(2)}
          />
        </div>

        <div className="flex flex-wrap gap-2 text-xs">
          <button
            type="button"
            onClick={() => session.autoFit(block.id)}
            className="rounded-sm bg-primary px-3 py-2 tracking-widest text-primary-foreground"
          >
            AUTO FIT
          </button>
          <button
            type="button"
            onClick={() => session.resetPosition(block.id)}
            className="rounded-sm border border-border px-3 py-2 tracking-widest"
          >
            RESET POSITION
          </button>
          <button
            type="button"
            onClick={() => session.resetTypography(block.id)}
            className="rounded-sm border border-border px-3 py-2 tracking-widest"
          >
            RESET TYPOGRAPHY
          </button>
        </div>
      </div>
    </aside>
  );
}
