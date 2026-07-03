import type { Hono } from "hono";
import { blockCrossSiteFetch, ok } from "../core/http.js";
import { listQuery, parse, uuidInput } from "../core/validation.js";
import { siteConfigPayload } from "../config/settings.js";
import { getPublicGalleryFacets, listPublicImages } from "../images/query.js";
import { redirectOriginalLink, serveLinkMedia, serveLinkThumb, serveObject, serveOriginalLinkProxy, serveThumb } from "../images/serving.js";
import { specialHost } from "../themes/host.js";

export function registerPublicRoutes(app: Hono) {

  app.get("/api/images", blockCrossSiteFetch, async (c) => {
    const q = parse(listQuery, Object.fromEntries(new URL(c.req.url).searchParams));
    return c.json(ok(await listPublicImages(q)));
  });

  app.get("/api/site-config", async (c) => c.json(ok(siteConfigPayload())));

  app.get("/api/gallery-options", blockCrossSiteFetch, async (c) => c.json(ok(await getPublicGalleryFacets())));

  app.get("/api/images/:id/original", async (c) => redirectOriginalLink(
    parse(uuidInput, c.req.param("id")),
    c.req.header("user-agent") ?? ""
  ));

  app.get("/media/*", async (c) => {
    const key = c.req.path.replace(/^\/media\//, "");
    return specialHost(c.req.header("host") ?? "") === "link" ? serveLinkMedia(key) : serveObject(key);
  });
  app.get("/thumbs/*", async (c) => {
    const key = c.req.path.replace(/^\/thumbs\//, "");
    return specialHost(c.req.header("host") ?? "") === "link" ? serveLinkThumb(key) : serveThumb(key);
  });
  app.get("/original/:id", async (c) => serveOriginalLinkProxy(parse(uuidInput, c.req.param("id"))));
}
