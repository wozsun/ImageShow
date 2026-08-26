import type { Context, Hono } from "hono";
import { appConfig } from "@imageshow/shared";
import {
  adminApiBasePath,
  ingestionActionScopeHeader,
  ingestionActionPath,
  ingestionCancelPath,
  ingestionCommitPath,
  ingestionDuplicatesPath,
  ingestionEventsPath,
  ingestionSnapshotPath,
  ingestionStatusPath,
  ingestionUpdatePath,
  importAcceptPath,
  uploadCredentialHeader,
  uploadIntentPath,
  uploadRawPath,
  type IngestionCancelResultDto,
  type IngestionQueueActionResultDto,
  type IngestionCommitResultDto,
  type IngestionDuplicateDetailsResultDto,
  type IngestionStatusResultDto,
  type IngestionSessionUpdateResultDto,
  type ImportAcceptResultDto,
  type UploadIntentResultDto,
  type UploadRawResultDto
} from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "../core/api-error.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import {
  limitIngestionControlBody,
  limitIngestionSnapshotBody,
  limitJsonlManifestBody,
  limitWeiboImportBody
} from "../core/http/request-body-limit.ts";
import {
  apiSuccess,
  privateCacheableApiSuccess
} from "../core/http/responses.ts";
import {
  ingestionCancelInput,
  ingestionCommitIntentInput,
  ingestionEventsQuery,
  ingestionDuplicateDetailsInput,
  ingestionSessionUpdateInput,
  ingestionSessionIdInput,
  ingestionSnapshotQuery,
  ingestionSnapshotSelectionInput,
  ingestionStatusInput,
  ingestionQueueActionInput,
  jsonlManifestInput,
  parse,
  importAcceptInput,
  uploadIntentInput,
  uuidV7Input,
  weiboImportInput
} from "../core/validation.ts";
import { acceptIngestionCommitIntents } from "../images/ingestion/commit/intent.ts";
import { cancelIngestionSessions } from "../images/ingestion/cancel/coordinator.ts";
import { JsonlManifestError, parseJsonlManifest } from "../images/ingestion/sources/jsonl.ts";
import { receiveUploadIntentBody } from "../images/ingestion/raw/upload.ts";
import { streamIngestionQueueEvents } from "../images/ingestion/queue/events.ts";
import { readStableIngestionQueueSnapshot } from "../images/ingestion/queue/snapshot.ts";
import { readDuplicateSnapshotsByMd5 } from "../images/read-models/duplicates.ts";
import { runIngestionQueueAction } from "../images/ingestion/queue/action.ts";
import { updateIngestionSessions } from "../images/ingestion/queue/session-update.ts";
import {
  ingestionSessionRepository,
  ingestionSessionService,
  ingestionSessionWorker,
  ingestionTokenService
} from "../images/ingestion/runtime.ts";
import {
  readIngestionPreview,
  readIngestionStatuses
} from "../images/ingestion/queue/session-view.ts";
import { createWeiboImportBatchManifest } from "../images/ingestion/sources/weibo.ts";
import { WeiboImportError } from "../images/ingestion/sources/weibo-types.ts";
import type { AdminSession } from "../users/admin-session.ts";
import { getIngestionVocabulary } from "../vocab/vocab-cache.ts";

function authenticatedSession(c: Context) {
  const session = c.get("session") as AdminSession | undefined;
  if (!session) {
    throw new ApiError(401, "unauthorized", "Unauthorized");
  }
  return session;
}

function authenticatedUsername(c: Context) {
  return authenticatedSession(c).username;
}

function ingestionActionScope(c: Context) {
  const value = c.req.header(ingestionActionScopeHeader) ?? "";
  if (
    !/^[A-Za-z0-9_-]{32}$/u.test(value)
    || Buffer.byteLength(value, "utf8")
      > appConfig.ingestionRuntime.tokenMaxBytes
  ) {
    throw new ApiError(
      409,
      "import_action_scope_stale",
      "请先连接内容接入队列状态通道"
    );
  }
  return value;
}

function ingestionPair(c: Context) {
  return {
    session_id: parse(ingestionSessionIdInput, c.req.param("sessionId")),
    image_id: parse(uuidV7Input, c.req.param("imageId"))
  };
}

function uploadCredential(c: Context) {
  const credential = c.req.header(uploadCredentialHeader) ?? "";
  if (
    !credential
    || Buffer.byteLength(credential, "utf8")
      > appConfig.ingestionRuntime.tokenMaxBytes
  ) {
    throw new ApiError(
      401,
      "upload_credential_invalid",
      "上传凭证无效或缺失"
    );
  }
  return credential;
}

export function registerIngestionRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/ingestion-vocabulary`, async (c) => {
    return privateCacheableApiSuccess(c, await getIngestionVocabulary());
  });

  app.get(ingestionEventsPath, (c) => {
    const input = parse(ingestionEventsQuery, c.req.query());
    return streamIngestionQueueEvents(c, {
      repository: ingestionSessionRepository,
      tokens: ingestionTokenService,
      session: authenticatedSession(c),
      queue: input.queue
    });
  });

  app.post(ingestionSnapshotPath, limitIngestionSnapshotBody, async (c) => {
    const input = parse(ingestionSnapshotQuery, c.req.query());
    const selection = parse(
      ingestionSnapshotSelectionInput,
      await readJsonBody(c)
    );
    if (input.limit + selection.include_items.length
      > appConfig.ingestionRuntime.snapshotMaxItems) {
      throw new ApiError(
        400,
        "invalid_import_snapshot",
        "队列页与补入任务总数超过快照上限"
      );
    }
    return c.json(apiSuccess(await readStableIngestionQueueSnapshot({
      repository: ingestionSessionRepository,
      tokens: ingestionTokenService,
      session: authenticatedSession(c),
      actionScope: ingestionActionScope(c),
      queue: input.queue,
      offset: input.offset,
      limit: input.limit,
      excludeItems: selection.exclude_items,
      includeItems: selection.include_items
    })));
  });

  app.post(ingestionDuplicatesPath, limitIngestionControlBody, async (c) => {
    const input = parse(ingestionDuplicateDetailsInput, await readJsonBody(c));
    authenticatedSession(c);
    const snapshots = await readDuplicateSnapshotsByMd5(input.md5s);
    const response: IngestionDuplicateDetailsResultDto = {
      items: input.md5s.map((md5) => {
        const snapshot = snapshots.get(md5)!;
        return {
          md5,
          match_count: snapshot.matchCount,
          duplicates: snapshot.items
        };
      })
    };
    return c.json(apiSuccess(response));
  });

  app.post(uploadIntentPath, limitIngestionControlBody, async (c) => {
    const input = parse(uploadIntentInput, await readJsonBody(c));
    const response = {
      items: await ingestionSessionService.createUploadIntents(
        authenticatedUsername(c),
        input.items
      )
    } satisfies UploadIntentResultDto;
    return c.json(apiSuccess(response));
  });

  app.put(uploadRawPath, async (c) => {
    const session = await receiveUploadIntentBody(
      ingestionSessionService,
      authenticatedUsername(c),
      uploadCredential(c),
      c.req.raw.body,
      c.req.raw.signal
    );
    const response = {
      session_id: session.session_id,
      image_id: session.image_id,
      status: "accepted",
      accepted_order: session.accepted_order,
      version: session.version,
      last_semantic_revision: session.last_semantic_revision
    } satisfies UploadRawResultDto;
    return c.json(apiSuccess(response));
  });

  app.post(importAcceptPath, limitIngestionControlBody, async (c) => {
    const input = parse(importAcceptInput, await readJsonBody(c));
    const response = {
      items: await ingestionSessionService.acceptImportItems(
        authenticatedUsername(c),
        input.items
      )
    } satisfies ImportAcceptResultDto;
    return c.json(apiSuccess(response));
  });

  app.post(`${adminApiBasePath}/ingestion/import/jsonl/parse`, limitJsonlManifestBody, async (c) => {
    const input = parse(jsonlManifestInput, await readJsonBody(c));
    try {
      return c.json(apiSuccess(parseJsonlManifest(input.content, {
        maxItems: getRuntimeConfig().import.max_items,
        timeZone: process.env.TZ
      })));
    } catch (error) {
      if (error instanceof JsonlManifestError) {
        throw new ApiError(400, error.code, error.message);
      }
      throw error;
    }
  });

  app.post(`${adminApiBasePath}/ingestion/import/weibo/parse`, limitWeiboImportBody, async (c) => {
    const input = parse(weiboImportInput, await readJsonBody(c));
    const runtimeConfig = getRuntimeConfig();
    const maxPosts = Math.min(
      appConfig.ingestion.batchHardLimit,
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
      if (error instanceof JsonlManifestError) {
        throw new ApiError(400, error.code, error.message);
      }
      if (error instanceof WeiboImportError) {
        let status: 400 | 422 | 502 = 422;
        if (
          error.code === "weibo_invalid_url"
          || error.code === "weibo_image_limit_exceeded"
        ) status = 400;
        if (
          error.code === "weibo_visitor_failed"
          || error.code === "weibo_request_failed"
          || error.code === "weibo_response_too_large"
        ) status = 502;
        throw new ApiError(status, error.code, error.message);
      }
      throw error;
    }
  });

  app.get(
    `${adminApiBasePath}/ingestion/preview/:sessionId/:imageId/full`,
    (c) => readIngestionPreview(
      ingestionSessionRepository,
      authenticatedUsername(c),
      ingestionPair(c),
      "full",
      c.req.raw.signal
    )
  );

  app.get(
    `${adminApiBasePath}/ingestion/preview/:sessionId/:imageId`,
    (c) => readIngestionPreview(
      ingestionSessionRepository,
      authenticatedUsername(c),
      ingestionPair(c),
      "thumb",
      c.req.raw.signal
    )
  );

  app.post(ingestionStatusPath, limitIngestionControlBody, async (c) => {
    const input = parse(ingestionStatusInput, await readJsonBody(c));
    const response = {
      items: await readIngestionStatuses(
        ingestionSessionRepository,
        authenticatedUsername(c),
        input.items
      )
    } satisfies IngestionStatusResultDto;
    return c.json(apiSuccess(response));
  });

  app.post(ingestionUpdatePath, limitIngestionControlBody, async (c) => {
    const input = parse(ingestionSessionUpdateInput, await readJsonBody(c));
    const response = {
      items: await updateIngestionSessions(
        ingestionSessionRepository,
        authenticatedUsername(c),
        input.items
      )
    } satisfies IngestionSessionUpdateResultDto;
    return c.json(apiSuccess(response));
  });

  app.post(ingestionActionPath, limitIngestionControlBody, async (c) => {
    const input = parse(ingestionQueueActionInput, await readJsonBody(c));
    const response = await runIngestionQueueAction({
      repository: ingestionSessionRepository,
      coordinator: ingestionSessionWorker.coordinator,
      tokens: ingestionTokenService,
      session: authenticatedSession(c),
      actionScope: ingestionActionScope(c),
      request: input,
      abortActive: (pair) => ingestionSessionWorker.abortActive(pair)
    }) satisfies IngestionQueueActionResultDto;
    return c.json(apiSuccess(response));
  });

  app.post(ingestionCommitPath, limitIngestionControlBody, async (c) => {
    const input = parse(ingestionCommitIntentInput, await readJsonBody(c));
    const response = {
      items: await acceptIngestionCommitIntents(
        ingestionSessionRepository,
        authenticatedUsername(c),
        input.items
      )
    } satisfies IngestionCommitResultDto;
    return c.json(apiSuccess(response));
  });

  app.post(ingestionCancelPath, limitIngestionControlBody, async (c) => {
    const input = parse(ingestionCancelInput, await readJsonBody(c));
    const response = {
      items: await cancelIngestionSessions(
        ingestionSessionRepository,
        ingestionSessionWorker.coordinator,
        authenticatedUsername(c),
        input.items,
        (pair) => ingestionSessionWorker.abortActive(pair)
      )
    } satisfies IngestionCancelResultDto;
    return c.json(apiSuccess(response));
  });
}
