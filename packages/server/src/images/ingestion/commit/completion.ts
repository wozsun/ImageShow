import type { AdminImageListItemDto } from "@imageshow/shared/browser";
import { ApiError } from "../../../core/api-error.ts";
import {
  completedIngestionDisplay,
  type CompletedIngestionReceipt,
  type IngestionSessionSnapshot
} from "../sessions/model.ts";
import { IngestionSessionRepository } from "../repository.ts";

export function completedIngestionReceipt(
  session: IngestionSessionSnapshot,
  completedAt: number
): CompletedIngestionReceipt {
  if (!session.commit) {
    throw new ApiError(
      409,
      "import_commit_intent_missing",
      "内容接入任务缺少已冻结的提交意图"
    );
  }
  const display = completedIngestionDisplay(session);
  return {
    owner: session.owner,
    queue: session.queue,
    session_id: session.session_id,
    image_id: session.image_id,
    request_hash: session.request_hash,
    commit_request_id: session.commit.commit_request_id,
    commit_intent_hash: session.commit.commit_intent_hash,
    status: "completed",
    version: session.version,
    last_semantic_revision: session.last_semantic_revision,
    accepted_at: session.accepted_at,
    accepted_order: session.accepted_order,
    completed_at: completedAt,
    ...(display ? { display } : {}),
    discard_at: session.discard_at
  };
}

export async function publishCompletedReceipt(
  repository: IngestionSessionRepository,
  session: IngestionSessionSnapshot,
  completedAt: number,
  completedItem?: AdminImageListItemDto
) {
  const current = await repository.readSession(session.owner, session.session_id);
  if (!current || current.image_id !== session.image_id) return;
  if (current.status === "completed") return;
  if (current.status === "discarded") return;
  if (current.status !== "committing" && current.status !== "resolving") return;
  if (!("commit" in current) || !current.commit) return;
  const receipt = completedIngestionReceipt(current, completedAt);
  await repository.mutateSemantic(
    current,
    current.version,
    receipt,
    Date.now(),
    { completedItem }
  );
}
