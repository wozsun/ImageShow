import type {
  AdminImageListItemDto,
  ImportCommitItemInputDto,
  ImportCommitItemResultDto
} from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { ApiError } from "../../core/api-error.ts";
import { mapWithWorkerPool } from "../../core/concurrency.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { storageObjectKey } from "../../storage/image-paths.ts";
import { resolveClassification } from "../classification.ts";
import {
  committedImportResultForOwner,
  readCommittedImportResultsByImageIds
} from "../read-models/import-results.ts";
import { readDuplicateSnapshotByMd5 } from "../read-models/duplicates.ts";
import { importSessionWithDuplicateConflict } from "./commit-conflict-recovery.ts";
import type {
  ImportSessionSnapshot,
  StoredImportSession
} from "./session-model.ts";
import {
  importSessionSemanticHash,
  semanticImportSessionHash
} from "./session-projection.ts";
import {
  importSessionIncarnationMismatch,
  ImportSessionRepository
} from "./session-repository.ts";

function commitIntentHash(
  session: ImportSessionSnapshot,
  input: ImportCommitItemInputDto
) {
  return semanticImportSessionHash({
    commit_request_id: input.commit_request_id,
    expected_md5: input.expected_md5,
    duplicate_decision: input.duplicate_decision,
    metadata: input.metadata,
    storage_slug: session.storage_slug,
    prepared_generation: session.prepared?.generation ?? ""
  });
}

function failedResult(
  pair: Pick<ImportCommitItemInputDto, "session_id" | "image_id">,
  error: unknown,
  version?: number
): ImportCommitItemResultDto {
  if (error instanceof ApiError) {
    const details = error.code === "import_duplicate_conflict"
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
    code: "import_commit_failed",
    message: "Image import could not be accepted"
  };
}

async function assertDuplicateDecision(
  imageId: string,
  md5: string,
  decision: ImportCommitItemInputDto["duplicate_decision"]
) {
  const snapshot = await readDuplicateSnapshotByMd5(md5);
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
      "import_duplicate_conflict",
      "提交前发现相同内容图片，请确认是否仍然提交",
      { duplicates, duplicate_count: duplicateCount }
    );
  }
}

async function publishDuplicateConflict(
  repository: ImportSessionRepository,
  stored: StoredImportSession | typeof importSessionIncarnationMismatch | null,
  error: unknown
) {
  if (
    !(error instanceof ApiError)
    || error.code !== "import_duplicate_conflict"
    || !stored
    || stored === importSessionIncarnationMismatch
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
      importSessionWithDuplicateConflict(stored, duplicateCount)
    );
    return updated.session.version;
  } catch {
    // The duplicate result remains safe to return. A concurrent semantic
    // change or Redis outage is reconciled by the caller's bounded refresh.
    return undefined;
  }
}

async function convergeCommitVersionConflict(
  repository: ImportSessionRepository,
  owner: string,
  input: ImportCommitItemInputDto,
  intentHash: string,
  error: unknown
): Promise<ImportCommitItemResultDto> {
  if (!(error instanceof ApiError) || error.code !== "import_version_conflict") {
    throw error;
  }

  const [current] = await repository.readSessions(owner, [input]);
  const committed = await readCommittedImportResultsByImageIds([input.image_id]);
  const pair = {
    session_id: input.session_id,
    image_id: input.image_id
  };
  const committedResult = committedImportResultForOwner(
    committed,
    input.image_id,
    owner
  );
  if (committedResult) {
    return {
      ...pair,
      status: "completed",
      version: current && current !== importSessionIncarnationMismatch
        ? current.version
        : 1,
      completed_item: committedResult.item
    };
  }
  if (current === importSessionIncarnationMismatch) {
    throw new ApiError(
      409,
      "import_incarnation_conflict",
      "导入任务身份已被替换"
    );
  }
  if (!current) {
    throw new ApiError(410, "import_session_missing", "未完成导入已过期或被服务器丢弃");
  }
  if (current.status === "completed") {
    throw new ApiError(
      503,
      "import_result_unknown",
      "Redis 完成回执缺少 PostgreSQL 正式图片"
    );
  }
  if (current.status === "discarded") {
    throw new ApiError(409, "import_discarded", "导入任务已取消");
  }
  if (
    current.commit?.commit_request_id === input.commit_request_id
    && current.commit.commit_intent_hash === intentHash
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
      "import_commit_intent_conflict",
      "同一 commit_request_id 已用于不同提交意图"
    );
  }
  if (current.commit) {
    throw new ApiError(
      409,
      "import_already_finalizing",
      "导入任务的提交意图已经冻结"
    );
  }
  throw error;
}

export async function acceptImportCommitIntents(
  repository: ImportSessionRepository,
  owner: string,
  items: readonly ImportCommitItemInputDto[]
) {
  const committed = await readCommittedImportResultsByImageIds(
    items.map((item) => item.image_id)
  );
  const sessions = await repository.readSessions(owner, items);
  return mapWithWorkerPool(
    items,
    Math.min(10, getRuntimeConfig().import.commit_concurrency),
    async (input, index): Promise<ImportCommitItemResultDto> => {
      const pair = {
        session_id: input.session_id,
        image_id: input.image_id
      };
      const stored = sessions[index];
      try {
        const committedResult = committedImportResultForOwner(
          committed,
          input.image_id,
          owner
        );
        if (committedResult) {
          return {
            ...pair,
            status: "completed",
            version: stored && stored !== importSessionIncarnationMismatch
              ? stored.version
              : 1,
            completed_item: committedResult.item
          };
        }
        if (stored === importSessionIncarnationMismatch) {
          throw new ApiError(
            409,
            "import_incarnation_conflict",
            "导入任务身份已被替换"
          );
        }
        if (!stored) {
          throw new ApiError(410, "import_session_missing", "未完成导入已过期或被服务器丢弃");
        }
        if (stored.status === "completed") {
          throw new ApiError(
            503,
            "import_result_unknown",
            "Redis 完成回执缺少 PostgreSQL 正式图片"
          );
        }
        if (stored.status === "discarded") {
          throw new ApiError(409, "import_discarded", "导入任务已取消");
        }
        if (!("prepared" in stored) || !stored.prepared) {
          throw new ApiError(409, "invalid_import_state", "图片尚未准备完成");
        }
        const intentHash = commitIntentHash(stored, input);
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
                  "import_version_conflict",
                  "导入任务版本已变化"
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
                    semantic_hash: importSessionSemanticHash(retryWithoutHash)
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
              "import_commit_intent_conflict",
              "同一 commit_request_id 已用于不同提交意图"
            );
          }
          throw new ApiError(
            409,
            "import_already_finalizing",
            "导入任务的提交意图已经冻结"
          );
        }
        if (stored.status !== "ready") {
          throw new ApiError(409, "invalid_import_state", "图片尚未准备完成");
        }
        if (stored.version !== input.expected_version) {
          throw new ApiError(409, "import_version_conflict", "导入任务版本已变化");
        }
        if (stored.prepared.md5 !== input.expected_md5) {
          throw new ApiError(
            409,
            "import_prepared_content_changed",
            "准备提交的图片内容已变化，请重新处理"
          );
        }
        await assertDuplicateDecision(
          stored.image_id,
          stored.prepared.md5,
          input.duplicate_decision
        );
        const classification = resolveClassification(input.metadata, {
          device: stored.prepared.detected_device,
          brightness: stored.prepared.detected_brightness
        });
        const finalObjectKey = storageObjectKey(
          classification.device,
          classification.brightness,
          input.metadata.theme,
          stored.image_id,
          stored.prepared.ext
        );
        const executionToken = randomUuidV7();
        const nextWithoutHash = {
          ...stored,
          metadata: input.metadata,
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
            metadata: input.metadata,
            final_object_key: finalObjectKey
          },
          error: undefined,
          semantic_hash: ""
        };
        const next = {
          ...nextWithoutHash,
          semantic_hash: importSessionSemanticHash(nextWithoutHash)
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
