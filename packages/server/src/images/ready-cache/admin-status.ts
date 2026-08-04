import type { ReadyImageCacheAdminStatusDto } from "@imageshow/shared/browser";
import { coalesce } from "../../core/coalesce.ts";
import { redis } from "../../core/redis-client.ts";
import { getReadyImageCacheCoordinatorStatus } from "./coordinator.ts";
import { readReadyImageCacheMeta } from "./meta.ts";
import { estimateReadyImageCacheMemory } from "./redis-writer.ts";
import { getReadyImageRevision } from "./revision.ts";

const MEMORY_ESTIMATE_TTL_MS = 15_000;
let memoryEstimate: {
  revision: string;
  value: number;
  expiresAt: number;
} | null = null;

async function currentMemoryEstimate(revision: string) {
  if (
    memoryEstimate?.revision === revision
    && memoryEstimate.expiresAt > Date.now()
  ) {
    return memoryEstimate.value;
  }
  return coalesce(`ready-image-cache-memory:${revision}`, async () => {
    const value = await estimateReadyImageCacheMemory(redis);
    memoryEstimate = {
      revision,
      value,
      expiresAt: Date.now() + MEMORY_ESTIMATE_TTL_MS
    };
    return value;
  });
}

export async function getReadyImageCacheAdminStatus(): Promise<ReadyImageCacheAdminStatusDto> {
  const coordinator = getReadyImageCacheCoordinatorStatus();
  const revision = await getReadyImageRevision();
  const meta = coordinator.rebuilding || !coordinator.readable
    ? await readReadyImageCacheMeta().catch(() => coordinator.meta)
    : coordinator.meta;
  const memoryBytes = coordinator.readable && meta?.state === "ready"
    ? await currentMemoryEstimate(meta.appliedRevision).catch(
        () => meta.memoryBytes
      )
    : meta?.memoryBytes ?? null;
  return {
    initialized: coordinator.initialized,
    readable: coordinator.readable,
    rebuilding: coordinator.rebuilding,
    synchronized: Boolean(
      coordinator.readable
      && meta?.state === "ready"
      && meta.appliedRevision === revision.revision
    ),
    state: coordinator.rebuilding
      ? meta?.state ?? "rebuilding"
      : coordinator.readable
        ? meta?.state ?? "unavailable"
        : "degraded",
    reason: coordinator.reason,
    authoritative_revision: revision.revision,
    applied_revision: meta?.appliedRevision ?? null,
    item_count: meta?.itemCount ?? null,
    processed: meta?.processed ?? null,
    total: meta?.total ?? null,
    memory_bytes: memoryBytes,
    built_at: meta?.builtAt ?? null,
    started_at: meta?.startedAt ?? null,
    last_error: meta?.lastError ?? ""
  };
}
