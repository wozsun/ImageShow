import { serveStatic } from "@hono/node-server/serve-static";
import { Context as HonoContext, type Context, type MiddlewareHandler } from "hono";

import { preferredEncodingGroups, type Encoding } from "./accept-encoding.ts";

/** Negotiates encodings without taking ownership of paths, MIME types or file streams. */
export function serveNegotiatedStatic(root: string): MiddlewareHandler {
  const handler = serveStatic({ root, precompressed: true });

  async function invoke(c: Context, encodings: Encoding[], metadataOnly = false) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept-Encoding", encodings.join(", "));
    if (metadataOnly) headers.delete("Range");
    const request = new Request(c.req.raw, {
      headers,
      ...(metadataOnly ? { method: "HEAD" } : {})
    });
    const context = new HonoContext(request, { env: c.env, path: c.req.path });
    return await handler(context, async () => undefined);
  }

  return async (c, next) => {
    if (c.finalized) return next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return handler(c, next);
    const groups = preferredEncodingGroups(c.req.header("Accept-Encoding"));
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]!;
      if (index < groups.length - 1) {
        // Only distinct preference tiers need metadata probes. The ordinary
        // br/zstd/gzip request reaches the file sender once, with no probe.
        const probe = await invoke(c, group.encodings, true);
        if (!probe) return next();
        if (!probe.headers.has("Content-Encoding")) continue;
      }
      const response = await invoke(c, group.encodings);
      if (!response) return next();
      if (group.identity || response.headers.has("Content-Encoding")) return response;
      await response.body?.cancel().catch(() => undefined);
      return new Response(null, {
        status: 406,
        headers: { "Vary": "Accept-Encoding", "Cache-Control": "no-store" }
      });
    }
    return next();
  };
}
