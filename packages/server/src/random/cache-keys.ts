import { createHash } from "node:crypto";

export const RANDOM_CACHE_NAMESPACE = "imageshow:random";
export const RANDOM_CURRENT_KEY = `${RANDOM_CACHE_NAMESPACE}:current`;
export const RANDOM_MUTATION_REVISION_KEY = `${RANDOM_CACHE_NAMESPACE}:mutation_revision`;
export const RANDOM_UPDATE_LOCK_KEY = `${RANDOM_CACHE_NAMESPACE}:update_lock`;
export const RANDOM_REBUILD_LOCK_KEY = `${RANDOM_CACHE_NAMESPACE}:rebuild_lock`;
export const RANDOM_REBUILD_COMPLETED_KEY = `${RANDOM_CACHE_NAMESPACE}:rebuild_completed`;
export const GALLERY_FILTER_OPTIONS_KEY = "imageshow:gallery_filter_options";

function randomGenerationKey(generation: string, ...parts: string[]) {
  return [RANDOM_CACHE_NAMESPACE, generation, ...parts].join(":");
}

export function randomGenerationPrefix(generation: string) {
  return `${RANDOM_CACHE_NAMESPACE}:${generation}:`;
}

export function randomManifestKey(generation: string) {
  return randomGenerationKey(generation, "keys");
}

export function randomItemKey(generation: string) {
  return randomGenerationKey(generation, "item");
}

export function randomSnapshotKey(generation: string) {
  return randomGenerationKey(generation, "snapshot");
}

export function randomAxisSetKey(
  generation: string,
  device: string,
  brightness: string
) {
  return randomGenerationKey(generation, "axis", device, brightness);
}

export function randomCategorySetKey(
  generation: string,
  device: string,
  brightness: string,
  theme: string
) {
  return randomGenerationKey(
    generation,
    "cat",
    device,
    brightness,
    theme
  );
}

export function randomTagSetKey(generation: string, tag: string) {
  return randomGenerationKey(generation, "tag", tag);
}

export function randomAuthorSetKey(generation: string, author: string) {
  return randomGenerationKey(generation, "author", author);
}

export function randomFilterKey(
  generation: string,
  signature: string,
  suffix: string
) {
  const hash = createHash("sha1").update(signature).digest("hex");
  return randomGenerationKey(generation, "filter", hash, suffix);
}
