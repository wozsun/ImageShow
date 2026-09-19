import { serveStatic } from "@hono/node-server/serve-static";
import { Context as HonoContext, type Context, type MiddlewareHandler } from "hono";

const encodingOrder = ["br", "zstd", "gzip", "identity"] as const;
type Encoding = typeof encodingOrder[number];
type EncodingGroup = { encodings: Encoding[]; identity: boolean };

function preferredEncodingGroups(header: string | undefined): EncodingGroup[] {
  const weights = new Map<string, number>();
  for (const part of header?.split(",") ?? []) {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const token = name.trim();
    if (token !== "*" && !encodingOrder.some((encoding) => encoding === token)) continue;
    const weight = parameters.length === 0 ? 1
      : parameters.length === 1 && /^\s*q\s*=\s*(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.test(parameters[0]!)
        ? Number(parameters[0]!.split("=")[1]) : 0;
    // Conflicting repeated entries must not re-enable an explicitly excluded coding.
    weights.set(token, Math.min(weights.get(token) ?? 1, weight));
  }

  const wildcard = weights.get("*");
  const preferences = encodingOrder.map((encoding) => ({
    encoding,
    // Implicit identity is a fallback; an explicit weight participates in ranking.
    weight: weights.get(encoding) ?? (encoding === "identity"
      ? wildcard === 0 ? 0 : -1
      : wildcard ?? 0)
  })).filter(({ weight }) => weight !== 0)
    .sort((left, right) => right.weight - left.weight);

  const groups: EncodingGroup[] = [];
  let previousWeight: number | undefined;
  for (const { encoding, weight } of preferences) {
    if (weight !== previousWeight) {
      groups.push({ encodings: [], identity: false });
      previousWeight = weight;
    }
    const group = groups[groups.length - 1]!;
    if (encoding === "identity") {
      group.identity = true;
      // The original file always exists when a static representation exists.
      break;
    }
    group.encodings.push(encoding);
  }
  const last = groups[groups.length - 1];
  if (groups.length > 1 && last?.identity && last.encodings.length === 0) {
    groups.pop();
    groups[groups.length - 1]!.identity = true;
  }
  return groups.length ? groups : [{ encodings: [], identity: false }];
}

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
