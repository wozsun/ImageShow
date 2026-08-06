import { redis } from "../../core/redis-client.ts";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import { getReadyImageCacheCoordinatorStatus } from "./coordinator.ts";
import { READY_IMAGE_DERIVED_CACHE_POLICY } from "./derived-cache-policy.ts";

type ReadyImageDerivedIndexKind = "attribute" | "filter";

type ReadyImageDerivedIndexSnapshot = {
  count: number;
  instanceToken: string;
  itemCount: number;
};

function nonNegativeCount(raw: unknown) {
  const value = String(raw ?? "");
  if (!/^\d+$/u.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

function parseDerivedIndexMeta(
  raw: Record<string, string>,
  kind: ReadyImageDerivedIndexKind
) {
  const expectedFields = kind === "attribute" ? 5 : 4;
  const lastAccessed = kind === "attribute" ? raw.last_accessed : null;
  if (
    Object.keys(raw).length !== expectedFields
    || !/^\d+$/u.test(raw.applied_revision ?? "")
    || !Number.isFinite(Date.parse(raw.built_at ?? ""))
    || (
      kind === "attribute"
      && !Number.isFinite(Date.parse(lastAccessed ?? ""))
    )
    || !/^[0-9a-f]{32}$/u.test(raw.instance_token ?? "")
  ) {
    return null;
  }
  const count = nonNegativeCount(raw.count);
  return count === null ? null : {
    revision: raw.applied_revision,
    count,
    builtAt: raw.built_at,
    lastAccessed,
    instanceToken: raw.instance_token
  };
}

export async function readReadyImageDerivedIndexSnapshot(options: {
  kind: ReadyImageDerivedIndexKind;
  key: string;
  metaKey: string;
  revision: string;
  expected?: { count: number; instanceToken: string };
}): Promise<ReadyImageDerivedIndexSnapshot | null> {
  const pipeline = redis.pipeline();
  pipeline.hgetall(options.metaKey);
  pipeline.zcard(options.key);
  pipeline.ttl(options.metaKey);
  pipeline.ttl(options.key);
  const results = await execRedisPipeline(pipeline);
  const meta = parseDerivedIndexMeta(
    results[0]?.[1] as Record<string, string> ?? {},
    options.kind
  );
  const cardinality = nonNegativeCount(results[1]?.[1]);
  const metaTtl = Number(results[2]?.[1] ?? -2);
  const indexTtl = Number(results[3]?.[1] ?? -2);
  const status = getReadyImageCacheCoordinatorStatus();
  const itemCount = status.readable
    && status.meta?.state === "ready"
    && status.meta.appliedRevision === options.revision
    ? status.meta.itemCount
    : null;
  if (
    !meta
    || itemCount === null
    || meta.revision !== options.revision
    || cardinality !== meta.count
    || meta.count > itemCount
    || meta.count > READY_IMAGE_DERIVED_CACHE_POLICY.maxResultMembers
    || !Number.isSafeInteger(metaTtl)
    || metaTtl <= 0
    || (meta.count > 0 && (
      !Number.isSafeInteger(indexTtl) || indexTtl <= 0
    ))
    || (
      options.expected
      && (
        meta.count !== options.expected.count
        || meta.instanceToken !== options.expected.instanceToken
      )
    )
  ) {
    return null;
  }
  return {
    count: meta.count,
    instanceToken: meta.instanceToken,
    itemCount
  };
}
