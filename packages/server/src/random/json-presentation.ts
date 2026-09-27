import type { RandomImageJsonItemDto, RandomImageSize } from "@imageshow/shared/browser";
import { microsecondsTimestamp } from "../core/microseconds.ts";
import { publicImageUrlForConfig } from "../storage/objects/public-urls.ts";
import { getStorageBackendConfigs } from "../storage/backends/registry.ts";
import { storedVariantFacts } from "../images/variants/record.ts";
import type { SelectedReadyImage } from "./selection-model.ts";

export async function presentRandomJsonItems(
  picked: SelectedReadyImage[],
  { signal, size, origin }: { signal?: AbortSignal; size: RandomImageSize; origin: string }
): Promise<RandomImageJsonItemDto[]> {
  signal?.throwIfAborted();
  if (!picked.length) return [];
  const configs = await getStorageBackendConfigs(picked.map((item) => item.storage_slug), { signal });
  return picked.map((item) => {
    signal?.throwIfAborted();
    const facts = storedVariantFacts(item, size);
    return {
      id: item.id, title: item.title, author: item.author,
      url: new URL(publicImageUrlForConfig(item, configs.get(item.storage_slug)!, size), origin).href,
      device: item.device, brightness: item.brightness, theme: item.theme, tags: item.tags,
      width: facts.width, height: facts.height, byte_size: facts.byte_size,
      image_time: microsecondsTimestamp(BigInt(item.sort_score))!
    };
  });
}
