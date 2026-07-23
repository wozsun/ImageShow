import type { Hono } from "hono";
import { adminApiBasePath, appConfig } from "@imageshow/shared";
import { ApiError } from "../core/api-error.ts";
import { apiSuccess } from "../core/http/responses.ts";
import {
  importCommitInput,
  importCreateInput,
  jsonlManifestInput,
  parse,
  uuidInput,
  weiboImportInput
} from "../core/validation.ts";
import { commitImportSession } from "../images/imports/commit.ts";
import { prepareImportSession } from "../images/imports/prepare.ts";
import {
  materializeDownloadSession,
  receiveImportFile
} from "../images/imports/materialize.ts";
import { listImportStatuses, streamImportEvents } from "../images/imports/status.ts";
import {
  cancelImportSession,
  createImportSession,
  previewImportSession
} from "../images/imports/session.ts";
import { isReservedSubdomain } from "../themes/host.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { JsonlManifestError, parseJsonlManifest } from "../images/imports/jsonl.ts";
import { createWeiboImportBatchManifest } from "../images/imports/weibo.ts";
import { WeiboImportError } from "../images/imports/weibo-types.ts";
import { getImportVocabulary } from "../vocab/vocab-cache.ts";
import {
  limitJsonlManifestBody,
  limitWeiboImportBody,
} from "../core/http/request-body-limit.ts";

export function registerImportRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/import-vocabulary`, async (c) => {
    return c.json(apiSuccess(await getImportVocabulary()));
  });

  app.post(`${adminApiBasePath}/imports/create`, async (c) => {
    const input = parse(importCreateInput, await c.req.json().catch(() => ({})));
    return c.json(apiSuccess(await createImportSession(input)));
  });

  app.post(`${adminApiBasePath}/imports/jsonl/parse`, limitJsonlManifestBody, async (c) => {
    const input = parse(jsonlManifestInput, await c.req.json().catch(() => ({})));
    try {
      return c.json(apiSuccess(parseJsonlManifest(input.content, {
        maxItems: getRuntimeConfig().link_image.max_items,
        timeZone: process.env.TZ
      })));
    } catch (error) {
      if (error instanceof JsonlManifestError) throw new ApiError(400, error.code, error.message);
      throw error;
    }
  });

  app.post(`${adminApiBasePath}/imports/weibo/parse`, limitWeiboImportBody, async (c) => {
    const input = parse(weiboImportInput, await c.req.json().catch(() => ({})));
    const runtimeConfig = getRuntimeConfig();
    const maxPosts = Math.min(
      appConfig.imports.batchHardLimit,
      runtimeConfig.weibo.max_items
    );
    if (input.urls.length > maxPosts) {
      throw new ApiError(
        400,
        "weibo_batch_limit_exceeded",
        `单批最多允许 ${maxPosts} 条微博链接`
      );
    }
    try {
      return c.json(apiSuccess(await createWeiboImportBatchManifest(
        input.urls,
        {
          authorSlugs: runtimeConfig.weibo.author_slugs,
          concurrency: runtimeConfig.weibo.concurrency,
          timeZone: process.env.TZ,
          signal: c.req.raw.signal
        }
      )));
    } catch (error) {
      if (error instanceof JsonlManifestError) throw new ApiError(400, error.code, error.message);
      if (error instanceof WeiboImportError) {
        let status: 400 | 422 | 502 = 422;
        if (
          error.code === "weibo_invalid_url"
          || error.code === "weibo_image_limit_exceeded"
        ) {
          status = 400;
        }
        if (
          error.code === "weibo_visitor_failed"
          || error.code === "weibo_request_failed"
          || error.code === "weibo_response_too_large"
        ) {
          status = 502;
        }
        throw new ApiError(status, error.code, error.message);
      }
      throw error;
    }
  });

  app.put(`${adminApiBasePath}/imports/:id/file`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const body = c.req.raw.body ?? new Response(await c.req.arrayBuffer()).body;
    await receiveImportFile(id, body, c.req.raw.signal);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/imports/:id/materialize`, async (c) => {
    await materializeDownloadSession(
      parse(uuidInput, c.req.param("id")),
      c.req.raw.signal
    );
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/imports/:id/prepare`, async (c) => {
    return c.json(apiSuccess(await prepareImportSession(
      parse(uuidInput, c.req.param("id")),
      c.req.raw.signal
    )));
  });

  app.get(`${adminApiBasePath}/imports/:id/preview/full`, async (c) => {
    return previewImportSession(parse(uuidInput, c.req.param("id")), "full");
  });

  app.get(`${adminApiBasePath}/imports/:id/preview`, async (c) => {
    return previewImportSession(parse(uuidInput, c.req.param("id")), "thumb");
  });

  app.get(`${adminApiBasePath}/imports/status`, async (c) => {
    const ids = parseImportIds(c.req.url);
    return c.json(apiSuccess({ items: await listImportStatuses(ids) }));
  });

  app.get(`${adminApiBasePath}/imports/events`, async (c) => {
    return streamImportEvents(parseImportIds(c.req.url));
  });

  app.post(`${adminApiBasePath}/imports/:id/commit`, async (c) => {
    const id = parse(uuidInput, c.req.param("id"));
    const input = parse(importCommitInput, await c.req.json().catch(() => ({})));
    if (isReservedSubdomain(input.theme)) throw new ApiError(400, "theme_reserved", "Theme conflicts with a reserved subdomain prefix", { theme: input.theme });
    return c.json(apiSuccess(await commitImportSession(id, input, c.req.raw.signal)));
  });

  app.post(`${adminApiBasePath}/imports/:id/cancel`, async (c) => {
    await cancelImportSession(parse(uuidInput, c.req.param("id")));
    return c.json(apiSuccess());
  });
}

function parseImportIds(url: string) {
  return (new URL(url).searchParams.get("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => parse(uuidInput, id));
}
