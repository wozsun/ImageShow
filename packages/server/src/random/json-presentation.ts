import type {
  RandomImageJsonItemDto
} from "@imageshow/shared/browser";
import { publicImageUrls } from "../storage/objects/public-urls.ts";
import { listStorageBackends } from "../storage/backends/registry.ts";
import type {
  PublicDatabaseReadAccess
} from "../core/database/public-fallback.ts";
import type { SelectedReadyImage } from "./selection-model.ts";

export async function presentRandomJsonItems(
  picked: SelectedReadyImage[],
  signal?: AbortSignal,
  database: PublicDatabaseReadAccess = {}
): Promise<RandomImageJsonItemDto[]> {
  signal?.throwIfAborted();
  if (picked.length) await listStorageBackends(database);
  return Promise.all(picked.map(async (item) => {
    signal?.throwIfAborted();
    return {
      id: item.id,
      ...await publicImageUrls(item.object_key, item.storage_slug, database),
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
