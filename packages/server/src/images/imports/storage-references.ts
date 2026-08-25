import { appConfig } from "@imageshow/shared";
import {
  getRedisOperationalState,
  RedisUnavailableError,
  requireOperationalRedis
} from "../../core/runtime-availability.ts";
import { importSessionRepository } from "./runtime-repository.ts";
import { importRawPath } from "./raw-files.ts";
import type {
  ImportSessionSnapshot,
  StoredImportSession
} from "./session-model.ts";

export type ActiveImportStorageReference = {
  id: string;
  image_id: string;
  queue: "upload" | "import";
  status: string;
  storage_slug: string;
  final_object_key: string | null;
  raw_generation: string;
  prepared_image_key: string | null;
  prepared_thumbnail_key: string | null;
  discard_at: number;
};

function activeStorageReference(
  session: StoredImportSession
): ActiveImportStorageReference | null {
  if (session.status === "completed" || session.status === "discarded") {
    return null;
  }
  const active = session as ImportSessionSnapshot;
  const prepared = active.prepared;
  return {
    id: active.session_id,
    image_id: active.image_id,
    queue: active.queue,
    status: active.status,
    storage_slug: active.storage_slug,
    final_object_key: active.commit?.final_object_key ?? null,
    raw_generation: active.raw_generation,
    prepared_image_key: prepared?.prepared_image_key ?? null,
    prepared_thumbnail_key: prepared?.prepared_thumbnail_key ?? null,
    discard_at: active.discard_at
  };
}

function storageProjection(session: StoredImportSession) {
  const active = activeStorageReference(session);
  if (!active) return `${session.session_id}\0terminal`;
  return [
    active.id,
    active.image_id,
    active.queue,
    active.storage_slug,
    active.final_object_key ?? "",
    active.raw_generation,
    active.prepared_image_key ?? "",
    active.prepared_thumbnail_key ?? ""
  ].join("\0");
}

async function readImportStoragePass(
  signal?: AbortSignal,
  maxItems = appConfig.importRuntime.orphanCleanupMaxReferenceItems
) {
  if (!Number.isSafeInteger(maxItems) || maxItems < 0) {
    throw new RangeError("Import storage reference limit must be a non-negative safe integer");
  }
  const batchSize = appConfig.importRuntime.recoveryScanBatchSize;
  let offset = 0;
  let expectedTotal: number | null = null;
  const sessions = new Map<string, StoredImportSession>();
  for (;;) {
    signal?.throwIfAborted();
    const page = await importSessionRepository.discoverExpiryPage(
      offset,
      batchSize
    );
    signal?.throwIfAborted();
    if (page.missing) return null;
    expectedTotal ??= page.total;
    if (expectedTotal > maxItems) {
      throw new Error(
        `Redis import storage reference count ${expectedTotal} exceeds bounded limit ${maxItems}`
      );
    }
    if (page.total !== expectedTotal) return null;
    for (const { canonicalKey, session } of page.items) {
      if (sessions.has(canonicalKey)) return null;
      sessions.set(canonicalKey, session);
    }
    offset += page.scanned;
    if (offset >= expectedTotal) break;
    if (!page.scanned) return null;
  }
  if (sessions.size !== expectedTotal) return null;
  const rows = [...sessions.values()].flatMap((session) => {
    const active = activeStorageReference(session);
    return active ? [active] : [];
  });
  return {
    signature: [...sessions.entries()]
      .map(([key, session]) => `${key}\0${storageProjection(session)}`)
      .sort()
      .join("\n"),
    rows
  };
}

/**
 * Every Redis command and page is bounded. Two identical complete projections
 * are required so rank shifts cannot make storage maintenance silently miss a
 * canonical while the worker changes the expiry ordering.
 */
export async function activeImportStorageReferences(
  options: Readonly<{
    signal?: AbortSignal;
    maxItems?: number;
  }> = {}
) {
  options.signal?.throwIfAborted();
  await requireOperationalRedis();
  const expectedEpoch = getRedisOperationalState().connectionEpoch;
  type ImportStoragePass = NonNullable<Awaited<
    ReturnType<typeof readImportStoragePass>
  >>;
  let previous: ImportStoragePass | null = null;
  let stable: ImportStoragePass | null = null;
  for (let pass = 0; pass < 6; pass += 1) {
    options.signal?.throwIfAborted();
    const current = await readImportStoragePass(
      options.signal,
      options.maxItems
    );
    if (current && previous?.signature === current.signature) {
      stable = current;
      break;
    }
    previous = current;
  }
  if (!stable) {
    throw new Error("Redis import storage references changed during bounded read");
  }
  options.signal?.throwIfAborted();
  await requireOperationalRedis();
  const finalState = getRedisOperationalState();
  if (!finalState.available || finalState.connectionEpoch !== expectedEpoch) {
    throw new RedisUnavailableError(
      new Error("Redis connection changed while reading import storage references")
    );
  }
  const rows = stable.rows;
  const sessionsByBackend = new Map<
    string,
    Map<string, ActiveImportStorageReference>
  >();
  const stagingKeysByBackend = new Map<string, Set<string>>();
  const rawPaths = new Set<string>();
  for (const row of rows) {
    let sessions = sessionsByBackend.get(row.storage_slug);
    if (!sessions) {
      sessions = new Map<string, ActiveImportStorageReference>();
      sessionsByBackend.set(row.storage_slug, sessions);
    }
    sessions.set(row.id, row);
    let stagingKeys = stagingKeysByBackend.get(row.storage_slug);
    if (!stagingKeys) {
      stagingKeys = new Set<string>();
      stagingKeysByBackend.set(row.storage_slug, stagingKeys);
    }
    if (row.prepared_image_key) stagingKeys.add(row.prepared_image_key);
    if (row.prepared_thumbnail_key) stagingKeys.add(row.prepared_thumbnail_key);
    if (row.raw_generation) {
      rawPaths.add(importRawPath(row.queue, {
        session_id: row.id,
        image_id: row.image_id
      }, row.raw_generation));
    }
  }
  return {
    rows,
    sessionsByBackend,
    stagingKeysByBackend,
    rawPaths
  };
}

export async function activeImportStorageCounts() {
  const { rows } = await activeImportStorageReferences();
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.storage_slug, (counts.get(row.storage_slug) ?? 0) + 1);
  }
  return counts;
}
