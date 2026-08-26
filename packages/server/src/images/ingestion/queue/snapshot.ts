import { appConfig } from "@imageshow/shared";
import type {
  CompletedServerIngestionItemDto,
  IngestionQueueSnapshotDto,
  ServerIngestionItemDto
} from "@imageshow/shared/browser";
import { ApiError } from "../../../core/api-error.ts";
import { requireOperationalRedis } from "../../../core/runtime-availability.ts";
import type { AdminSession } from "../../../users/admin-session.ts";
import {
  committedIngestionResultForOwner,
  readCommittedIngestionResultsByImageIds
} from "../../read-models/ingestion-results.ts";
import {
  requireIngestionActionScope,
  signIngestionActionWatermark
} from "./action-scope.ts";
import type {
  CompletedIngestionReceipt,
  IngestionQueueType,
  IngestionSessionPair,
  StoredIngestionSession
} from "../sessions/model.ts";
import { IngestionSessionRepository } from "../repository.ts";
import { presentIngestionQueueSummary } from "../sessions/projection.ts";
import { presentIngestionSession } from "./session-view.ts";
import type { IngestionTokenService } from "../sessions/token-service.ts";

function snapshotRetryRequired() {
  return new ApiError(
    409,
    "import_snapshot_retry_required",
    "内容接入队列在读取期间发生变化，请重试"
  );
}

function completedItem(
  receipt: CompletedIngestionReceipt,
  item: CompletedServerIngestionItemDto["completed_item"]
): CompletedServerIngestionItemDto {
  return {
    session_id: receipt.session_id,
    image_id: receipt.image_id,
    queue: receipt.queue,
    status: "completed",
    version: receipt.version,
    progress_seq: 0,
    last_semantic_revision: receipt.last_semantic_revision,
    accepted_at: receipt.accepted_at,
    accepted_order: receipt.accepted_order,
    completed_at: receipt.completed_at,
    ...(receipt.display ? { display: receipt.display } : {}),
    completed_item: item
  };
}

function completedReceipts(items: readonly StoredIngestionSession[]) {
  return items.filter((item): item is CompletedIngestionReceipt => (
    item.status === "completed"
  ));
}

/**
 * Form one stable Redis page, hydrate completed receipts in one PostgreSQL
 * query, and retry only after atomically deleting confirmed stale receipts.
 */
export async function readStableIngestionQueueSnapshot(input: Readonly<{
  repository: IngestionSessionRepository;
  tokens: IngestionTokenService;
  session: Pick<AdminSession, "id" | "username">;
  actionScope: string;
  queue: IngestionQueueType;
  offset: number;
  limit: number;
  excludeItems?: readonly IngestionSessionPair[];
  includeItems?: readonly IngestionSessionPair[];
}>): Promise<IngestionQueueSnapshotDto> {
  const scopeInput = {
    id: input.actionScope,
    sessionId: input.session.id,
    owner: input.session.username,
    queue: input.queue
  };
  requireIngestionActionScope(scopeInput);
  await requireOperationalRedis();
  let staleRemoved = 0;

  for (;;) {
    const snapshot = await input.repository.snapshot(
      input.session.username,
      input.queue,
      input.offset,
      input.limit,
      {
        excludeItems: input.excludeItems ?? [],
        includeItems: input.includeItems ?? []
      }
    );
    const receipts = completedReceipts(snapshot.items);
    let committed: Awaited<
      ReturnType<typeof readCommittedIngestionResultsByImageIds>
    >;
    try {
      committed = await readCommittedIngestionResultsByImageIds(
        receipts.map((receipt) => receipt.image_id)
      );
    } catch (error) {
      throw new ApiError(
        503,
        "database_unavailable",
        "PostgreSQL unavailable",
        { dependency: "postgresql" }
      );
    }
    const stale = receipts.filter((receipt) => !committedIngestionResultForOwner(
      committed,
      receipt.image_id,
      input.session.username
    ));
    if (stale.length) {
      if (
        staleRemoved + stale.length
          > appConfig.ingestionRuntime.snapshotStaleReceiptCleanupBudget
      ) throw snapshotRetryRequired();
      const cleanup = await input.repository.deleteStaleCompletedReceipts(
        input.session.username,
        input.queue,
        stale
      );
      if (cleanup.removed < 1) throw snapshotRetryRequired();
      staleRemoved += cleanup.removed;
      continue;
    }

    await requireOperationalRedis();
    const scope = requireIngestionActionScope(scopeInput);
    const items = snapshot.items.map((stored): ServerIngestionItemDto => {
      if (stored.status === "completed") {
        const result = committedIngestionResultForOwner(
          committed,
          stored.image_id,
          input.session.username
        );
        if (!result) throw snapshotRetryRequired();
        return completedItem(stored, result.item);
      }
      if (stored.status === "discarded") throw snapshotRetryRequired();
      return presentIngestionSession(stored);
    });
    const metadata = snapshot.metadata;
    return {
      queue: input.queue,
      revision: metadata.revision,
      last_accepted_order: metadata.last_accepted_order,
      ...presentIngestionQueueSummary(metadata),
      offset: snapshot.offset,
      limit: snapshot.limit,
      items,
      stale_items: snapshot.staleItems,
      action_watermark: signIngestionActionWatermark(
        scope,
        metadata,
        input.tokens
      )
    };
  }
}
