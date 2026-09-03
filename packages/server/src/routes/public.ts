import type { Context, Hono } from "hono";
import type { PublicImageDetailResponseDto } from "@imageshow/shared/browser";
import { siteConfigPayload } from "../config/app-settings.ts";
import {
  noStoreCacheControl,
  publicConfigCacheControl,
  publicListCacheControl,
  publicMetadataCacheControl
} from "../core/http/headers.ts";
import { blockCrossSiteFetch } from "../core/http/request-security.ts";
import {
  apiErrorResponse,
  apiSuccess,
  cacheableApiSuccess
} from "../core/http/responses.ts";
import {
  galleryStatsQuery,
  listQuery
} from "./validation/images.ts";
import { parse } from "./validation/parse.ts";
import { uuidInput } from "./validation/primitives.ts";
import {
  servePublicExternalOriginal
} from "../images/external-original-serving.ts";
import { getPublicGalleryFacets } from "../images/read-models/facets.ts";
import { getPublicGalleryStats } from "../images/read-models/gallery-stats.ts";
import {
  getPublicImage,
  listPublicImages
} from "../images/read-models/public-images.ts";
import {
  servePublicStoredObject,
  servePublicStoredThumbnail
} from "../images/stored-image-serving.ts";
import type { StoredResponseRequest } from "../images/stored-object-response.ts";

const galleryStatsQueryKeys = [
  "device",
  "brightness",
  "theme",
  "tag",
  "author"
] as const;
const galleryStatsQueryKeySet = new Set<string>(galleryStatsQueryKeys);

function storedResponseRequest(context: Context): StoredResponseRequest {
  return {
    range: context.req.header("range"),
    ifNoneMatch: context.req.header("if-none-match"),
    ifModifiedSince: context.req.header("if-modified-since"),
    ifRange: context.req.header("if-range"),
    isHead: context.req.method === "HEAD",
    signal: context.req.raw.signal
  };
}

export function registerPublicRoutes(app: Hono) {
  app.get("/api/images", blockCrossSiteFetch, async (c) => {
    const q = parse(
      listQuery,
      Object.fromEntries(new URL(c.req.url).searchParams)
    );
    const response = await listPublicImages(q, c.req.raw.signal);
    if (q.shuffle) {
      c.header("Cache-Control", noStoreCacheControl);
      return c.json(apiSuccess(response));
    }
    return cacheableApiSuccess(c, response, publicListCacheControl);
  });

  app.get("/api/site-config", async (c) => cacheableApiSuccess(
    c,
    siteConfigPayload(),
    publicConfigCacheControl
  ));

  app.get("/api/gallery-facets", blockCrossSiteFetch, async (c) => (
    cacheableApiSuccess(
      c,
      await getPublicGalleryFacets(c.req.raw.signal),
      publicMetadataCacheControl
    )
  ));

  app.all("/api/gallery-stats", blockCrossSiteFetch, async (c) => {
    if (c.req.method !== "GET") {
      return apiErrorResponse({
        status: 405,
        message: "Method Not Allowed"
      });
    }
    const searchParams = new URL(c.req.url).searchParams;
    if ([...searchParams.keys()].some((key) => (
      !galleryStatsQueryKeySet.has(key)
    ))) {
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
    return cacheableApiSuccess(
      c,
      await getPublicGalleryStats(
        parse(galleryStatsQuery, rawQuery),
        c.req.raw.signal
      ),
      publicMetadataCacheControl
    );
  });

  app.get("/api/images/:id", blockCrossSiteFetch, async (c) => {
    const response = {
      item: await getPublicImage(
        parse(uuidInput, c.req.param("id")),
        c.req.raw.signal
      )
    } satisfies PublicImageDetailResponseDto;
    return cacheableApiSuccess(c, response, publicMetadataCacheControl);
  });

  app.get("/media/*", async (c) => servePublicStoredObject(
    "media",
    c.req.path.replace(/^\/media\//, ""),
    storedResponseRequest(c)
  ));
  app.get("/full/*", async (c) => servePublicStoredObject(
    "full",
    c.req.path.replace(/^\/full\//, ""),
    storedResponseRequest(c)
  ));
  app.get("/thumbs/*", async (c) => servePublicStoredThumbnail(
    c.req.path.replace(/^\/thumbs\//, ""),
    storedResponseRequest(c)
  ));
  app.get("/link/original/:id", async (c) => servePublicExternalOriginal(
    parse(uuidInput, c.req.param("id")),
    {
      userAgent: c.req.header("user-agent") ?? "",
      method: c.req.method === "HEAD" ? "HEAD" : "GET",
      ifNoneMatch: c.req.header("if-none-match"),
      ifModifiedSince: c.req.header("if-modified-since"),
      signal: c.req.raw.signal
    }
  ));
}
