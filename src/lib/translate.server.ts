export type RegionKind =
  | "speech"
  | "thought"
  | "narration"
  | "sign"
  | "caption"
  | "sfx";

export interface PageRegion {
  id: string;
  kind: RegionKind;
  box: { x: number; y: number; w: number; h: number };
  source: string;
  target: string;
  vertical: boolean;
  rotation: number;
  emotion?: string | undefined;
  intensity?: number | undefined;

  onDark: boolean;
}

export interface GlossaryEntry {
  source: string;
  target: string;
  kind: string;
}

export interface PageTranslation {
  pageIndex: number;
  sourceLanguage: string;
  regions: PageRegion[];
  glossary: GlossaryEntry[];
  summary: string;
  engine: string;
  /** Non-secret identifier of the provider/key that served this page. */
  provider: string;
  latencyMs: number;
}


const SYSTEM = `You are the MangaLens AI page pipeline: OCR, bubble/SFX detection, context analysis and localisation in one pass.

Rules:
- Read panels in the correct order for the detected language (right-to-left for Japanese/Chinese manga, left-to-right for Korean webtoons and western comics).
- Detect EVERY text region: speech bubbles, thought bubbles, narration boxes, signs, captions and sound effects.
- Never translate a bubble in isolation: use the whole page, the provided story summary and the glossary for pronouns, register and running gags.
- Sound effects (kind "sfx") are NEVER transliterated. Give the idiomatic comic equivalent for the depicted action, plus emotion and intensity 1-5. Example: ドン -> THUD or BOOM depending on the art.
- Honour every glossary entry exactly for names, places, skills, honorifics and repeated phrases.
- Localise naturally, as an official release would: contractions, natural punctuation, no literal word order.
- Boxes are normalised 0..1 relative to the full image and must tightly contain the original text, not the whole panel.
- onDark = true when the original text sits on a dark background.
- Propose new glossary entries for any proper noun, skill, organisation or recurring phrase you translated.
- Return ONLY JSON matching the schema.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sourceLanguage", "regions", "glossary", "summary"],
  properties: {
    sourceLanguage: { type: "string" },
    summary: { type: "string" },
    regions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "box", "source", "target", "vertical", "rotation", "onDark"],
        properties: {
          kind: {
            type: "string",
            enum: ["speech", "thought", "narration", "sign", "caption", "sfx"],
          },
          box: {
            type: "object",
            additionalProperties: false,
            required: ["x", "y", "w", "h"],
            properties: {
              x: { type: "number" },
              y: { type: "number" },
              w: { type: "number" },
              h: { type: "number" },
            },
          },
          source: { type: "string" },
          target: { type: "string" },
          vertical: { type: "boolean" },
          rotation: { type: "number" },
          emotion: { type: "string" },
          intensity: { type: "number" },
          onDark: { type: "boolean" },
        },
      },
    },
    glossary: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source", "target", "kind"],
        properties: {
          source: { type: "string" },
          target: { type: "string" },
          kind: { type: "string" },
        },
      },
    },
  },
} as const;

export async function runPageTranslation(input: {
  imageDataUrl: string;
  pageIndex: number;
  seriesTitle: string;
  targetLanguage: string;
  glossary: GlossaryEntry[];
  contextSummary: string;
}): Promise<PageTranslation> {
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("AI is not configured for this project.");

  const started = Date.now();
  const glossaryText = input.glossary.length
    ? input.glossary
        .slice(0, 200)
        .map((g) => `- ${g.source} => ${g.target} (${g.kind})`)
        .join("\n")
    : "(empty)";

  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `Series: ${input.seriesTitle || "unknown"}`,
                `Page index: ${input.pageIndex}`,
                `Target language: ${input.targetLanguage}`,
                `Story so far: ${input.contextSummary || "(start of chapter)"}`,
                `Translation memory / glossary:\n${glossaryText}`,
                `Translate this page and return the JSON. Also return a 2-3 sentence updated story summary that continues the "story so far".`,
              ].join("\n\n"),
            },
            { type: "image_url", image_url: { url: input.imageDataUrl } },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "page_translation", strict: true, schema: SCHEMA },
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    if (res.status === 429) throw new Error("Rate limited by the AI gateway. Try again shortly.");
    if (res.status === 402)
      throw new Error("AI credits exhausted. Add credits to keep translating.");
    throw new Error(`Translation failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const raw = json.choices?.[0]?.message?.content ?? "";
  let parsed: {
    sourceLanguage?: string;
    summary?: string;
    regions?: Omit<PageRegion, "id">[];
    glossary?: GlossaryEntry[];
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end < 0) throw new Error("The AI returned an unreadable page result.");
    parsed = JSON.parse(raw.slice(start, end + 1));
  }

  const regions: PageRegion[] = (parsed.regions ?? [])
    .filter((r) => r && r.box && (r.target?.trim() || r.source?.trim()))
    .map((r, i) => ({
      id: `p${input.pageIndex}-r${i}`,
      kind: (r.kind ?? "speech") as RegionKind,
      box: {
        x: clamp01(r.box.x),
        y: clamp01(r.box.y),
        w: clamp01(r.box.w),
        h: clamp01(r.box.h),
      },
      source: r.source ?? "",
      target: (r.target ?? "").trim(),
      vertical: Boolean(r.vertical),
      rotation: Number.isFinite(r.rotation) ? r.rotation : 0,
      emotion: r.emotion,
      intensity: r.intensity,
      onDark: Boolean(r.onDark),
    }));

  return {
    pageIndex: input.pageIndex,
    sourceLanguage: parsed.sourceLanguage ?? "unknown",
    regions,
    glossary: (parsed.glossary ?? []).filter((g) => g?.source && g?.target),
    summary: parsed.summary ?? input.contextSummary,
    engine: MODEL,
    latencyMs: Date.now() - started,
  };
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
