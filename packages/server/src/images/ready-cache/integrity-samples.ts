import type { Redis } from "ioredis";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import {
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_OBJECT_LOOKUP_KEY,
  READY_IMAGE_THUMB_LOOKUP_KEY
} from "./keys.ts";
import {
  readyImageIdSuffixScore,
  readyImageIndexKeys,
  readyImageMember,
  readyImageThumbKey,
  serializeReadyImageCacheItem,
  type ReadyImageCacheItem
} from "./model.ts";
import { REDIS_BATCH_MAX_COMMANDS } from "./redis-batch.ts";

export async function validateReadyImageSamples(
  samples: ReadyImageCacheItem[],
  client: Redis
) {
  let pipeline = client.pipeline();
  let validators: Array<(value: unknown) => void> = [];
  const flush = async () => {
    if (!validators.length) return;
    const results = await execRedisPipeline(pipeline);
    if (results.length !== validators.length) {
      throw new Error("Ready-image cache sample pipeline was incomplete");
    }
    results.forEach((result, index) => validators[index]?.(result[1]));
    pipeline = client.pipeline();
    validators = [];
  };
  const queue = async (
    command: () => unknown,
    validate: (value: unknown) => void
  ) => {
    command();
    validators.push(validate);
    if (validators.length >= REDIS_BATCH_MAX_COMMANDS) await flush();
  };
  for (const item of samples) {
    const member = readyImageMember(item.id);
    await queue(
      () => pipeline.hget(READY_IMAGE_ITEMS_KEY, member),
      (value) => {
        if (value !== serializeReadyImageCacheItem(item)) {
          throw new Error("Ready-image cache item sample failed validation");
        }
      }
    );
    for (const [lookup, field] of [
      [READY_IMAGE_OBJECT_LOOKUP_KEY, item.object_key],
      [READY_IMAGE_THUMB_LOOKUP_KEY, readyImageThumbKey(item)]
    ] as const) {
      await queue(
        () => pipeline.hget(lookup, field),
        (value) => {
          if (value !== member) {
            throw new Error("Ready-image cache lookup sample failed validation");
          }
        }
      );
    }
    await queue(
      () => pipeline.zscore(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, member),
      (value) => {
        if (Number(value) !== readyImageIdSuffixScore(item)) {
          throw new Error("Ready-image cache suffix sample failed validation");
        }
      }
    );
    for (const key of readyImageIndexKeys(item)) {
      await queue(
        () => pipeline.zscore(key, member),
        (value) => {
          if (Number(value) !== item.sort_score) {
            throw new Error("Ready-image cache index sample failed validation");
          }
        }
      );
    }
  }
  await flush();
}
