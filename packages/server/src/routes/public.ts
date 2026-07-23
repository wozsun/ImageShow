import type { Hono } from "hono";
import { apiSuccess } from "../core/http/responses.ts";
import { blockCrossSiteFetch } from "../core/http/request-security.ts";
import {
  noStoreCacheControl,
  publicConfigCacheControl,
  publicListCacheControl,
  publicMetadataCacheControl
} from "../core/http/headers.ts";
import { listQuery, parse, uuidInput } from "../core/validation.ts";
import { siteConfigPayload } from "../config/app-settings.ts";
import { getPublicGalleryFacets } from "../images/read-models/facets.ts";
import { getPublicImage, listPublicImages } from "../images/read-models/public-images.ts";
import { redirectOriginalLink, serveObject, serveOriginalLinkProxy, serveThumb } from "../images/serving.ts";

export function registerPublicRoutes(app: Hono) {

  app.get("/api/images", blockCrossSiteFetch, async (c) => {
    const q = parse(listQuery, Object.fromEntries(new URL(c.req.url).searchParams));
    c.header("Cache-Control", q.shuffle ? noStoreCacheControl : publicListCacheControl);
    return c.json(apiSuccess(await listPublicImages(q)));
  });

  app.get("/api/site-config", async (c) => {
    c.header("Cache-Control", publicConfigCacheControl);
    return c.json(apiSuccess(siteConfigPayload()));
  });

  app.get("/api/gallery-facets", blockCrossSiteFetch, async (c) => {
    c.header("Cache-Control", publicMetadataCacheControl);
    return c.json(apiSuccess(await getPublicGalleryFacets()));
  });

  app.get("/api/images/:id", blockCrossSiteFetch, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    c.header("Cache-Control", publicMetadataCacheControl);
    return c.json(apiSuccess({ item: await getPublicImage(id) }));
  });

  app.get("/api/images/:id/original", async (c) => redirectOriginalLink(
    parse(uuidInput, c.req.param("id")),
    c.req.header("user-agent") ?? ""
  ));

  app.get("/media/*", async (c) => {
    const key = c.req.path.replace(/^\/media\//, "");
    return serveObject(key, {
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
    return serveThumb(key, request);
  });
  app.get("/original/:id", async (c) => serveOriginalLinkProxy(parse(uuidInput, c.req.param("id")), c.req.method === "HEAD"));
}
