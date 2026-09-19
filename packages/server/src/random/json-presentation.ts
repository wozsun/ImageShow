import { microsecondsTimestamp } from "../core/microseconds.ts";
import type {
  RandomImageJsonItemDto,
  RandomImageSize
} from "@imageshow/shared/browser";
import { publicImageUrlsForConfig } from "../storage/objects/public-urls.ts";
import { getStorageBackendConfigs } from "../storage/backends/registry.ts";
import type { SelectedReadyImage } from "./selection-model.ts";

export async function presentRandomJsonItems(
  picked: SelectedReadyImage[],
  { signal, size }: { signal?: AbortSignal; size?: RandomImageSize | null } = {}
): Promise<RandomImageJsonItemDto[]> {
  signal?.throwIfAborted();
  if (!picked.length) return [];
  const configs = await getStorageBackendConfigs(picked.map((item) => item.storage_slug), { signal });
  return picked.map((item) => {
    signal?.throwIfAborted();
    const urls = publicImageUrlsForConfig(item, configs.get(item.storage_slug)!);
    const selectedUrls = size === "full"
      ? { object_url: urls.object_url }
      : size === "thumb"
        ? { thumb_url: urls.thumb_url }
        : urls;
    return {
      id: item.id,
      title: item.title,
      author: item.author,
      ...selectedUrls,
      device: item.device,
      brightness: item.brightness,
      theme: item.theme,
      tags: item.tags,
      width: item.width,
      height: item.height,
      image_time: microsecondsTimestamp(BigInt(item.sort_score))!
    };
  });
}
