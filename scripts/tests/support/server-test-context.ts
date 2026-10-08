import "./server-environment.ts";
import { readyImageCacheItemFromRow } from "../../../packages/server/src/images/ready-cache/model.ts";
import { sampleResolvedReadyImageIndex } from "../../../packages/server/src/images/ready-cache/random-sampler.ts";

export const imageId = "00000000-0000-7002-8000-00000000008d";
export type ReadyImageSampleDependencies = NonNullable<
  Parameters<typeof sampleResolvedReadyImageIndex>[3]
>;
export function servingReadyCacheItem(overrides: Record<string, unknown> = {}) {
  return readyImageCacheItemFromRow({
    id: imageId,
    device: "pc",
    brightness: "dark",
    theme: null,
    storage_slug: "local",
    author: null,
    tags: [],
    groups: [],
    l_width: 1920, l_height: 1080, l_byte_size: 123456, l_md5: "0123456789abcdef0123456789abcdef",
    m_width: 1920, m_height: 1080, m_byte_size: 123456, m_md5: "0123456789abcdef0123456789abcdef",
    s_width: 1920, s_height: 1080, s_byte_size: 123456, s_md5: "0123456789abcdef0123456789abcdef",
    sort_score: "1786320000000000",
    title: "Serving fixture",
    description: "Serving behavior fixture",
    source: "https://example.com/post",
    original: "https://origin.example.com/image.jpeg",
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
