import { logger } from "../../../core/logger.ts";
import { getRedisConnectionState, redis } from "../../../core/redis/client.ts";
import { randomUuidV7 } from "../../../core/uuid.ts";
import {
  imageFilterPlanHasAllAxes,
  type ImageFilterPlan,
  type ImageSelectorGroup
} from "../../filter-plan.ts";
import {
  ensureReadyImageAttributeIndexes,
  readReadyImageAttributeIndex,
  readReadyImageSourceIndexStates
} from "./attribute.ts";
import {
  getReadyImageCacheCoordinatorStatus,
  withReadyImageCacheRead
} from "../coordinator.ts";
import {
  assessReadyImageFilterWork,
  tryAcquireReadyImageFilterBuildSlot
} from "../derived/work-policy.ts";
import {
  publishReadyImageFilterIndex,
  storeReadyImageFilterSetOperation,
  type ReadyImageFilterIndex
} from "./filter-store.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  readyImageAttributeIndexKey,
  readyImageFilterTemporaryKey,
  readyImageFilterTemporaryKeyBelongsTo,
} from "../keys.ts";

function selectorComponents(
  group: ImageSelectorGroup,
  key: (value: string) => string
) {
  return {
    include: group.include.map(key),
    exclude: group.exclude.map(key)
  };
}

function filterComponents(plan: ImageFilterPlan) {
  const positive: string[][] = [];
  if (!imageFilterPlanHasAllAxes(plan)) {
    positive.push(plan.axes.map((axis) => (
      readyImageAttributeIndexKey({ kind: "axis", ...axis })
    )));
  }
  const theme = selectorComponents(plan.theme, (value) => (
    readyImageAttributeIndexKey({ kind: "theme", value })
  ));
  const tag = selectorComponents(plan.tag, (value) => (
    readyImageAttributeIndexKey({ kind: "tag", value })
  ));
  const author = selectorComponents(plan.author, (value) => (
    readyImageAttributeIndexKey({ kind: "author", value })
  ));
  for (const keys of [theme.include, tag.include, author.include]) {
    if (keys.length) positive.push(keys);
  }
  return {
    positive,
    exclusions: [theme.exclude, tag.exclude, author.exclude]
  };
}

export function resolveDirectReadyImageFilterKey(plan: ImageFilterPlan) {
  const { positive, exclusions } = filterComponents(plan);
  if (exclusions.some((keys) => keys.length)) return null;
  if (!positive.length) return READY_IMAGE_ALL_INDEX_KEY;
  if (positive.length === 1 && positive[0]?.length === 1) {
    return positive[0][0] ?? null;
  }
  return null;
}

export async function buildReadyImageFilterIndex(
  plan: ImageFilterPlan,
  revision: string,
  signal?: AbortSignal,
  background = false
): Promise<ReadyImageFilterIndex | null> {
  signal?.throwIfAborted();
  const startingStatus = getReadyImageCacheCoordinatorStatus();
  const startingMeta = startingStatus.meta;
  const startingConnection = getRedisConnectionState();
  if (
    !startingStatus.readable
    || startingMeta?.state !== "ready"
    || startingMeta.appliedRevision !== revision
    || !startingConnection.ready
  ) {
    return null;
  }
  const token = randomUuidV7().replaceAll("-", "");
  const temporaryKeys: string[] = [];
  let sequence = 0;
  const temporaryKey = () => {
    const key = readyImageFilterTemporaryKey(token, sequence);
    sequence += 1;
    temporaryKeys.push(key);
    return key;
  };
  const releaseTemporaryKeys = async (...keys: string[]) => {
    const releasable = [...new Set(keys)].filter((key) => (
      temporaryKeys.includes(key)
    ));
    if (releasable.some((key) => (
      !readyImageFilterTemporaryKeyBelongsTo(key, token)
    ))) {
      throw new Error("Ready-image filter builder cannot release a foreign key");
    }
    if (!releasable.length) return;
    await redis.unlink(...releasable);
    for (const key of releasable) {
      temporaryKeys.splice(temporaryKeys.indexOf(key), 1);
    }
  };
  const { positive, exclusions } = filterComponents(plan);
  const shapeAdmission = assessReadyImageFilterWork({
    itemCount: 1,
    positive: positive.map((keys) => keys.map(() => 1)),
    exclusions: exclusions.map((keys) => keys.map(() => 1))
  });
  if (!shapeAdmission.admitted) {
    logger.debug("ready_image_filter_work_rejected", {
      signature: plan.signature,
      phase: "shape",
      reason: shapeAdmission.reason,
      ...shapeAdmission.estimate
    });
    return null;
  }
  const sourceKeys = [
    ...positive.flat(),
    ...exclusions.flat(),
    ...(positive.length ? [] : [READY_IMAGE_ALL_INDEX_KEY])
  ];
  const attributeKeys = sourceKeys.filter(
    (key) => key !== READY_IMAGE_ALL_INDEX_KEY
  );
  if (
    attributeKeys.length
    && !await ensureReadyImageAttributeIndexes(
      attributeKeys,
      revision,
      signal,
      background
    )
  ) {
    return null;
  }
  const sourceLease = await withReadyImageCacheRead(() => (
    readReadyImageSourceIndexStates(sourceKeys, revision)
  ));
  const sourceStates = sourceLease.acquired ? sourceLease.value : null;
  if (!sourceStates) return null;
  const admission = assessReadyImageFilterWork({
    itemCount: startingMeta.itemCount,
    positive: positive.map((keys) => keys.map(
      (key) => sourceStates.get(key)?.count ?? 0
    )),
    exclusions: exclusions.map((keys) => keys.map(
      (key) => sourceStates.get(key)?.count ?? 0
    ))
  });
  if (!admission.admitted) {
    logger.debug("ready_image_filter_work_rejected", {
      signature: plan.signature,
      reason: admission.reason,
      ...admission.estimate
    });
    return null;
  }
  const releaseBuildSlot = tryAcquireReadyImageFilterBuildSlot(
    admission.estimate
  );
  if (!releaseBuildSlot) return null;
  const union = async (keys: string[]) => {
    const activeKeys = keys.filter(
      (key) => (sourceStates.get(key)?.count ?? 0) > 0
    );
    if (!activeKeys.length) {
      return {
        key: keys[0] ?? temporaryKey(),
        count: 0
      };
    }
    if (activeKeys.length === 1) {
      const key = activeKeys[0]!;
      return {
        key,
        count: sourceStates.get(key)?.count ?? 0
      };
    }
    const destination = temporaryKey();
    const expectedMembers = Math.min(
      startingMeta.itemCount,
      activeKeys.reduce((total, key) => (
        total + (sourceStates.get(key)?.count ?? 0)
      ), 0)
    );
    const count = await storeReadyImageFilterSetOperation(
      "zunionstore",
      destination,
      activeKeys.map((key) => ({
        key,
        count: sourceStates.get(key)?.count ?? 0
      })),
      expectedMembers
    );
    return { key: destination, count };
  };

  try {
    let current: { key: string; count: number } | null = null;
    for (const keys of positive) {
      const component = await union(keys);
      if (!current) {
        current = component;
        continue;
      }
      const destination = temporaryKey();
      const expectedMembers = Math.min(current.count, component.count);
      const count = await storeReadyImageFilterSetOperation(
        "zinterstore",
        destination,
        [current, component],
        expectedMembers
      );
      await releaseTemporaryKeys(current.key, component.key);
      current = { key: destination, count };
    }
    current ??= {
      key: READY_IMAGE_ALL_INDEX_KEY,
      count: startingMeta.itemCount
    };

    for (const keys of exclusions) {
      const activeKeys = keys.filter(
        (key) => (sourceStates.get(key)?.count ?? 0) > 0
      );
      if (!activeKeys.length) continue;
      const excluded = await union(activeKeys);
      const destination = temporaryKey();
      const count = await storeReadyImageFilterSetOperation(
        "zdiffstore",
        destination,
        [current, excluded],
        current.count
      );
      await releaseTemporaryKeys(current.key, excluded.key);
      current = { key: destination, count };
    }

    if (!temporaryKeys.includes(current.key)) {
      if (current.key === READY_IMAGE_ALL_INDEX_KEY) {
        return {
          kind: "core",
          key: current.key,
          revision,
          count: startingMeta.itemCount,
          metaKey: null,
          instanceToken: null
        };
      }
      const attribute = await readReadyImageAttributeIndex(
        current.key,
        revision
      );
      return attribute ? { kind: "attribute", ...attribute } : null;
    }
    return await publishReadyImageFilterIndex({
      signature: plan.signature,
      revision,
      count: current.count,
      temporaryKey: current.key,
      startingMeta,
      connectionEpoch: startingConnection.epoch,
      sourceKeys,
      sourceStates,
      signal
    });
  } finally {
    if (temporaryKeys.length) {
      const ownedKeys = temporaryKeys.filter((key) => (
        readyImageFilterTemporaryKeyBelongsTo(key, token)
      ));
      if (ownedKeys.length) {
        await redis.unlink(...ownedKeys).catch(() => undefined);
      }
    }
    releaseBuildSlot();
  }
}
