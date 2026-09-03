import { appConfig } from "@imageshow/shared";
import type {
  ImportAcceptItemDto,
  ImportItemInputDto,
  UploadIntentItemDto,
  UploadIntentItemInputDto
} from "@imageshow/shared/browser";
import {
  getIngestionMaxFileBytes,
  getIngestionMaxLongEdge
} from "../../config/app-settings.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { ApiError, errorMessage } from "../../core/api-error.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import {
  assertStorageWriteTarget,
  getDefaultStorageSlug
} from "../../storage/backends/registry.ts";
import { withStorageLocationReadLock } from "../../storage/maintenance-lock.ts";
import { createImageId, ImageTimeError, parseImageTime } from "../image-time.ts";
import {
  committedIngestionResultForOwner,
  readCommittedIngestionResultsByImageIds,
  type CommittedIngestionResult
} from "../read-models/ingestion-results.ts";
import { canonicalImportMetadata } from "./sessions/import-metadata.ts";
import { ingestionIntentRequestHash } from "./sessions/request-hash.ts";
import {
  assertImageIdentity,
  createIngestionDisplayOrderKey,
  createIngestionSessionId
} from "./sessions/identity.ts";
import type {
  IngestionSessionSnapshot,
  StoredIngestionSession,
  UploadIntentSnapshot
} from "./sessions/model.ts";
import { ingestionSessionSemanticHash } from "./sessions/projection.ts";
import { IngestionSessionRepository } from "./repository.ts";
import {
  IngestionTokenService,
  uploadCredentialPurpose,
  type IngestionTokenEnvelope
} from "./sessions/token-service.ts";

type DraftLike = Pick<
  UploadIntentItemInputDto,
  | "device"
  | "brightness"
  | "theme"
  | "author"
  | "title"
  | "description"
  | "source"
  | "original"
  | "tags"
>;

function draftMetadata(item: DraftLike) {
  return {
    device: item.device,
    brightness: item.brightness,
    theme: item.theme,
    author: item.author,
    title: item.title,
    description: item.description,
    source: item.source,
    original: item.original,
    tags: [...item.tags]
  };
}

type UploadCredential = IngestionTokenEnvelope & {
  owner: string;
  session_id: string;
  candidate_image_id: string;
  request_hash: string;
};

function isUploadCredential(value: IngestionTokenEnvelope): value is UploadCredential {
  const keys = Object.keys(value).sort();
  return keys.join(",") === [
    "candidate_image_id",
    "expires_at",
    "issued_at",
    "owner",
    "purpose",
    "request_hash",
    "session_id"
  ].sort().join(",")
    && typeof value.owner === "string"
    && Boolean(value.owner)
    && typeof value.session_id === "string"
    && Boolean(value.session_id)
    && typeof value.candidate_image_id === "string"
    && Boolean(value.candidate_image_id)
    && typeof value.request_hash === "string"
    && /^[a-f0-9]{64}$/u.test(value.request_hash);
}

function normalizedImageTime(value?: string, batchTime?: string, now?: Date) {
  try {
    return parseImageTime(value ?? batchTime, { now });
  } catch (error) {
    if (error instanceof ImageTimeError) {
      throw new ApiError(400, error.code, error.message);
    }
    throw error;
  }
}

function providedImageTime(value?: string, batchTime?: string) {
  if (!value && !batchTime) return null;
  return normalizedImageTime(value, batchTime).iso;
}

function withSessionSemanticHash(
  session: Omit<IngestionSessionSnapshot, "semantic_hash">
): IngestionSessionSnapshot {
  const semantic_hash = ingestionSessionSemanticHash(
    session as Omit<IngestionSessionSnapshot, "semantic_hash">
  );
  return { ...session, semantic_hash };
}

async function resolvedStorageSlug(storageSlug?: string) {
  return storageSlug ?? getDefaultStorageSlug();
}

type IngestionItemFailure = Extract<UploadIntentItemDto, { status: "failed" }>;

type SettledItem<Input, Result> = Readonly<{
  input: Input;
  result: Result;
}> | Readonly<{
  input: Input;
  error: unknown;
}>;

type AcceptedIngestionItem = Exclude<
  ImportAcceptItemDto,
  { status: "failed" }
>;

type IngestionSessionServiceDependencies = Readonly<{
  readCommitted: typeof readCommittedIngestionResultsByImageIds;
  withStorageReadLock: typeof withStorageLocationReadLock;
  resolveStorageSlug: typeof resolvedStorageSlug;
  assertStorageWriteTarget: typeof assertStorageWriteTarget;
}>;

const ingestionSessionServiceDefaults: IngestionSessionServiceDependencies = {
  readCommitted: readCommittedIngestionResultsByImageIds,
  withStorageReadLock: withStorageLocationReadLock,
  resolveStorageSlug: resolvedStorageSlug,
  assertStorageWriteTarget
};

function failedItem(
  idempotencyKey: string,
  error: unknown,
  fallbackCode = "ingestion_item_failed",
  fallbackMessage?: string
): IngestionItemFailure {
  return {
    idempotency_key: idempotencyKey,
    status: "failed",
    code: error instanceof ApiError ? error.code : fallbackCode,
    message: fallbackMessage ?? errorMessage(error)
  };
}

export class IngestionSessionService {
  readonly repository: IngestionSessionRepository;
  readonly tokens: IngestionTokenService;
  readonly #dependencies: IngestionSessionServiceDependencies;

  constructor(
    repository = new IngestionSessionRepository(),
    tokens = new IngestionTokenService(),
    dependencies: Partial<IngestionSessionServiceDependencies> = {}
  ) {
    this.repository = repository;
    this.tokens = tokens;
    this.#dependencies = {
      ...ingestionSessionServiceDefaults,
      ...dependencies
    };
  }

  #credential(intent: UploadIntentSnapshot, now = Date.now()) {
    return this.tokens.sign(
      uploadCredentialPurpose,
      {
        owner: intent.owner,
        session_id: intent.session_id,
        candidate_image_id: intent.candidate_image_id,
        request_hash: intent.request_hash
      },
      intent.expires_at,
      now
    );
  }

  verifyUploadCredential(token: string, owner: string) {
    const claims = this.tokens.verify(
      uploadCredentialPurpose,
      token,
      isUploadCredential
    );
    if (claims.owner !== owner) {
      throw new ApiError(403, "upload_credential_owner_mismatch", "上传凭证不属于当前管理员");
    }
    return claims;
  }

  async #canonicalResult(
    idempotencyKey: string,
    session: StoredIngestionSession,
    committed: ReadonlyMap<string, CommittedIngestionResult>,
    lookupError: unknown,
    now: number
  ): Promise<AcceptedIngestionItem | IngestionItemFailure> {
    const databaseResult = committedIngestionResultForOwner(
      committed,
      session.image_id,
      session.owner
    );
    if (databaseResult) {
      return {
        session_id: session.session_id,
        image_id: session.image_id,
        resolved_image_time: databaseResult.image_time,
        request_hash: session.request_hash,
        status: "completed",
        accepted_order: session.accepted_order,
        ...(session.status === "completed" ? {
          version: session.version,
          last_semantic_revision: session.last_semantic_revision
        } : {})
      };
    }
    if (lookupError) {
      return failedItem(
        idempotencyKey,
        lookupError,
        "ingestion_result_lookup_failed",
        "无法核对内容接入任务的 PostgreSQL 最终结果"
      );
    }
    if (session.status === "completed") {
      try {
        await this.repository.deleteSession(session, session.version, now);
      } catch (error) {
        return failedItem(idempotencyKey, error);
      }
      return failedItem(
        idempotencyKey,
        new ApiError(
          409,
          "ingestion_result_missing",
          "Redis 完成收据在 PostgreSQL 中没有对应图片，已清除过期收据，请重试"
        )
      );
    }
    return {
      session_id: session.session_id,
      image_id: session.image_id,
      resolved_image_time: session.image_time,
      request_hash: session.request_hash,
      accepted_order: session.accepted_order,
      ...(session.status === "discarded"
        ? { status: "discarded" as const }
        : {
            status: "accepted" as const,
            version: session.version,
            last_semantic_revision: session.last_semantic_revision
          })
    };
  }

  async createUploadIntents(
    owner: string,
    items: readonly UploadIntentItemInputDto[],
    now = Date.now()
  ): Promise<UploadIntentItemDto[]> {
    const runtime = getRuntimeConfig();
    if (items.length > runtime.upload.max_items) {
      throw new ApiError(
        400,
        "upload_batch_limit_exceeded",
        `单批最多允许 ${runtime.upload.max_items} 张上传图片`
      );
    }
    const maximumBytes = getIngestionMaxFileBytes();
    const maximumLongEdge = getIngestionMaxLongEdge();
    const results = await this.#dependencies.withStorageReadLock(async (signal) => {
      const created: Array<SettledItem<
        UploadIntentItemInputDto,
        Awaited<ReturnType<IngestionSessionRepository["createUploadIntent"]>>
      >> = [];
      for (const item of items) {
        signal.throwIfAborted();
        try {
          if (item.expected_size > maximumBytes) {
            throw new ApiError(400, "upload_too_large", "图片大小超过限制", {
              limit: maximumBytes
            });
          }
          if (item.max_long_edge > maximumLongEdge) {
            throw new ApiError(
              400,
              "upload_dimensions_exceeded",
              "图片长边约束超过服务端限制",
              { limit: maximumLongEdge }
            );
          }
          const storageSlug = await this.#dependencies.resolveStorageSlug(
            item.storage_slug
          );
          await this.#dependencies.assertStorageWriteTarget(storageSlug);
          const explicitTime = providedImageTime(item.image_time, item.batch_time);
          const resolvedTime = normalizedImageTime(
            item.image_time,
            item.batch_time,
            new Date(now)
          );
          const sessionId = createIngestionSessionId(
            owner,
            "upload",
            item.idempotency_key
          );
          const requestHash = ingestionIntentRequestHash({
            queue: "upload",
            source_type: "upload",
            batch_key: item.batch_key,
            provided_image_time: explicitTime,
            batch_position: item.batch_position,
            import_download: null,
            metadata: draftMetadata(item),
            storage_slug: storageSlug,
            expected_size: item.expected_size,
            max_long_edge: item.max_long_edge
          });
          const intent: UploadIntentSnapshot = {
            owner,
            session_id: sessionId,
            candidate_image_id: createImageId(
              resolvedTime.date,
              item.batch_position
            ),
            resolved_image_time: resolvedTime.iso,
            request_hash: requestHash,
            display_order_key: createIngestionDisplayOrderKey(
              item.batch_key,
              item.batch_position,
              sessionId
            ),
            batch_position: item.batch_position,
            metadata: draftMetadata(item),
            storage_slug: storageSlug,
            expected_size: item.expected_size,
            max_long_edge: item.max_long_edge,
            created_at: now,
            expires_at: now
              + appConfig.ingestionRuntime.uploadIntentTtlSeconds * 1000,
            execution_token: "",
            claim_heartbeat_at: 0
          };
          created.push({
            input: item,
            result: await this.repository.createUploadIntent(intent)
          });
        } catch (error) {
          if (signal.aborted) throw error;
          created.push({ input: item, error });
        }
      }
      return created;
    });

    const canonicalIds = results.flatMap((entry) => (
      "result" in entry && entry.result.kind === "canonical"
        ? [entry.result.session.image_id]
        : []
    ));
    let committed = new Map<string, CommittedIngestionResult>();
    let lookupError: unknown = null;
    try {
      committed = await this.#dependencies.readCommitted(canonicalIds);
    } catch (error) {
      lookupError = error;
    }
    const response: UploadIntentItemDto[] = [];
    for (const entry of results) {
      if (!("result" in entry)) {
        response.push(failedItem(entry.input.idempotency_key, entry.error));
        continue;
      }
      if (entry.result.kind === "intent") {
        try {
          response.push({
            session_id: entry.result.intent.session_id,
            candidate_image_id: entry.result.intent.candidate_image_id,
            resolved_image_time: entry.result.intent.resolved_image_time,
            request_hash: entry.result.intent.request_hash,
            credential: this.#credential(entry.result.intent, now),
            expires_at: entry.result.intent.expires_at,
            status: "intent"
          });
        } catch (error) {
          response.push(failedItem(entry.input.idempotency_key, error));
        }
        continue;
      }
      response.push(await this.#canonicalResult(
        entry.input.idempotency_key,
        entry.result.session,
        committed,
        lookupError,
        now
      ));
    }
    return response;
  }

  async acceptImportItems(
    owner: string,
    items: readonly ImportItemInputDto[],
    now = Date.now()
  ): Promise<ImportAcceptItemDto[]> {
    const runtime = getRuntimeConfig();
    if (items.length > runtime.import.max_items) {
      throw new ApiError(
        400,
        "import_batch_limit_exceeded",
        `单批最多允许 ${runtime.import.max_items} 张导入图片`
      );
    }
    const accepted = await this.#dependencies.withStorageReadLock(async (signal) => {
      const results: Array<SettledItem<
        ImportItemInputDto,
        StoredIngestionSession
      >> = [];
      for (const item of items) {
        signal.throwIfAborted();
        try {
          const storageSlug = await this.#dependencies.resolveStorageSlug(
            item.storage_slug
          );
          await this.#dependencies.assertStorageWriteTarget(storageSlug);
          const explicitTime = providedImageTime(item.image_time, item.batch_time);
          const resolvedTime = normalizedImageTime(
            item.image_time,
            item.batch_time,
            new Date(now)
          );
          const sessionId = createIngestionSessionId(
            owner,
            "import",
            item.idempotency_key
          );
          const metadata = canonicalImportMetadata(
            runtime,
            item.source_type,
            item.download_url,
            draftMetadata(item)
          );
          const requestHash = ingestionIntentRequestHash({
            queue: "import",
            source_type: item.source_type,
            batch_key: item.batch_key,
            provided_image_time: explicitTime,
            batch_position: item.batch_position,
            import_download: { url: item.download_url },
            metadata: draftMetadata(item),
            storage_slug: storageSlug,
            expected_size: null,
            max_long_edge: null
          });
          const imageId = createImageId(
            resolvedTime.date,
            item.batch_position
          );
          const template = withSessionSemanticHash({
            owner,
            queue: "import",
            source_type: item.source_type,
            batch_position: item.batch_position,
            manifest_line: item.manifest_line,
            session_id: sessionId,
            image_id: imageId,
            image_time: resolvedTime.iso,
            request_hash: requestHash,
            import_download: { url: item.download_url },
            metadata,
            storage_slug: storageSlug,
            status: "queued",
            phase: "queued",
            message: "等待服务器下载",
            progress: null,
            version: 0,
            progress_seq: 0,
            last_semantic_revision: 0,
            accepted_at: 0,
            accepted_order: 0,
            execution_token: "",
            raw_generation: "",
            raw_size: 0,
            discard_at: now
              + appConfig.ingestionRuntime.importSessionIdleTtlSeconds * 1000
          });
          results.push({
            input: item,
            result: (await this.repository.acceptImportSession(
              template,
              createIngestionDisplayOrderKey(
                item.batch_key,
                item.batch_position,
                sessionId
              ),
              now
            )).session
          });
        } catch (error) {
          if (signal.aborted) throw error;
          results.push({ input: item, error });
        }
      }
      return results;
    });

    const canonicalIds = accepted.flatMap((entry) => (
      "result" in entry ? [entry.result.image_id] : []
    ));
    let committed = new Map<string, CommittedIngestionResult>();
    let lookupError: unknown = null;
    try {
      committed = await this.#dependencies.readCommitted(canonicalIds);
    } catch (error) {
      lookupError = error;
    }
    const response: ImportAcceptItemDto[] = [];
    for (const entry of accepted) {
      if (!("result" in entry)) {
        response.push(failedItem(entry.input.idempotency_key, entry.error));
        continue;
      }
      response.push(await this.#canonicalResult(
        entry.input.idempotency_key,
        entry.result,
        committed,
        lookupError,
        now
      ));
    }
    return response;
  }

  uploadReceivedTemplate(
    intent: UploadIntentSnapshot,
    rawGeneration: string,
    rawSize: number,
    now = Date.now()
  ) {
    assertImageIdentity(
      intent.candidate_image_id,
      intent.resolved_image_time,
      intent.batch_position
    );
    return withSessionSemanticHash({
      owner: intent.owner,
      queue: "upload",
      source_type: "upload",
      batch_position: intent.batch_position,
      session_id: intent.session_id,
      image_id: intent.candidate_image_id,
      image_time: intent.resolved_image_time,
      request_hash: intent.request_hash,
      metadata: intent.metadata,
      storage_slug: intent.storage_slug,
      status: "received",
      phase: "prepare-waiting",
      message: "上传已接收，等待图片处理许可",
      progress: 100,
      version: 0,
      progress_seq: 0,
      last_semantic_revision: 0,
      accepted_at: 0,
      accepted_order: 0,
      execution_token: "",
      raw_generation: rawGeneration,
      raw_size: rawSize,
      discard_at: now
        + appConfig.ingestionRuntime.uploadSessionIdleTtlSeconds * 1000
    });
  }

  newExecutionToken() {
    return randomUuidV7();
  }
}
