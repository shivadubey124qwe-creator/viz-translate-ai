import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { runPageTranslation } from "./translate.server";

const PageInput = z.object({
  imageDataUrl: z.string().min(32),
  pageIndex: z.number().int().min(0),
  seriesTitle: z.string().default(""),
  targetLanguage: z.string().default("English"),
  glossary: z
    .array(z.object({ source: z.string(), target: z.string(), kind: z.string() }))
    .default([]),
  contextSummary: z.string().default(""),
});

export const translatePage = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => PageInput.parse(input))
  .handler(async ({ data }) => runPageTranslation(data));
