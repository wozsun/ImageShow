import type { Hono } from "hono";
import { blockCrossSiteFetch, noStoreCacheControl, ok, publicConfigCacheControl, publicListCacheControl, publicMetadataCacheControl } from "../core/http.ts";
import { listQuery, parse, uuidInput } from "../core/validation.ts";
import { siteConfigPayload } from "../config/app-settings.ts";
import { getPublicGalleryFacets } from "../images/read-models/facets.ts";
import { getPublicImage, listPublicImages } from "../images/read-models/public-images.ts";
import { redirectOriginalLink, serveLinkMedia, serveLinkThumb, serveObject, serveOriginalLinkProxy, serveThumb } from "../images/serving.ts";
import { specialHost } from "../themes/host.ts";

export function registerPublicRoutes(app: Hono) {

  app.get("/api/images", blockCrossSiteFetch, async (c) => {
    const q = parse(listQuery, Object.fromEntries(new URL(c.req.url).searchParams));
    c.header("Cache-Control", q.shuffle ? noStoreCacheControl : publicListCacheControl);
    return c.json(ok(await listPublicImages(q)));
  });

  app.get("/api/site-config", async (c) => {
    c.header("Cache-Control", publicConfigCacheControl);
    return c.json(ok(siteConfigPayload()));
  });

  app.get("/api/gallery-facets", blockCrossSiteFetch, async (c) => {
    c.header("Cache-Control", publicMetadataCacheControl);
    return c.json(ok(await getPublicGalleryFacets()));
  });

  app.get("/api/images/:id", blockCrossSiteFetch, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    c.header("Cache-Control", publicMetadataCacheControl);
    return c.json(ok({ item: await getPublicImage(id) }));
  });

  app.get("/api/images/:id/original", async (c) => redirectOriginalLink(
    parse(uuidInput, c.req.param("id")),
    c.req.header("user-agent") ?? ""
  ));

  app.get("/media/*", async (c) => {
    const key = c.req.path.replace(/^\/media\//, "");
    return specialHost(c.req.header("host") ?? "") === "link" ? serveLinkMedia(key, c.req.method === "HEAD") : serveObject(key, {
      range: c.req.header("range"),
      ifNoneMatch: c.req.header("if-none-match"),
      ifRange: c.req.header("if-range"),
      isHead: c.req.method === "HEAD"
    });
  });
  app.get("/thumbs/*", async (c) => {
    const key = c.req.path.replace(/^\/thumbs\//, "");
    const request = {
      range: c.req.header("range"),
      ifNoneMatch: c.req.header("if-none-match"),
      ifRange: c.req.header("if-range"),
      isHead: c.req.method === "HEAD"
    };
    return specialHost(c.req.header("host") ?? "") === "link" ? serveLinkThumb(key, request) : serveThumb(key, request);
  });
  app.get("/original/:id", async (c) => serveOriginalLinkProxy(parse(uuidInput, c.req.param("id")), c.req.method === "HEAD"));
}
