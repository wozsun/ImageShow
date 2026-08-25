import type { Context, Hono } from "hono";
import { appConfig } from "@imageshow/shared";
import {
  adminApiBasePath,
  importActionScopeHeader,
  importActionPath,
  importCancelPath,
  importCommitPath,
  importDuplicatesPath,
  importEventsPath,
  importSnapshotPath,
  importStatusPath,
  importUpdatePath,
  remoteImportAcceptPath,
  uploadCredentialHeader,
  uploadIntentPath,
  uploadRawPath,
  type ImportCancelResultDto,
  type ImportQueueActionResultDto,
  type ImportCommitResultDto,
  type ImportDuplicateDetailsResultDto,
  type ImportStatusResultDto,
  type ImportSessionUpdateResultDto,
  type RemoteImportAcceptResultDto,
  type UploadIntentResultDto,
  type UploadRawResultDto
} from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "../core/api-error.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import {
  limitImportControlBody,
  limitImportSnapshotBody,
  limitJsonlManifestBody,
  limitWeiboImportBody
} from "../core/http/request-body-limit.ts";
import {
  apiSuccess,
  privateCacheableApiSuccess
} from "../core/http/responses.ts";
import {
  importCancelInput,
  importCommitIntentInput,
  importEventsQuery,
  importDuplicateDetailsInput,
  importSessionUpdateInput,
  importSessionIdInput,
  importSnapshotQuery,
  importSnapshotSelectionInput,
  importStatusInput,
  importQueueActionInput,
  jsonlManifestInput,
  parse,
  remoteImportAcceptInput,
  uploadIntentInput,
  uuidV7Input,
  weiboImportInput
} from "../core/validation.ts";
import { acceptImportCommitIntents } from "../images/imports/commit-intent.ts";
import { cancelImportSessions } from "../images/imports/cancel-session.ts";
import { JsonlManifestError, parseJsonlManifest } from "../images/imports/jsonl.ts";
import { receiveUploadIntentBody } from "../images/imports/raw-upload.ts";
import { streamImportQueueEvents } from "../images/imports/queue-events.ts";
import { readStableImportQueueSnapshot } from "../images/imports/queue-snapshot.ts";
import { readDuplicateSnapshotsByMd5 } from "../images/read-models/duplicates.ts";
import { runImportQueueAction } from "../images/imports/queue-action.ts";
import { updateImportSessions } from "../images/imports/session-update.ts";
import {
  importSessionRepository,
  importSessionService,
  importSessionWorker,
  importTokenService
} from "../images/imports/runtime.ts";
import {
  readImportPreview,
  readImportStatuses
} from "../images/imports/session-view.ts";
import { createWeiboImportBatchManifest } from "../images/imports/weibo.ts";
import { WeiboImportError } from "../images/imports/weibo-types.ts";
import type { AdminSession } from "../users/admin-session.ts";
import { getImportVocabulary } from "../vocab/vocab-cache.ts";

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

function importActionScope(c: Context) {
  const value = c.req.header(importActionScopeHeader) ?? "";
  if (
    !/^[A-Za-z0-9_-]{32}$/u.test(value)
    || Buffer.byteLength(value, "utf8")
      > appConfig.importRuntime.tokenMaxBytes
  ) {
    throw new ApiError(
      409,
      "import_action_scope_stale",
      "请先连接导入队列状态通道"
    );
  }
  return value;
}

function importPair(c: Context) {
  return {
    session_id: parse(importSessionIdInput, c.req.param("sessionId")),
    image_id: parse(uuidV7Input, c.req.param("imageId"))
  };
}

function uploadCredential(c: Context) {
  const credential = c.req.header(uploadCredentialHeader) ?? "";
  if (
    !credential
    || Buffer.byteLength(credential, "utf8")
      > appConfig.importRuntime.tokenMaxBytes
  ) {
    throw new ApiError(
      401,
      "upload_credential_invalid",
      "上传凭证无效或缺失"
    );
  }
  return credential;
}

export function registerImportRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/import-vocabulary`, async (c) => {
    return privateCacheableApiSuccess(c, await getImportVocabulary());
  });

  app.get(importEventsPath, (c) => {
    const input = parse(importEventsQuery, c.req.query());
    return streamImportQueueEvents(c, {
      repository: importSessionRepository,
      tokens: importTokenService,
      session: authenticatedSession(c),
      queue: input.queue
    });
  });

  app.post(importSnapshotPath, limitImportSnapshotBody, async (c) => {
    const input = parse(importSnapshotQuery, c.req.query());
    const selection = parse(
      importSnapshotSelectionInput,
      await readJsonBody(c)
    );
    if (input.limit + selection.include_items.length
      > appConfig.importRuntime.snapshotMaxItems) {
      throw new ApiError(
        400,
        "invalid_import_snapshot",
        "队列页与补入任务总数超过快照上限"
      );
    }
    return c.json(apiSuccess(await readStableImportQueueSnapshot({
      repository: importSessionRepository,
      tokens: importTokenService,
      session: authenticatedSession(c),
      actionScope: importActionScope(c),
      queue: input.queue,
      offset: input.offset,
      limit: input.limit,
      excludeItems: selection.exclude_items,
      includeItems: selection.include_items
    })));
  });

  app.post(importDuplicatesPath, limitImportControlBody, async (c) => {
    const input = parse(importDuplicateDetailsInput, await readJsonBody(c));
    authenticatedSession(c);
    const snapshots = await readDuplicateSnapshotsByMd5(input.md5s);
    const response: ImportDuplicateDetailsResultDto = {
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

  app.post(uploadIntentPath, limitImportControlBody, async (c) => {
    const input = parse(uploadIntentInput, await readJsonBody(c));
    const response = {
      items: await importSessionService.createUploadIntents(
        authenticatedUsername(c),
        input.items
      )
    } satisfies UploadIntentResultDto;
    return c.json(apiSuccess(response));
  });

  app.put(uploadRawPath, async (c) => {
    const session = await receiveUploadIntentBody(
      importSessionService,
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

  app.post(remoteImportAcceptPath, limitImportControlBody, async (c) => {
    const input = parse(remoteImportAcceptInput, await readJsonBody(c));
    const response = {
      items: await importSessionService.acceptRemoteItems(
        authenticatedUsername(c),
        input.items
      )
    } satisfies RemoteImportAcceptResultDto;
    return c.json(apiSuccess(response));
  });

  app.post(`${adminApiBasePath}/imports/jsonl/parse`, limitJsonlManifestBody, async (c) => {
    const input = parse(jsonlManifestInput, await readJsonBody(c));
    try {
      return c.json(apiSuccess(parseJsonlManifest(input.content, {
        maxItems: getRuntimeConfig().link_image.max_items,
        timeZone: process.env.TZ
      })));
    } catch (error) {
      if (error instanceof JsonlManifestError) {
        throw new ApiError(400, error.code, error.message);
      }
      throw error;
    }
  });

  app.post(`${adminApiBasePath}/imports/weibo/parse`, limitWeiboImportBody, async (c) => {
    const input = parse(weiboImportInput, await readJsonBody(c));
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
    `${adminApiBasePath}/imports/preview/:sessionId/:imageId/full`,
    (c) => readImportPreview(
      importSessionRepository,
      authenticatedUsername(c),
      importPair(c),
      "full",
      c.req.raw.signal
    )
  );

  app.get(
    `${adminApiBasePath}/imports/preview/:sessionId/:imageId`,
    (c) => readImportPreview(
      importSessionRepository,
      authenticatedUsername(c),
      importPair(c),
      "thumb",
      c.req.raw.signal
    )
  );

  app.post(importStatusPath, limitImportControlBody, async (c) => {
    const input = parse(importStatusInput, await readJsonBody(c));
    const response = {
      items: await readImportStatuses(
        importSessionRepository,
        authenticatedUsername(c),
        input.items
      )
    } satisfies ImportStatusResultDto;
    return c.json(apiSuccess(response));
  });

  app.post(importUpdatePath, limitImportControlBody, async (c) => {
    const input = parse(importSessionUpdateInput, await readJsonBody(c));
    const response = {
      items: await updateImportSessions(
        importSessionRepository,
        authenticatedUsername(c),
        input.items
      )
    } satisfies ImportSessionUpdateResultDto;
    return c.json(apiSuccess(response));
  });

  app.post(importActionPath, limitImportControlBody, async (c) => {
    const input = parse(importQueueActionInput, await readJsonBody(c));
    const response = await runImportQueueAction({
      repository: importSessionRepository,
      coordinator: importSessionWorker.coordinator,
      tokens: importTokenService,
      session: authenticatedSession(c),
      actionScope: importActionScope(c),
      request: input,
      abortActive: (pair) => importSessionWorker.abortActive(pair)
    }) satisfies ImportQueueActionResultDto;
    return c.json(apiSuccess(response));
  });

  app.post(importCommitPath, limitImportControlBody, async (c) => {
    const input = parse(importCommitIntentInput, await readJsonBody(c));
    const response = {
      items: await acceptImportCommitIntents(
        importSessionRepository,
        authenticatedUsername(c),
        input.items
      )
    } satisfies ImportCommitResultDto;
    return c.json(apiSuccess(response));
  });

  app.post(importCancelPath, limitImportControlBody, async (c) => {
    const input = parse(importCancelInput, await readJsonBody(c));
    const response = {
      items: await cancelImportSessions(
        importSessionRepository,
        importSessionWorker.coordinator,
        authenticatedUsername(c),
        input.items,
        (pair) => importSessionWorker.abortActive(pair)
      )
    } satisfies ImportCancelResultDto;
    return c.json(apiSuccess(response));
  });
}
