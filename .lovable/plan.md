# Fix translated-text rendering to match the reference

Comparing your three images: the translation content is close, but the *typesetting* is wrong. In image 2 the text is oversized, spills outside the page, gets clipped mid-word ("othstaylor"), the narration line is truncated ("that how"), and the white patches are big rectangles that cover artwork instead of just the original lettering.

## What's causing it

- `src/lib/regions.ts` inflates every detected box by 1.5x width / 1.7x height, with floors of 16% page width and 7% page height. On a tall webtoon page that floor is enormous, so patches and text blocks balloon past the bubble and past the canvas edge.
- `src/components/PageView.tsx` starts its font-size search at the full box height, so a short line like "Ed..." is rendered at box height, not at a page-appropriate reading size. There is no cap tied to page width, and no minimum-legibility floor that forces wrapping instead of clipping.
- The patch is a full opaque rectangle in the region's inflated box, so it paints over art rather than over just the original glyphs.
- Narration truncation ("...that won't give in no matter how strong the opponent..." -> "that how") comes from the model output being cut, not from layout — the prompt does not require complete sentences or discourage dropping words.

## The fix

1. **Rewrite the box geometry** (`src/lib/regions.ts`)
   - Small, symmetric padding only (roughly 6-10%), no 1.5x/1.7x inflation.
   - Replace the fixed fractional floors with aspect-aware floors derived from the page's own dimensions, so tall webtoon strips don't get page-wide minimums.
   - Clamp the final box inside 0..1 on both axes so nothing can overflow the canvas.

2. **Rewrite text fitting** (`src/components/PageView.tsx`)
   - Cap font size as a fraction of *page width* (webtoon dialogue sits around 2.5-3.5% of page width), not box height.
   - Wrap first, shrink second: prefer more lines over smaller type, matching the reference's 2-3 line narration and dialogue.
   - Keep a hard legibility floor and allow the box to grow downward slightly rather than clipping text.
   - Centre both axes, tighter line-height, uppercase-friendly tracking for narration bands.

3. **Patch only the lettering**
   - Shrink the fill to the detected glyph box plus a hair of bleed, and feather the edge so it reads as clean bubble interior rather than a pasted rectangle.
   - For narration bands on flat white, fill with the sampled band colour full-width but only the band's own height.
   - SFX stays transparent with stroke + fill, sized from the original SFX box so it can't cover a face.

4. **Prompt hardening** (`src/lib/translate.server.ts`)
   - Require complete, non-truncated sentences; forbid dropping trailing clauses.
   - Ask for `maxLines` guidance per region (narration bands vs bubbles) so layout knows the intended shape.
   - Tighten box instructions: box must contain only the glyphs of that one text run.

5. **Keep export in parity** (`src/lib/export.ts`)
   - The canvas renderer must use the same padding, width-relative font cap, wrap-then-shrink order, and patch geometry so the exported CBZ matches the reader.

6. **Verify against your page**
   - Run your first (Korean) image through the pipeline in the browser and compare the rendered result to image 3, iterating on the caps until dialogue, narration, and SFX all sit inside their shapes with no clipping.

## Technical notes

`renderBox()` becomes the single source of truth for geometry and takes the page aspect ratio as an input; both `PageView` and `export.ts` call it. Font sizing moves to a shared helper so the DOM fitter and the canvas fitter derive identical sizes from page width. No backend/schema changes beyond the added optional `maxLines` field and prompt text.
