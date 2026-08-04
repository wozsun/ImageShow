import type {
  RandomImageJsonItemDto
} from "@imageshow/shared/browser";
import { publicImageUrls } from "../storage/public-urls.ts";
import type { SelectedReadyImage } from "./selection-model.ts";

export async function presentRandomJsonItems(
  picked: SelectedReadyImage[],
  signal?: AbortSignal
): Promise<RandomImageJsonItemDto[]> {
  signal?.throwIfAborted();
  return Promise.all(picked.map(async (item) => {
    signal?.throwIfAborted();
    return {
      id: item.id,
      ...await publicImageUrls(item.object_key, item.storage_slug),
      device: item.device,
      brightness: item.brightness,
      theme: item.theme,
      tags: item.tags,
      width: item.width,
      height: item.height,
      image_time: item.image_time
    };
  }));
}
