import { appConfig } from "@imageshow/shared";
import {
  getRedisOperationalState,
  RedisUnavailableError,
  requireOperationalRedis
} from "../../../core/runtime-availability.ts";
import { ingestionSessionRepository } from "../runtime-repository.ts";
import { ingestionRawPath, ingestionPreparedPath, ingestionPreparedFiles } from "../raw/paths.ts";
import type {
  IngestionPreparedManifest,
  IngestionSessionSnapshot,
  StoredIngestionSession
} from "../sessions/model.ts";

export type ActiveIngestionStorageReference = {
  id: string;
  image_id: string;
  queue: "upload" | "import";
  status: string;
  storage_slug: string;
  commit_ext: string | null;
  raw_generation: string;
  prepared: Pick<IngestionPreparedManifest, "generation" | "producer_execution_token"> | null;
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
    commit_ext: active.commit ? prepared!.ext : null,
    raw_generation: active.raw_generation,
    prepared: prepared
      ? {
          generation: prepared.generation,
          producer_execution_token: prepared.producer_execution_token
        }
      : null,
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
    active.commit_ext ?? "",
    active.raw_generation,
    active.prepared?.generation ?? "",
    active.prepared?.producer_execution_token ?? ""
  ].join("\0");
}

async function readIngestionStoragePass(
  signal?: AbortSignal,
  maxItems = appConfig.ingestionRuntime.orphanCleanupMaxReferenceItems
) {
  if (!Number.isSafeInteger(maxItems) || maxItems < 0) {
    throw new RangeError("Ingestion storage reference limit must be a non-negative safe integer");
  }
  const batchSize = appConfig.ingestionRuntime.ingestionSessionScanBatchSize;
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

type IngestionStorageReferenceOptions = Readonly<{
  signal?: AbortSignal;
  maxItems?: number;
}>;

/**
 * Every Redis command and page is bounded. Two identical complete projections
 * are required so rank shifts cannot make storage maintenance silently miss a
 * canonical while the worker changes the expiry ordering.
 */
async function readStableIngestionStorageRows(options: IngestionStorageReferenceOptions) {
  options.signal?.throwIfAborted();
  await requireOperationalRedis();
  const expectedEpoch = getRedisOperationalState().connectionEpoch;
  type IngestionStoragePass = NonNullable<Awaited<ReturnType<typeof readIngestionStoragePass>>>;
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
  return stable.rows;
}

export async function activeIngestionStorageReferences(
  options: IngestionStorageReferenceOptions = {}
) {
  const rows = await readStableIngestionStorageRows(options);
  const referencesByBackend = new Map<string, Map<string, ActiveIngestionStorageReference>>();
  const tempPaths = new Set<string>();
  for (const row of rows) {
    const references = referencesByBackend.getOrInsertComputed(
      row.storage_slug,
      () => new Map()
    );
    references.set(row.id, row);
    for (const file of row.prepared
      ? ingestionPreparedFiles({ session_id: row.id, image_id: row.image_id }, row.prepared)
      : []) {
      if (file) tempPaths.add(ingestionPreparedPath(file));
    }
    if (row.raw_generation) {
      tempPaths.add(
        ingestionRawPath(
          {
            session_id: row.id,
            image_id: row.image_id
          },
          row.raw_generation
        )
      );
    }
  }
  return {
    rows,
    referencesByBackend,
    tempPaths
  };
}

export async function activeIngestionStorageCounts(options: IngestionStorageReferenceOptions = {}) {
  const rows = await readStableIngestionStorageRows(options);
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.storage_slug, (counts.get(row.storage_slug) ?? 0) + 1);
  }
  return counts;
}
