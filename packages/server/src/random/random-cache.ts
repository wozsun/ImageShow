/**
 * 随机池领域入口。
 *
 * key/代际协议、锁、重建、增量同步和读取采样分别维护；其他领域只从本
 * 文件导入，避免依赖随机池的 Redis 实现细节。
 */
export {
  GALLERY_FILTER_OPTIONS_KEY,
  RANDOM_CURRENT_KEY,
  RANDOM_MUTATION_REVISION_KEY,
  RANDOM_REBUILD_COMPLETED_KEY,
  randomAxisSetKey,
  randomCategorySetKey,
  randomItemKey,
  randomManifestKey,
  randomSnapshotKey,
  type GalleryFilterOptions,
  type RandomCategoryCounts,
  type RandomPoolItem,
  type RandomPoolSnapshot
} from "./cache-schema.ts";

export { rebuildRandomPool } from "./cache-rebuild.ts";
export {
  buildRandomFilterSet,
  getGalleryFilterOptions,
  getRandomCategoryCounts,
  getRandomPoolSnapshot,
  sampleRandomPoolItems
} from "./cache-read.ts";
export {
  syncRandomImage,
  syncRandomImages
} from "./cache-sync.ts";
