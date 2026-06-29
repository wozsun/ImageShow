import type { Hono } from "hono";
import { ok } from "../core/http.js";
import { listQuery, parse } from "../core/validation.js";
import { getRuntimeConfig } from "../config/env.js";
import { effectiveHomeHeroBackground, effectiveLoginBackground } from "../config/settings.js";
import { getPublicGalleryFacets, listPublicImages } from "../images/query.js";
import { serveLinkMedia, serveLinkThumb, serveObject, serveThumb } from "../images/serving.js";
import { specialHost } from "../themes/host.js";

// Thin HTTP layer for the public read API. The gallery list (with its Redis cache)
// lives in images/query.ts; object/thumb byte serving and S3 public-URL redirects
// live in images/serving.ts.
export function registerPublicRoutes(app: Hono) {
  app.get("/api/images", async (c) => {
    const q = parse(listQuery, Object.fromEntries(new URL(c.req.url).searchParams));
    return c.json(ok(await listPublicImages(q)));
  });

  app.get("/api/site-config", async (c) => {
    const runtime = getRuntimeConfig();
    // Only the fields the frontend needs; the reserved subdomain labels stay
    // server-side.
    const { name, domain, icon_url, root_redirect, home_enabled } = runtime.site;
    return c.json(ok({
      // login_background / home_hero_background are resolved to their effective URLs here so the
      // login page and homepage hero can use them directly without the random-API convention.
      site: { name, domain, icon_url, root_redirect, home_enabled, login_background: effectiveLoginBackground(runtime.site), home_hero_background: effectiveHomeHeroBackground(runtime.site) },
      home: runtime.home,
      upload: { max_file_size_mb: runtime.upload.max_file_size_mb, max_long_edge: runtime.upload.max_long_edge },
      gallery: { order: runtime.gallery.order },
      image_detail: runtime.image_detail,
      captcha: { enabled: runtime.captcha.enabled }
    }));
  });

  app.get("/api/gallery-options", async (c) => c.json(ok(await getPublicGalleryFacets())));

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
