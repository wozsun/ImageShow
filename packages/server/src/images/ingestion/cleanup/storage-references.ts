import { appConfig } from "@imageshow/shared";
import {
  getRedisOperationalState,
  RedisUnavailableError,
  requireOperationalRedis
} from "../../../core/runtime-availability.ts";
import { ingestionSessionRepository } from "../runtime-repository.ts";
import { ingestionRawPath } from "../raw/paths.ts";
import type {
  IngestionSessionSnapshot,
  StoredIngestionSession
} from "../sessions/model.ts";

export type ActiveIngestionStorageReference = {
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
  session: StoredIngestionSession
): ActiveIngestionStorageReference | null {
  if (session.status === "completed" || session.status === "discarded") {
    return null;
  }
  const active = session as IngestionSessionSnapshot;
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

function storageProjection(session: StoredIngestionSession) {
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

async function readIngestionStoragePass(
  signal?: AbortSignal,
  maxItems = appConfig.ingestionRuntime.orphanCleanupMaxReferenceItems
) {
  if (!Number.isSafeInteger(maxItems) || maxItems < 0) {
    throw new RangeError("Ingestion storage reference limit must be a non-negative safe integer");
  }
  const batchSize = appConfig.ingestionRuntime.recoveryScanBatchSize;
  let offset = 0;
  let expectedTotal: number | null = null;
  const sessions = new Map<string, StoredIngestionSession>();
  for (;;) {
    signal?.throwIfAborted();
    const page = await ingestionSessionRepository.discoverExpiryPage(
      offset,
      batchSize
    );
    signal?.throwIfAborted();
    if (page.missing) return null;
    expectedTotal ??= page.total;
    if (expectedTotal > maxItems) {
      throw new Error(
        `Redis ingestion storage reference count ${expectedTotal} exceeds bounded limit ${maxItems}`
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
export async function activeIngestionStorageReferences(
  options: Readonly<{
    signal?: AbortSignal;
    maxItems?: number;
  }> = {}
) {
  options.signal?.throwIfAborted();
  await requireOperationalRedis();
  const expectedEpoch = getRedisOperationalState().connectionEpoch;
  type IngestionStoragePass = NonNullable<Awaited<
    ReturnType<typeof readIngestionStoragePass>
  >>;
  let previous: IngestionStoragePass | null = null;
  let stable: IngestionStoragePass | null = null;
  for (let pass = 0; pass < 6; pass += 1) {
    options.signal?.throwIfAborted();
    const current = await readIngestionStoragePass(
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
    throw new Error("Redis ingestion storage references changed during bounded read");
  }
  options.signal?.throwIfAborted();
  await requireOperationalRedis();
  const finalState = getRedisOperationalState();
  if (!finalState.available || finalState.connectionEpoch !== expectedEpoch) {
    throw new RedisUnavailableError(
      new Error("Redis connection changed while reading Ingestion storage references")
    );
  }
  const rows = stable.rows;
  const sessionsByBackend = new Map<
    string,
    Map<string, ActiveIngestionStorageReference>
  >();
  const stagingKeysByBackend = new Map<string, Set<string>>();
  const rawPaths = new Set<string>();
  for (const row of rows) {
    let sessions = sessionsByBackend.get(row.storage_slug);
    if (!sessions) {
      sessions = new Map<string, ActiveIngestionStorageReference>();
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
      rawPaths.add(ingestionRawPath(row.queue, {
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

export async function activeIngestionStorageCounts() {
  const { rows } = await activeIngestionStorageReferences();
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.storage_slug, (counts.get(row.storage_slug) ?? 0) + 1);
  }
  return counts;
}
