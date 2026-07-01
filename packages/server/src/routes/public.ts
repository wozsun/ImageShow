import type { Hono } from "hono";
import { blockCrossSiteFetch, ok } from "../core/http.js";
import { listQuery, parse } from "../core/validation.js";
import { siteConfigPayload } from "../config/settings.js";
import { getPublicGalleryFacets, listPublicImages } from "../images/query.js";
import { serveLinkMedia, serveLinkThumb, serveObject, serveThumb } from "../images/serving.js";
import { specialHost } from "../themes/host.js";

// Thin HTTP layer for the public read API. The gallery list (with its Redis cache)
// lives in images/query.ts; object/thumb byte serving and S3 public-URL redirects
// live in images/serving.ts.
export function registerPublicRoutes(app: Hono) {
  // Gallery data is for the SPA itself: blockCrossSiteFetch refuses cross-origin / embedded reads on
  // both the image list and the facet options (robots.txt handles compliant crawlers). /api/site-config
  // stays open — tiny boot config, also inlined into the SPA document, so it must load anywhere.
  app.get("/api/images", blockCrossSiteFetch, async (c) => {
    const q = parse(listQuery, Object.fromEntries(new URL(c.req.url).searchParams));
    return c.json(ok(await listPublicImages(q)));
  });

  // The same payload is inlined into the SPA document (routes/spa.ts) so the first load needs no
  // round-trip; this endpoint stays for the in-session refetch after an admin settings change.
  app.get("/api/site-config", async (c) => c.json(ok(siteConfigPayload())));

  app.get("/api/gallery-options", blockCrossSiteFetch, async (c) => c.json(ok(await getPublicGalleryFacets())));

  // /media and /thumbs are exposed on two cookie-isolated hosts (the index.ts host guard
  // gates which). static.<domain> serves stored objects + their thumbnails; link.<domain>
  // serves link images — /media proxies the external original, /thumbs the stored thumbnail.
  app.get("/media/*", async (c) => {
    const key = c.req.path.replace(/^\/media\//, "");
    return specialHost(c.req.header("host") ?? "") === "link" ? serveLinkMedia(key) : serveObject(key);
  });
  app.get("/thumbs/*", async (c) => {
    const key = c.req.path.replace(/^\/thumbs\//, "");
    return specialHost(c.req.header("host") ?? "") === "link" ? serveLinkThumb(key) : serveThumb(key);
  });
}
