import { createFileRoute } from "@tanstack/react-router";
import { isPrivateHost } from "@/lib/import/types";

const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Streams a remote chapter image through this origin so the reader can draw it
 * onto a canvas (OCR/export) even when the source CDN blocks cross-origin use.
 */
export const Route = createFileRoute("/api/public/image")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const params = new URL(request.url).searchParams;
        const target = params.get("url");
        if (!target) return new Response("Missing url", { status: 400 });

        let parsed: URL;
        try {
          parsed = new URL(target);
        } catch {
          return new Response("Invalid url", { status: 400 });
        }
        if (!/^https?:$/.test(parsed.protocol) || isPrivateHost(parsed.hostname)) {
          return new Response("Blocked url", { status: 403 });
        }

        const referer = params.get("referer");
        let upstream: Response;
        try {
          upstream = await fetch(parsed.toString(), {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
              Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
              Referer: referer && /^https?:\/\//.test(referer) ? referer : `${parsed.origin}/`,
            },
            redirect: "follow",
          });
        } catch {
          return new Response("Upstream unreachable", { status: 502 });
        }

        const type = upstream.headers.get("content-type") ?? "";
        if (!upstream.ok || !type.startsWith("image/")) {
          return new Response("Not an image", { status: 502 });
        }
        const length = Number(upstream.headers.get("content-length") ?? 0);
        if (length > MAX_BYTES) return new Response("Image too large", { status: 413 });

        return new Response(upstream.body, {
          headers: {
            "Content-Type": type,
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});
