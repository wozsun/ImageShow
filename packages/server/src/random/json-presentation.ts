import type {
  RandomImageJsonItemDto
} from "@imageshow/shared/browser";
import { publicImageUrlsForConfig } from "../storage/objects/public-urls.ts";
import { getStorageBackendConfigs } from "../storage/backends/registry.ts";
import type { SelectedReadyImage } from "./selection-model.ts";
import { hasDistinctOriginalUrl } from "../images/original-link.ts";

export async function presentRandomJsonItems(
  picked: SelectedReadyImage[],
  signal?: AbortSignal
): Promise<RandomImageJsonItemDto[]> {
  signal?.throwIfAborted();
  if (!picked.length) return [];
  const configs = await getStorageBackendConfigs(picked.map((item) => item.storage_slug), { signal });
  return picked.map((item) => {
    signal?.throwIfAborted();
    const urls = publicImageUrlsForConfig(item.object_key, configs.get(item.storage_slug)!);
    return {
      id: item.id,
      title: item.title,
      author: item.author,
      ...urls,
      device: item.device,
      brightness: item.brightness,
      theme: item.theme,
      tags: item.tags,
      diff_original: hasDistinctOriginalUrl(item.original, urls.object_url),
      width: item.width,
      height: item.height,
      image_time: item.image_time
    };
  });
}
