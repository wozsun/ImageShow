import type { Hono } from "hono";
import type { PublicImageDetailResponseDto } from "@imageshow/shared/browser";
import { apiErrorResponse, apiSuccess } from "../core/http/responses.ts";
import { blockCrossSiteFetch } from "../core/http/request-security.ts";
import {
  noStoreCacheControl,
  publicConfigCacheControl,
  publicListCacheControl,
  publicMetadataCacheControl
} from "../core/http/headers.ts";
import {
  galleryStatsQuery,
  listQuery,
  parse,
  uuidInput
} from "../core/validation.ts";
import { siteConfigPayload } from "../config/app-settings.ts";
import { getPublicGalleryFacets } from "../images/read-models/facets.ts";
import { getPublicGalleryStats } from "../images/read-models/gallery-stats.ts";
import { getPublicImage, listPublicImages } from "../images/read-models/public-images.ts";
import { redirectOriginalLink, serveObject, serveOriginalLinkProxy, serveThumb } from "../images/serving.ts";
import { storedResponseRequest } from "./stored-response-request.ts";

const galleryStatsQueryKeys = ["d", "b", "t", "tag", "a"] as const;
const galleryStatsQueryKeySet = new Set<string>(galleryStatsQueryKeys);

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

  app.all("/api/gallery-stats", blockCrossSiteFetch, async (c) => {
    if (c.req.method !== "GET") {
      return apiErrorResponse({
        status: 405,
        message: "Method Not Allowed"
      });
    }
    const searchParams = new URL(c.req.url).searchParams;
    if ([...searchParams.keys()].some((key) => !galleryStatsQueryKeySet.has(key))) {
      return apiErrorResponse({
        status: 403,
        message: "Forbidden: Unknown query parameter"
      });
    }
    const rawQuery = Object.fromEntries(
      galleryStatsQueryKeys.flatMap((key) => {
        const values = searchParams.getAll(key);
        return values.length ? [[key, values.join(",")]] : [];
      })
    );
    const query = parse(galleryStatsQuery, rawQuery);
    c.header("Cache-Control", publicMetadataCacheControl);
    return c.json(apiSuccess(await getPublicGalleryStats(query)));
  });

  app.get("/api/images/:id", blockCrossSiteFetch, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    c.header("Cache-Control", publicMetadataCacheControl);
    const response = {
      item: await getPublicImage(id)
    } satisfies PublicImageDetailResponseDto;
    return c.json(apiSuccess(response));
  });

  app.get("/api/images/:id/original", async (c) => redirectOriginalLink(
    parse(uuidInput, c.req.param("id")),
    c.req.header("user-agent") ?? ""
  ));

  app.get("/media/*", async (c) => {
    const key = c.req.path.replace(/^\/media\//, "");
    return serveObject(key, storedResponseRequest(c));
  });
  app.get("/thumbs/*", async (c) => {
    const key = c.req.path.replace(/^\/thumbs\//, "");
    return serveThumb(key, storedResponseRequest(c));
  });
  app.get("/original/:id", async (c) => serveOriginalLinkProxy(parse(uuidInput, c.req.param("id")), c.req.method === "HEAD"));
}
