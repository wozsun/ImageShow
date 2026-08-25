import { appConfig } from "@imageshow/shared";
import type {
  CompletedServerImportItemDto,
  ImportQueueSnapshotDto,
  ServerImportItemDto
} from "@imageshow/shared/browser";
import { ApiError } from "../../core/api-error.ts";
import { requireOperationalRedis } from "../../core/runtime-availability.ts";
import type { AdminSession } from "../../users/admin-session.ts";
import {
  committedImportResultForOwner,
  readCommittedImportResultsByImageIds
} from "../read-models/import-results.ts";
import {
  requireImportActionScope,
  signImportActionWatermark
} from "./action-scope.ts";
import type {
  CompletedImportReceipt,
  ImportQueueType,
  ImportSessionPair,
  StoredImportSession
} from "./session-model.ts";
import { ImportSessionRepository } from "./session-repository.ts";
import { presentImportQueueSummary } from "./session-projection.ts";
import { presentImportSession } from "./session-view.ts";
import type { ImportTokenService } from "./token-service.ts";

function snapshotRetryRequired() {
  return new ApiError(
    409,
    "import_snapshot_retry_required",
    "导入队列在读取期间发生变化，请重试"
  );
}

function completedItem(
  receipt: CompletedImportReceipt,
  item: CompletedServerImportItemDto["completed_item"]
): CompletedServerImportItemDto {
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

function completedReceipts(items: readonly StoredImportSession[]) {
  return items.filter((item): item is CompletedImportReceipt => (
    item.status === "completed"
  ));
}

/**
 * Form one stable Redis page, hydrate completed receipts in one PostgreSQL
 * query, and retry only after atomically deleting confirmed stale receipts.
 */
export async function readStableImportQueueSnapshot(input: Readonly<{
  repository: ImportSessionRepository;
  tokens: ImportTokenService;
  session: Pick<AdminSession, "id" | "username">;
  actionScope: string;
  queue: ImportQueueType;
  offset: number;
  limit: number;
  excludeItems?: readonly ImportSessionPair[];
  includeItems?: readonly ImportSessionPair[];
}>): Promise<ImportQueueSnapshotDto> {
  const scopeInput = {
    id: input.actionScope,
    sessionId: input.session.id,
    owner: input.session.username,
    queue: input.queue
  };
  requireImportActionScope(scopeInput);
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
      ReturnType<typeof readCommittedImportResultsByImageIds>
    >;
    try {
      committed = await readCommittedImportResultsByImageIds(
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
    const stale = receipts.filter((receipt) => !committedImportResultForOwner(
      committed,
      receipt.image_id,
      input.session.username
    ));
    if (stale.length) {
      if (
        staleRemoved + stale.length
          > appConfig.importRuntime.snapshotStaleReceiptCleanupBudget
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
    const scope = requireImportActionScope(scopeInput);
    const items = snapshot.items.map((stored): ServerImportItemDto => {
      if (stored.status === "completed") {
        const result = committedImportResultForOwner(
          committed,
          stored.image_id,
          input.session.username
        );
        if (!result) throw snapshotRetryRequired();
        return completedItem(stored, result.item);
      }
      if (stored.status === "discarded") throw snapshotRetryRequired();
      return presentImportSession(stored);
    });
    const metadata = snapshot.metadata;
    return {
      queue: input.queue,
      revision: metadata.revision,
      last_accepted_order: metadata.last_accepted_order,
      ...presentImportQueueSummary(metadata),
      offset: snapshot.offset,
      limit: snapshot.limit,
      items,
      stale_items: snapshot.staleItems,
      action_watermark: signImportActionWatermark(
        scope,
        metadata,
        input.tokens
      )
    };
  }
}
