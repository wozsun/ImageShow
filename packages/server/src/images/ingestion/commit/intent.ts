import type {
  AdminImageListItemDto,
  ImageDraftDto,
  IngestionCommitItemInputDto,
  IngestionCommitItemResultDto
} from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../../../config/runtime-config-store.ts";
import { ApiError } from "../../../core/api-error.ts";
import { mapWithWorkerPool } from "../../../core/concurrency.ts";
import { randomUuidV7 } from "../../../core/uuid.ts";
import { storageObjectKey } from "../../../storage/objects/image-paths.ts";
import { resolveClassification } from "../../classification.ts";
import {
  committedIngestionResultForOwner,
  readCommittedIngestionResultsByImageIds
} from "../../read-models/ingestion-results.ts";
import { readDuplicateSnapshotsByMd5 } from "../../read-models/duplicates.ts";
import { canonicalImportMetadata } from "../sessions/import-metadata.ts";
import { ingestionSessionWithDuplicateConflict } from "./conflict-recovery.ts";
import type {
  IngestionSessionSnapshot,
  StoredIngestionSession
} from "../sessions/model.ts";
import {
  ingestionSessionSemanticHash,
  semanticIngestionSessionHash
} from "../sessions/projection.ts";
import {
  ingestionSessionIncarnationMismatch,
  IngestionSessionRepository
} from "../repository.ts";

const COMMIT_INTENT_WORKER_COUNT = 10;

function commitIntentHash(
  session: IngestionSessionSnapshot,
  input: IngestionCommitItemInputDto
) {
  return semanticIngestionSessionHash({
    commit_request_id: input.commit_request_id,
    expected_md5: input.expected_md5,
    duplicate_decision: input.duplicate_decision,
    metadata: input.metadata,
    storage_slug: session.storage_slug,
    prepared_generation: session.prepared?.generation ?? ""
  });
}

function commitMetadata(
  session: IngestionSessionSnapshot,
  metadata: ImageDraftDto,
  runtime: ReturnType<typeof getRuntimeConfig>
): ImageDraftDto {
  if (
    session.queue !== "import"
    || session.source_type === "upload"
    || !session.import_download
  ) return metadata;
  if (session.commit) {
    // Controlled Import fields are no longer caller intent after the first
    // commit freeze. Reuse them across retries and later config reloads.
    return {
      ...metadata,
      original: session.commit.metadata.original,
      source: session.source_type === "weibo"
        ? session.commit.metadata.source
        : metadata.source
    };
  }
  return canonicalImportMetadata(
    runtime,
    session.source_type,
    session.import_download.url,
    metadata
  );
}

function failedResult(
  pair: Pick<IngestionCommitItemInputDto, "session_id" | "image_id">,
  error: unknown,
  version?: number
): IngestionCommitItemResultDto {
  if (error instanceof ApiError) {
    const details = error.code === "ingestion_duplicate_conflict"
      ? error.details as {
          duplicates?: AdminImageListItemDto[];
          duplicate_count?: number;
        }
      : undefined;
    return {
      ...pair,
      status: "failed",
      code: error.code,
      message: error.message,
      ...(version ? { version } : {}),
      ...(details?.duplicate_count
        ? { duplicate_count: details.duplicate_count }
        : {}),
      ...(details?.duplicates ? { duplicates: details.duplicates } : {})
    };
  }
  return {
    ...pair,
    status: "failed",
    code: "ingestion_commit_failed",
    message: "Ingestion commit could not be accepted"
  };
}

function assertDuplicateDecision(
  imageId: string,
  snapshot: Awaited<ReturnType<typeof readDuplicateSnapshotsByMd5>> extends Map<
    string,
    infer Snapshot
  > ? Snapshot : never,
  decision: IngestionCommitItemInputDto["duplicate_decision"]
) {
  const ownVisible = snapshot.items.some(
    (item) => item.id.toLowerCase() === imageId.toLowerCase()
  );
  const duplicates = snapshot.items.filter(
    (item) => item.id.toLowerCase() !== imageId.toLowerCase()
  );
  if (duplicates.length && decision !== "confirmed") {
    const duplicateCount = Math.max(
      duplicates.length,
      snapshot.matchCount - (ownVisible ? 1 : 0)
    );
    throw new ApiError(
      409,
      "ingestion_duplicate_conflict",
      "提交前发现相同内容图片，请确认是否仍然提交",
      { duplicates, duplicate_count: duplicateCount }
    );
  }
}

async function publishDuplicateConflict(
  repository: IngestionSessionRepository,
  stored: StoredIngestionSession | typeof ingestionSessionIncarnationMismatch | null,
  error: unknown
) {
  if (
    !(error instanceof ApiError)
    || error.code !== "ingestion_duplicate_conflict"
    || !stored
    || stored === ingestionSessionIncarnationMismatch
    || stored.status !== "ready"
    || !stored.prepared
    || stored.commit
  ) return undefined;
  const duplicateCount = Number((error.details as {
    duplicate_count?: unknown;
  })?.duplicate_count);
  if (!Number.isSafeInteger(duplicateCount) || duplicateCount < 1) {
    return undefined;
  }
  try {
    const updated = await repository.mutateSemantic(
      stored,
      stored.version,
      ingestionSessionWithDuplicateConflict(stored, duplicateCount)
    );
    return updated.session.version;
  } catch {
    // The duplicate result remains safe to return. A concurrent semantic
    // change or Redis outage is reconciled by the caller's bounded refresh.
    return undefined;
  }
}

async function convergeCommitVersionConflict(
  repository: IngestionSessionRepository,
  owner: string,
  input: IngestionCommitItemInputDto,
  intentHash: string,
  runtime: ReturnType<typeof getRuntimeConfig>,
  error: unknown
): Promise<IngestionCommitItemResultDto> {
  if (!(error instanceof ApiError) || error.code !== "ingestion_version_conflict") {
    throw error;
  }

  const [current] = await repository.readSessions(owner, [input]);
  const committed = await readCommittedIngestionResultsByImageIds([input.image_id]);
  const pair = {
    session_id: input.session_id,
    image_id: input.image_id
  };
  const committedResult = committedIngestionResultForOwner(
    committed,
    input.image_id,
    owner
  );
  if (committedResult) {
    return {
      ...pair,
      status: "completed",
      version: current && current !== ingestionSessionIncarnationMismatch
        ? current.version
        : 1,
      completed_item: committedResult.item
    };
  }
  if (current === ingestionSessionIncarnationMismatch) {
    throw new ApiError(
      409,
      "ingestion_incarnation_conflict",
      "内容接入任务身份已被替换"
    );
  }
  if (!current) {
    throw new ApiError(410, "ingestion_session_missing", "未完成内容接入已过期或被服务器丢弃");
  }
  if (current.status === "completed") {
    throw new ApiError(
      503,
      "ingestion_result_unknown",
      "Redis 完成回执缺少 PostgreSQL 正式图片"
    );
  }
  if (current.status === "discarded") {
    throw new ApiError(409, "ingestion_discarded", "内容接入任务已取消");
  }
  const convergedIntentHash = current.commit
    ? commitIntentHash(current, {
        ...input,
        metadata: commitMetadata(current, input.metadata, runtime)
      })
    : intentHash;
  if (
    current.commit?.commit_request_id === input.commit_request_id
    && current.commit.commit_intent_hash === convergedIntentHash
    && (
      current.status === "committing"
      || current.status === "resolving"
      || current.status === "failed"
    )
  ) {
    return {
      ...pair,
      status: "accepted",
      version: current.version
    };
  }
  if (current.commit?.commit_request_id === input.commit_request_id) {
    throw new ApiError(
      409,
      "ingestion_commit_intent_conflict",
      "同一 commit_request_id 已用于不同提交意图"
    );
  }
  if (current.commit) {
    throw new ApiError(
      409,
      "ingestion_already_finalizing",
      "内容接入任务的提交意图已经冻结"
    );
  }
  throw error;
}

export async function acceptIngestionCommitIntents(
  repository: IngestionSessionRepository,
  owner: string,
  items: readonly IngestionCommitItemInputDto[]
) {
  const runtime = getRuntimeConfig();
  const committed = await readCommittedIngestionResultsByImageIds(
    items.map((item) => item.image_id)
  );
  const sessions = await repository.readSessions(owner, items);
  const duplicateSnapshots = await readDuplicateSnapshotsByMd5([
    ...new Set(sessions.flatMap((stored) => (
      stored
      && stored !== ingestionSessionIncarnationMismatch
      && stored.status === "ready"
      && "prepared" in stored
      && stored.prepared
        ? [stored.prepared.md5]
        : []
    )))
  ]);
  return mapWithWorkerPool(
    items,
    COMMIT_INTENT_WORKER_COUNT,
    async (input, index): Promise<IngestionCommitItemResultDto> => {
      const pair = {
        session_id: input.session_id,
        image_id: input.image_id
      };
      const stored = sessions[index];
      try {
        const committedResult = committedIngestionResultForOwner(
          committed,
          input.image_id,
          owner
        );
        if (committedResult) {
          return {
            ...pair,
            status: "completed",
            version: stored && stored !== ingestionSessionIncarnationMismatch
              ? stored.version
              : 1,
            completed_item: committedResult.item
          };
        }
        if (stored === ingestionSessionIncarnationMismatch) {
          throw new ApiError(
            409,
            "ingestion_incarnation_conflict",
            "内容接入任务身份已被替换"
          );
        }
        if (!stored) {
          throw new ApiError(410, "ingestion_session_missing", "未完成内容接入已过期或被服务器丢弃");
        }
        if (stored.status === "completed") {
          throw new ApiError(
            503,
            "ingestion_result_unknown",
            "Redis 完成回执缺少 PostgreSQL 正式图片"
          );
        }
        if (stored.status === "discarded") {
          throw new ApiError(409, "ingestion_discarded", "内容接入任务已取消");
        }
        if (!("prepared" in stored) || !stored.prepared) {
          throw new ApiError(409, "invalid_ingestion_state", "图片尚未准备完成");
        }
        const metadata = commitMetadata(stored, input.metadata, runtime);
        const canonicalInput = { ...input, metadata };
        const intentHash = commitIntentHash(stored, canonicalInput);
        if (
          stored.status === "committing"
          || stored.status === "resolving"
          || (stored.status === "failed" && stored.commit)
        ) {
          if (
            stored.commit?.commit_request_id === input.commit_request_id
            && stored.commit.commit_intent_hash === intentHash
          ) {
            if (stored.status === "failed") {
              if (stored.version !== input.expected_version) {
                throw new ApiError(
                  409,
                  "ingestion_version_conflict",
                  "内容接入任务版本已变化"
                );
              }
              const retryWithoutHash = {
                ...stored,
                status: "committing" as const,
                phase: "committing",
                message: "提交重试已受理，等待写入图片库",
                progress: null,
                execution_token: randomUuidV7(),
                error: undefined,
                semantic_hash: ""
              };
              try {
                const retried = await repository.mutateSemantic(
                  stored,
                  stored.version,
                  {
                    ...retryWithoutHash,
                    semantic_hash: ingestionSessionSemanticHash(retryWithoutHash)
                  }
                );
                return {
                  ...pair,
                  status: "accepted",
                  version: retried.session.version
                };
              } catch (error) {
                return await convergeCommitVersionConflict(
                  repository,
                  owner,
                  input,
                  intentHash,
                  runtime,
                  error
                );
              }
            }
            return {
              ...pair,
              status: "accepted",
              version: stored.version
            };
          }
          if (stored.commit?.commit_request_id === input.commit_request_id) {
            throw new ApiError(
              409,
              "ingestion_commit_intent_conflict",
              "同一 commit_request_id 已用于不同提交意图"
            );
          }
          throw new ApiError(
            409,
            "ingestion_already_finalizing",
            "内容接入任务的提交意图已经冻结"
          );
        }
        if (stored.status !== "ready") {
          throw new ApiError(409, "invalid_ingestion_state", "图片尚未准备完成");
        }
        if (stored.version !== input.expected_version) {
          throw new ApiError(409, "ingestion_version_conflict", "内容接入任务版本已变化");
        }
        if (stored.prepared.md5 !== input.expected_md5) {
          throw new ApiError(
            409,
            "ingestion_prepared_content_changed",
            "准备提交的图片内容已变化，请重新处理"
          );
        }
        assertDuplicateDecision(
          stored.image_id,
          duplicateSnapshots.get(stored.prepared.md5)!,
          input.duplicate_decision
        );
        const classification = resolveClassification(metadata, {
          device: stored.prepared.detected_device,
          brightness: stored.prepared.detected_brightness
        });
        const finalObjectKey = storageObjectKey(
          classification.device,
          classification.brightness,
          metadata.theme,
          stored.image_id,
          stored.prepared.ext
        );
        const executionToken = randomUuidV7();
        const nextWithoutHash = {
          ...stored,
          metadata,
          duplicate_decision: input.duplicate_decision,
          status: "committing" as const,
          phase: "committing",
          message: "提交已受理，等待写入图片库",
          progress: null,
          execution_token: executionToken,
          commit: {
            commit_request_id: input.commit_request_id,
            commit_intent_hash: intentHash,
            created_by: owner,
            expected_md5: input.expected_md5,
            duplicate_decision: input.duplicate_decision,
            metadata,
            final_object_key: finalObjectKey
          },
          error: undefined,
          semantic_hash: ""
        };
        const next = {
          ...nextWithoutHash,
          semantic_hash: ingestionSessionSemanticHash(nextWithoutHash)
        };
        try {
          const accepted = await repository.mutateSemantic(
            stored,
            stored.version,
            next
          );
          return {
            ...pair,
            status: "accepted",
            version: accepted.session.version
          };
        } catch (error) {
          return await convergeCommitVersionConflict(
            repository,
            owner,
            input,
            intentHash,
            runtime,
            error
          );
        }
      } catch (error) {
        return failedResult(
          pair,
          error,
          await publishDuplicateConflict(repository, stored, error)
        );
      }
    }
  );
}
