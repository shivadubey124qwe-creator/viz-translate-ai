import { createFileRoute } from "@tanstack/react-router";
import { providerHealth } from "@/lib/providers.server";
import { runPageTranslation } from "@/lib/translate.server";

export const Route = createFileRoute("/api/public/provider-selftest")({
  server: {
    handlers: {
      GET: async () => Response.json(providerHealth()),
      POST: async ({ request }) => {
        const { imageDataUrl } = (await request.json()) as { imageDataUrl: string };
        try {
          const out = await runPageTranslation({
            imageDataUrl,
            pageIndex: 0,
            seriesTitle: "selftest",
            targetLanguage: "English",
            glossary: [],
            contextSummary: "",
          });
          return Response.json({ ok: true, provider: out.provider, regions: out.regions });
        } catch (e) {
          return Response.json({ ok: false, error: (e as Error).message });
        }
      },
    },
  },
});
