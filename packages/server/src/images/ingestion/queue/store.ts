import { appConfig } from "@imageshow/shared";
import {
  metadataFromHashReply,
  parseStoredIngestionSession
} from "../sessions/codec.ts";
import {
  ingestionQueueStructureError,
  type IngestionSessionCommandRunner
} from "../sessions/command-runner.ts";
import {
  ingestionCanonicalKey,
  ingestionCanonicalKeyRoot,
  ingestionCanonicalKeyPrefix,
  ingestionDisplayQueueKey,
  ingestionDisplayQueueKeyRoot,
  ingestionExpiresKey,
  ingestionOwnerQueueKey,
  ingestionOwnerQueueKeyRoot,
  ingestionQueueMetadataKey,
  ingestionQueueMetadataKeyRoot,
  ingestionRunnableKey
} from "../sessions/keys.ts";
import type {
  CompletedIngestionReceipt,
  IngestionQueueSnapshot,
  IngestionQueueType,
  IngestionSessionPair
} from "../sessions/model.ts";
import {
  defaultQueueMetadata,
  parseMetadataJson,
  redisReplyArray,
  redisReplyInteger,
  redisReplyString
} from "../sessions/replies.ts";

export async function readIngestionQueueSnapshot(
  run: IngestionSessionCommandRunner,
  owner: string,
  queue: IngestionQueueType,
  offset: number,
  limit: number,
  options: Readonly<{
    excludeItems?: readonly IngestionSessionPair[];
    includeItems?: readonly IngestionSessionPair[];
  }> = {}
): Promise<IngestionQueueSnapshot> {
  const excludeItems = options.excludeItems ?? [];
  const includeItems = options.includeItems ?? [];
  if (
    !Number.isSafeInteger(offset)
    || offset < 0
    || !Number.isSafeInteger(limit)
    || limit < 0
    || limit > appConfig.ingestionRuntime.snapshotMaxItems
    || excludeItems.length > appConfig.ingestion.batchHardLimit
    || includeItems.length > appConfig.ingestionRuntime.snapshotMaxItems
    || limit + includeItems.length > appConfig.ingestionRuntime.snapshotMaxItems
  ) {
    throw new RangeError("Redis ingestion snapshot range is invalid");
  }
  const raw = await run(
    "imageshowReadIngestionQueueSnapshot",
    ingestionOwnerQueueKey(owner, queue),
    ingestionDisplayQueueKey(owner, queue),
    ingestionQueueMetadataKey(owner, queue),
    ingestionRunnableKey,
    ingestionExpiresKey,
    offset,
    limit,
    ingestionCanonicalKeyPrefix(owner),
    owner,
    queue,
    appConfig.ingestionRuntime.snapshotMaxItems,
    JSON.stringify(excludeItems),
    JSON.stringify(includeItems),
    appConfig.ingestion.batchHardLimit
  );
  const reply = redisReplyArray(raw, "queue snapshot");
  const status = redisReplyInteger(reply[0], "queue snapshot status");
  if (status === 0) {
    return {
      metadata: defaultQueueMetadata(owner, queue),
      offset,
      limit,
      items: [],
      staleItems: [...excludeItems]
    };
  }
  if (status !== 1) {
    throw new Error("Redis ingestion snapshot returned an unknown status");
  }
  const metadataLength = redisReplyInteger(reply[1], "queue metadata length");
  if (metadataLength < 0 || metadataLength % 2 !== 0) {
    throw new Error("Redis ingestion snapshot returned invalid metadata length");
  }
  const metadataEnd = 2 + metadataLength;
  const metadata = metadataFromHashReply(reply.slice(2, metadataEnd));
  const itemCount = redisReplyInteger(
    reply[metadataEnd],
    "queue snapshot item count"
  );
  const itemStart = metadataEnd + 1;
  const itemEnd = itemStart + itemCount;
  const serialized = reply.slice(itemStart, itemEnd);
  const staleCount = redisReplyInteger(
    reply[itemEnd],
    "queue snapshot stale item count"
  );
  const staleValues = reply.slice(itemEnd + 1);
  if (
    itemCount < 0
    || serialized.length !== itemCount
    || staleCount < 0
    || staleValues.length !== staleCount * 2
  ) {
    throw new Error("Redis ingestion snapshot returned an invalid item count");
  }
  return {
    metadata,
    offset,
    limit,
    items: serialized.map((item) => parseStoredIngestionSession(
      redisReplyString(item, "queue snapshot item")
    )),
    staleItems: Array.from({ length: staleCount }, (_value, index) => ({
      session_id: redisReplyString(
        staleValues[index * 2],
        "queue snapshot stale session id"
      ),
      image_id: redisReplyString(
        staleValues[index * 2 + 1],
        "queue snapshot stale image id"
      )
    }))
  };
}

export async function scanIngestionQueueAction(
  run: IngestionSessionCommandRunner,
  owner: string,
  queue: IngestionQueueType,
  maximumOrder: number,
  cursor: number,
  limit = appConfig.ingestionRuntime.queueActionBatchSize
) {
  if (
    !Number.isSafeInteger(maximumOrder)
    || maximumOrder < 0
    || !Number.isSafeInteger(cursor)
    || cursor < 0
    || cursor > maximumOrder
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > appConfig.ingestionRuntime.queueActionBatchSize
  ) throw new RangeError("Redis ingestion action scan range is invalid");
  const raw = await run(
    "imageshowScanIngestionQueueAction",
    ingestionOwnerQueueKey(owner, queue),
    ingestionDisplayQueueKey(owner, queue),
    ingestionQueueMetadataKey(owner, queue),
    ingestionRunnableKey,
    ingestionExpiresKey,
    maximumOrder,
    cursor,
    limit,
    ingestionCanonicalKeyPrefix(owner),
    owner,
    queue,
    appConfig.ingestionRuntime.queueActionBatchSize
  );
  const reply = redisReplyArray(raw, "queue action scan");
  const status = redisReplyInteger(reply[0], "queue action scan status");
  if (status === 0) return { items: [], nextCursor: null };
  if (status !== 1 || reply.length < 4) {
    throw new Error("Redis ingestion action scan returned an invalid shape");
  }
  const count = redisReplyInteger(reply[1], "queue action scan count");
  const hasMore = redisReplyInteger(
    reply[2],
    "queue action scan continuation"
  );
  const nextCursor = redisReplyInteger(reply[3], "queue action scan cursor");
  const serialized = reply.slice(4);
  if (
    count < 0
    || count > limit
    || serialized.length !== count
    || (hasMore !== 0 && hasMore !== 1)
    || (hasMore === 0 && nextCursor !== 0)
    || (hasMore === 1 && (nextCursor < 1 || nextCursor >= cursor))
  ) {
    throw new Error("Redis ingestion action scan returned invalid bounds");
  }
  return {
    items: serialized.map((item) => parseStoredIngestionSession(
      redisReplyString(item, "queue action scan item")
    )),
    nextCursor: hasMore === 1 ? nextCursor : null
  };
}

export async function deleteStoredCompletedReceipts(
  run: IngestionSessionCommandRunner,
  owner: string,
  queue: IngestionQueueType,
  receipts: readonly CompletedIngestionReceipt[]
) {
  if (
    receipts.length < 1
    || receipts.length > appConfig.ingestionRuntime
      .snapshotStaleReceiptCleanupBudget
    || receipts.some((receipt) => (
      receipt.owner !== owner
      || receipt.queue !== queue
      || receipt.status !== "completed"
    ))
  ) {
    throw new RangeError("Stale completed receipt batch is invalid");
  }
  const raw = await run(
    "imageshowDeleteStaleCompletedReceipts",
    ingestionOwnerQueueKey(owner, queue),
    ingestionDisplayQueueKey(owner, queue),
    ingestionQueueMetadataKey(owner, queue),
    ingestionRunnableKey,
    ingestionExpiresKey,
    ingestionCanonicalKeyPrefix(owner),
    owner,
    queue,
    JSON.stringify(receipts.map((receipt) => ({
      session_id: receipt.session_id,
      image_id: receipt.image_id,
      version: receipt.version
    }))),
    appConfig.ingestionRuntime.snapshotStaleReceiptCleanupBudget
  );
  const reply = redisReplyArray(raw, "stale completed receipt cleanup");
  const status = redisReplyInteger(
    reply[0],
    "stale completed receipt cleanup status"
  );
  if (status === 0) return { removed: 0, metadata: null };
  if (status !== 1) {
    throw new Error("Redis ingestion stale receipt cleanup returned unknown status");
  }
  return {
    removed: receipts.length,
    metadata: parseMetadataJson(reply[1], "queue metadata")
  };
}

type DiscoveryMode = "runnable" | "expires" | "all";

async function discoverIngestionSessionPage(
  run: IngestionSessionCommandRunner,
  key: string,
  mode: DiscoveryMode,
  bound: number,
  limit: number,
  maximumLimit: number,
  runnableTail = 0
) {
  if (
    !Number.isSafeInteger(bound)
    || bound < 0
    || !Number.isSafeInteger(runnableTail)
    || runnableTail < 0
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > maximumLimit
  ) {
    throw new RangeError("Redis ingestion discovery range is invalid");
  }
  const raw = await run(
    "imageshowDiscoverIngestionSessions",
    key,
    ingestionRunnableKey,
    ingestionExpiresKey,
    mode,
    bound,
    limit,
    ingestionCanonicalKeyRoot,
    ingestionOwnerQueueKeyRoot,
    ingestionQueueMetadataKeyRoot,
    ingestionDisplayQueueKeyRoot,
    maximumLimit,
    runnableTail
  );
  const reply = redisReplyArray(raw, "session discovery");
  const count = redisReplyInteger(reply[0], "session discovery count");
  const total = redisReplyInteger(reply[1], "session discovery total");
  const scanned = redisReplyInteger(reply[2], "session discovery scanned count");
  const frozenTailScore = redisReplyInteger(
    reply[3],
    "session discovery frozen tail"
  );
  const lastScannedScore = redisReplyInteger(
    reply[4],
    "session discovery cursor"
  );
  if (
    count < 0
    || total < 0
    || total < scanned
    || scanned < count
    || scanned > limit
    || frozenTailScore < 0
    || lastScannedScore < 0
    || (mode === "runnable" && (
      frozenTailScore < bound
      || lastScannedScore < bound
      || lastScannedScore > frozenTailScore
      || (scanned > 0 && lastScannedScore === bound && count > 0)
    ))
    || (mode !== "runnable" && (
      frozenTailScore !== 0 || lastScannedScore !== 0
    ))
    || reply.length !== 5 + count * 2
  ) {
    throw new Error("Redis ingestion discovery returned an invalid shape");
  }
  const items = Array.from({ length: count }, (_, index) => {
    const canonicalKey = redisReplyString(
      reply[5 + index * 2],
      "discovery key"
    );
    const session = parseStoredIngestionSession(redisReplyString(
      reply[6 + index * 2],
      "discovery snapshot"
    ));
    if (canonicalKey !== ingestionCanonicalKey(
      session.owner,
      session.session_id
    )) throw ingestionQueueStructureError();
    return { canonicalKey, session };
  });
  return {
    items,
    total,
    scanned,
    missing: scanned - count,
    frozenTailScore,
    lastScannedScore
  };
}

async function discoverIngestionSessions(
  run: IngestionSessionCommandRunner,
  key: string,
  mode: DiscoveryMode,
  bound: number,
  limit: number,
  maximumLimit: number,
  runnableTail = 0
) {
  return (await discoverIngestionSessionPage(
    run,
    key,
    mode,
    bound,
    limit,
    maximumLimit,
    runnableTail
  )).items;
}

export function discoverRunnableIngestionSessions(
  run: IngestionSessionCommandRunner,
  limit = appConfig.ingestionRuntime.ingestionSessionScanBatchSize
) {
  return discoverIngestionSessions(
    run,
    ingestionRunnableKey,
    "runnable",
    0,
    limit,
    appConfig.ingestionRuntime.ingestionSessionScanBatchSize,
    0
  );
}

export function discoverRunnableIngestionSessionPage(
  run: IngestionSessionCommandRunner,
  cursorScore: number,
  frozenTailScore: number,
  limit = appConfig.ingestionRuntime.ingestionSessionScanBatchSize
) {
  return discoverIngestionSessionPage(
    run,
    ingestionRunnableKey,
    "runnable",
    cursorScore,
    limit,
    appConfig.ingestionRuntime.ingestionSessionScanBatchSize,
    frozenTailScore
  );
}

export function discoverExpiredIngestionSessions(
  run: IngestionSessionCommandRunner,
  now = Date.now(),
  limit = appConfig.ingestionRuntime.expiryScanBatchSize
) {
  return discoverIngestionSessions(
    run,
    ingestionExpiresKey,
    "expires",
    now,
    limit,
    appConfig.ingestionRuntime.expiryScanBatchSize
  );
}

export function discoverExpiryIngestionSessionPage(
  run: IngestionSessionCommandRunner,
  offset: number,
  limit = appConfig.ingestionRuntime.ingestionSessionScanBatchSize
) {
  return discoverIngestionSessionPage(
    run,
    ingestionExpiresKey,
    "all",
    offset,
    limit,
    appConfig.ingestionRuntime.ingestionSessionScanBatchSize
  );
}
