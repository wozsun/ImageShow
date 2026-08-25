import type {
  ImportSessionUpdateItemDto,
  ImportSessionUpdateItemResultDto
} from "@imageshow/shared/browser";
import { ApiError } from "../../core/api-error.ts";
import { mapWithWorkerPool } from "../../core/concurrency.ts";
import { readDuplicateMatchCountsByMd5 } from "../read-models/duplicates.ts";
import {
  importSessionIncarnationMismatch,
  type ImportSessionRepository
} from "./session-repository.ts";
import type { ImportSessionSnapshot } from "./session-model.ts";
import { semanticImportSession } from "./session-transitions.ts";

function failure(
  pair: Pick<ImportSessionUpdateItemDto, "session_id" | "image_id">,
  error: unknown
): ImportSessionUpdateItemResultDto {
  return {
    ...pair,
    status: "failed",
    code: error instanceof ApiError ? error.code : "import_update_failed",
    message: error instanceof Error ? error.message : "导入任务更新失败"
  };
}

export async function updateImportSessions(
  repository: ImportSessionRepository,
  owner: string,
  items: readonly ImportSessionUpdateItemDto[]
) {
  const sessions = await repository.readSessions(owner, items);
  const decisionMd5Set = new Set<string>();
  items.forEach((item, index) => {
    const session = sessions[index];
    if (item.duplicate_decision
      && session !== importSessionIncarnationMismatch
      && session
      && session.status !== "completed"
      && session.status !== "discarded"
      && session.prepared) {
      decisionMd5Set.add(session.prepared.md5);
    }
  });
  const decisionMd5s = [...decisionMd5Set];
  const duplicateCounts = await readDuplicateMatchCountsByMd5(decisionMd5s);
  return mapWithWorkerPool(
    items,
    10,
    async (input, index): Promise<ImportSessionUpdateItemResultDto> => {
      const pair = {
        session_id: input.session_id,
        image_id: input.image_id
      };
      try {
        const current = sessions[index];
        if (current === importSessionIncarnationMismatch) {
          throw new ApiError(
            409,
            "import_incarnation_conflict",
            "导入任务身份已被替换"
          );
        }
        if (!current || current.status === "discarded") {
          throw new ApiError(
            410,
            "import_session_missing",
            "未完成导入已过期或被服务器丢弃"
          );
        }
        if (current.status === "completed") {
          throw new ApiError(409, "invalid_import_state", "图片已经提交完成");
        }
        if (current.commit) {
          throw new ApiError(409, "invalid_import_state", "当前导入任务不可编辑");
        }
        if (input.duplicate_decision && !current.prepared) {
          throw new ApiError(
            409,
            "invalid_import_state",
            "图片尚未准备完成，不能确认重复项"
          );
        }
        const metadata = input.metadata ?? current.metadata;
        const refreshedDuplicateCount = current.prepared
          ? input.duplicate_decision
            ? duplicateCounts.get(current.prepared.md5) ?? 0
            : current.prepared.duplicate_count
          : 0;
        const prepared = current.prepared
          ? refreshedDuplicateCount === current.prepared.duplicate_count
            ? current.prepared
            : {
                ...current.prepared,
                duplicate_count: refreshedDuplicateCount
              }
          : undefined;
        const duplicateDecision = input.duplicate_decision
          ? refreshedDuplicateCount > 0
            ? input.duplicate_decision
            : "upload"
          : current.duplicate_decision;
        const next = semanticImportSession(current, {
          metadata,
          duplicate_decision: duplicateDecision,
          ...(prepared ? { prepared } : {})
        });
        const updated = await repository.mutateSemantic(
          current,
          input.expected_version,
          next,
          Date.now(),
          { allowStaleSemanticNoOp: true }
        );
        const updatedSession = updated.session as ImportSessionSnapshot;
        return {
          ...pair,
          status: updated.changed ? "changed" : "unchanged",
          version: updatedSession.version,
          last_semantic_revision: updatedSession.last_semantic_revision,
          duplicate_count: updatedSession.prepared?.duplicate_count ?? 0,
          duplicate_decision: updatedSession.duplicate_decision ?? "upload"
        };
      } catch (error) {
        return failure(pair, error);
      }
    }
  );
}
