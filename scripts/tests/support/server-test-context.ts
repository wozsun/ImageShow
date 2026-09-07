import "./server-environment.ts";
import {
  readyImageCacheItemFromRow
} from "../../../packages/server/src/images/ready-cache/model.ts";
import {
  sampleResolvedReadyImageIndex
} from "../../../packages/server/src/images/ready-cache/random-sampler.ts";
import {
  storageObjectKey
} from "../../../packages/server/src/storage/objects/image-paths.ts";

export const imageId = "019f8457-063a-7002-a580-7a432dc7fd8d";
export type ReadyImageSampleDependencies = NonNullable<
  Parameters<typeof sampleResolvedReadyImageIndex>[3]
>;
export function servingReadyCacheItem(overrides: Record<string, unknown> = {}) {
  return readyImageCacheItemFromRow({
    id: imageId,
    object_key: storageObjectKey(imageId, "jpg"),
    ext: "jpg",
    device: "pc",
    brightness: "dark",
    theme: "none",
    storage_slug: "local",
    author: "",
    tags: [],
    width: 1920,
    height: 1080,
    image_size: 123456,
    cursor_image_time: "2026-08-10T00:00:00.000000Z",
    sort_score: "1",
    title: "Serving fixture",
    description: "Serving behavior fixture",
    source: "https://example.com/post",
    original: "https://origin.example.com/image.jpeg",
    md5: "0123456789abcdef0123456789abcdef",
    cursor_created_at: "2026-08-10T00:00:00.000000Z",
    cursor_updated_at: "2026-08-10T00:00:01.000000Z",
    ...overrides
  });
}
export function readyCacheMeta(revision = "1") {
  return {
    state: "ready" as const,
    appliedRevision: revision,
    itemCount: 1,
    lastUpdatedAt: "2026-08-10T00:00:03.000Z",
    fullRebuildStartedAt: "2026-08-10T00:00:01.000Z",
    fullRebuildCompletedAt: "2026-08-10T00:00:02.000Z",
    processed: 0,
    total: 0,
    lastFullRebuildCoreMemoryBytes: 1024,
    lastFullRebuildMeasuredAt: "2026-08-10T00:00:01.900Z",
    lastError: ""
  };
}
export function deferredPromise<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
