import { brightnesses } from "@imageshow/shared/browser";
import { readyImageFilterOperations } from "../derived/filter-operations.ts";
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
  readyImageFilterTemporaryKeyBelongsTo
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
    const device = plan.axes[0]?.device;
    const wholeDevice =
      device &&
      plan.axes.length === brightnesses.length &&
      brightnesses.every((brightness) =>
        plan.axes.some((axis) => axis.device === device && axis.brightness === brightness)
      );
    positive.push(
      wholeDevice
        ? [readyImageAttributeIndexKey({ kind: "device", value: device })]
        : plan.axes.map((axis) => readyImageAttributeIndexKey({ kind: "axis", ...axis }))
    );
  }
  const theme = selectorComponents(plan.theme, (value) =>
    readyImageAttributeIndexKey({ kind: "theme", value })
  );
  const tagClauses =
    plan.tag?.anyOf.map((clause) =>
      clause.map((value) => readyImageAttributeIndexKey({ kind: "tag", value }))
    ) ?? [];
  const author = selectorComponents(plan.author, (value) =>
    readyImageAttributeIndexKey({ kind: "author", value })
  );
  for (const keys of [theme.include, author.include]) {
    if (keys.length) positive.push(keys);
  }
  return {
    positive,
    tagClauses,
    exclusions: [theme.exclude, author.exclude]
  };
}

export function resolveDirectReadyImageFilterKey(plan: ImageFilterPlan) {
  const { positive, tagClauses, exclusions } = filterComponents(plan);
  if (exclusions.some((keys) => keys.length)) return null;
  const components = [...positive, ...(tagClauses.length ? [tagClauses.flat()] : [])];
  if (!components.length) return READY_IMAGE_ALL_INDEX_KEY;
  if (components.length === 1 && components[0]?.length === 1) return components[0][0] ?? null;
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
    !startingStatus.readable ||
    startingMeta?.state !== "ready" ||
    startingMeta.appliedRevision !== revision ||
    !startingConnection.ready
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
    const releasable = [...new Set(keys)].filter((key) => temporaryKeys.includes(key));
    if (releasable.some((key) => !readyImageFilterTemporaryKeyBelongsTo(key, token))) {
      throw new Error("Ready-image filter builder cannot release a foreign key");
    }
    if (!releasable.length) return;
    await redis.unlink(...releasable);
    for (const key of releasable) {
      temporaryKeys.splice(temporaryKeys.indexOf(key), 1);
    }
  };
  const { positive, tagClauses, exclusions } = filterComponents(plan);
  const shapeAdmission = assessReadyImageFilterWork({
    itemCount: 1,
    positive: positive.map((keys) => keys.map(() => 1)),
    tagClauses: tagClauses.map((keys) => keys.map(() => 1)),
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
    ...tagClauses.flat(),
    ...exclusions.flat(),
    ...(positive.length || tagClauses.length ? [] : [READY_IMAGE_ALL_INDEX_KEY])
  ];
  const attributeKeys = sourceKeys.filter((key) => key !== READY_IMAGE_ALL_INDEX_KEY);
  if (
    attributeKeys.length &&
    !(await ensureReadyImageAttributeIndexes(
      attributeKeys,
      revision,
      signal,
      background
    ))
  ) {
    return null;
  }
  const sourceLease = await withReadyImageCacheRead(() =>
    readReadyImageSourceIndexStates(sourceKeys, revision)
  );
  const sourceStates = sourceLease.acquired ? sourceLease.value : null;
  if (!sourceStates) return null;
  const admission = assessReadyImageFilterWork({
    itemCount: startingMeta.itemCount,
    positive: positive.map((keys) => keys.map((key) => sourceStates.get(key)?.count ?? 0)),
    tagClauses: tagClauses.map((keys) => keys.map((key) => sourceStates.get(key)?.count ?? 0)),
    exclusions: exclusions.map((keys) => keys.map((key) => sourceStates.get(key)?.count ?? 0))
  });
  if (!admission.admitted) {
    logger.debug("ready_image_filter_work_rejected", {
      signature: plan.signature,
      reason: admission.reason,
      ...admission.estimate
    });
    return null;
  }
  const releaseBuildSlot = tryAcquireReadyImageFilterBuildSlot(admission.estimate);
  if (!releaseBuildSlot) return null;
  try {
    const sources = (groups: string[][]) =>
      groups.map((keys) =>
        keys.map((key) => ({
          key,
          count: sourceStates.get(key)!.count
        }))
      );
    const execution = readyImageFilterOperations(
      {
        all: { key: READY_IMAGE_ALL_INDEX_KEY, count: startingMeta.itemCount },
        positive: sources(positive),
        tagClauses: sources(tagClauses),
        exclusions: sources(exclusions)
      },
      temporaryKey
    );
    const commands = {
      union: "zunionstore",
      intersection: "zinterstore",
      difference: "zdiffstore"
    } as const;
    for (let index = 0; index < execution.operations.length; index += 1) {
      signal?.throwIfAborted();
      const operation = execution.operations[index]!;
      operation.result.count = await storeReadyImageFilterSetOperation(
        commands[operation.kind],
        operation.result.key,
        operation.sources,
        operation.result.count
      );
      // Sources may be shared by later tag branches. Release only after last use.
      const remaining = new Set(
        execution.operations
          .slice(index + 1)
          .flatMap((next) => next.sources.map((source) => source.key))
      );
      await releaseTemporaryKeys(
        ...operation.sources
          .filter((source) => source.key !== execution.result.key && !remaining.has(source.key))
          .map((source) => source.key)
      );
    }
    const current = execution.result;

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
      const ownedKeys = temporaryKeys.filter((key) =>
        readyImageFilterTemporaryKeyBelongsTo(key, token)
      );
      if (ownedKeys.length) {
        await redis.unlink(...ownedKeys).catch(() => undefined);
      }
    }
    releaseBuildSlot();
  }
}
