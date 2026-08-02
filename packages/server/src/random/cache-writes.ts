import type { Redis } from "ioredis";
import {
  randomAuthorSetKey,
  randomAxisSetKey,
  randomCategorySetKey,
  randomManifestKey,
  randomSnapshotKey,
  randomTagSetKey
} from "./cache-keys.ts";
import {
  type RandomCategoryCounts,
  type RandomPoolItem
} from "./cache-model.ts";

export function registerRandomGenerationKeys(
  generation: string,
  keys: Set<string>
) {
  keys.add(randomManifestKey(generation));
  keys.add(randomSnapshotKey(generation));
}

function membershipKeys(generation: string, item: RandomPoolItem): string[] {
  const keys = [
    randomAxisSetKey(generation, item.device, item.brightness),
    randomCategorySetKey(
      generation,
      item.device,
      item.brightness,
      item.theme
    )
  ];
  for (const tag of item.tags) keys.push(randomTagSetKey(generation, tag));
  if (item.author) keys.push(randomAuthorSetKey(generation, item.author));
  return keys;
}

export function collectRandomMemberships(
  target: Map<string, string[]>,
  generation: string,
  item: RandomPoolItem,
  keys?: Set<string>
) {
  for (const key of membershipKeys(generation, item)) {
    const ids = target.get(key);
    if (ids) ids.push(item.id);
    else target.set(key, [item.id]);
    keys?.add(key);
  }
}

export function queueRandomMemberships(
  pipeline: ReturnType<Redis["pipeline"]>,
  command: "sadd" | "srem",
  memberships: Map<string, string[]>
) {
  for (const [key, ids] of memberships) pipeline[command](key, ...ids);
}

export function queueRandomSnapshot(
  pipeline: ReturnType<Redis["pipeline"]>,
  generation: string,
  categoryCounts: RandomCategoryCounts
) {
  pipeline.set(
    randomSnapshotKey(generation),
    JSON.stringify({ categoryCounts })
  );
}
