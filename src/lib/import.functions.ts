import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { importChapterFromUrl } from "./import/registry.server";
import { ChapterImportError } from "./import/types";

const UrlInput = z.object({ url: z.string().min(4).max(2048) });

export const importChapter = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => UrlInput.parse(input))
  .handler(async ({ data }) => {
    try {
      const chapter = await importChapterFromUrl(data.url);
      return { ok: true as const, chapter };
    } catch (err) {
      const reason = err instanceof ChapterImportError ? err.reason : "adapter-error";
      const message =
        err instanceof Error ? err.message : "That chapter could not be imported.";
      return { ok: false as const, reason, message };
    }
  });
