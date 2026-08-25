import { createHash } from "node:crypto";
import type { ImageDraftDto } from "@imageshow/shared/browser";
import type {
  ImportQueueType,
  ImportSourceType,
  RemoteImportDescription
} from "./session-model.ts";
import { stableJson } from "./session-projection.ts";

export type ImportIntentHashInput = Readonly<{
  queue: ImportQueueType;
  source_type: ImportSourceType;
  batch_key: string;
  provided_image_time: string | null;
  manifest_position: number;
  remote: RemoteImportDescription | null;
  metadata: ImageDraftDto;
  storage_slug: string;
  expected_size: number | null;
  max_long_edge: number | null;
}>;

export function importIntentRequestHash(input: ImportIntentHashInput) {
  return createHash("sha256").update(stableJson({
    queue: input.queue,
    source_type: input.source_type,
    batch_key: input.batch_key,
    provided_image_time: input.provided_image_time,
    manifest_position: input.manifest_position,
    remote: input.remote ? { url: input.remote.url } : null,
    metadata: {
      device: input.metadata.device,
      brightness: input.metadata.brightness,
      theme: input.metadata.theme,
      author: input.metadata.author,
      title: input.metadata.title,
      description: input.metadata.description,
      source: input.metadata.source,
      original: input.metadata.original,
      tags: [...input.metadata.tags].sort()
    },
    storage_slug: input.storage_slug,
    expected_size: input.expected_size,
    max_long_edge: input.max_long_edge
  })).digest("hex");
}
