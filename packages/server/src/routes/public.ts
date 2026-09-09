import type { Context, Hono } from "hono";
import type { PublicImageDetailResponseDto } from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import { siteConfigPayload } from "../config/app-settings.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { readAdminSession } from "../users/admin-session.ts";
import {
  appendVaryHeader,
  privateRevalidationCacheControl,
  publicConfigCacheControl,
  publicImageCacheControl,
  publicMetadataCacheControl
} from "../core/http/headers.ts";
import { blockCrossSiteFetch } from "../core/http/request-security.ts";
import {
  apiErrorResponse,
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
    const startedAt = Date.now();
    const response = await listPublicImages(q, c.req.raw.signal, startedAt);
    let cacheControl = publicImageCacheControl;
    if (q.order === "random") {
      const endOfDay = (Math.floor(startedAt / 86_400_000) + 1) * 86_400_000;
      const remaining = Math.floor((endOfDay - Date.now()) / 1_000);
      if (remaining < 0) throw new ApiError(409, "cursor_expired", "Image browse cursor has expired");
      cacheControl = `public, max-age=${Math.min(30, remaining)}, s-maxage=${Math.min(60, remaining)}`;
    }
    return cacheableApiSuccess(c, response, cacheControl);
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
    const id = parse(uuidInput, c.req.param("id"));
    const publicOriginalButton = getRuntimeConfig().site.gallery.public_original_button;
    // Link visibility can depend on the session; the resource URL stays public.
    appendVaryHeader(c, "Cookie");
    const includeOriginal = publicOriginalButton || Boolean(await readAdminSession(c));
    const response = {
      item: await getPublicImage(
        id,
        c.req.raw.signal,
        includeOriginal
      )
    } satisfies PublicImageDetailResponseDto;
    return cacheableApiSuccess(c, response, publicOriginalButton
      ? publicImageCacheControl
      : privateRevalidationCacheControl);
  });

  app.get("/images/full/*", async (c) => servePublicStoredObject(
    c.req.path.slice("/images/full/".length),
    storedResponseRequest(c)
  ));
  app.get("/images/thumbs/*", async (c) => servePublicStoredThumbnail(
    c.req.path.slice("/images/thumbs/".length),
    storedResponseRequest(c)
  ));
  app.get("/images/original/:id", async (c) => servePublicExternalOriginal(
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
