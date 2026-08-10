import type { ImageSnapshotResponseDto } from "@imageshow/shared/browser";
import { api } from "./client.js";
import { adminApiBasePath } from "../constants.js";

export function readEditableImageSnapshots(
  imageIds: string[],
  signal?: AbortSignal
) {
  return api<ImageSnapshotResponseDto>(
    `${adminApiBasePath}/images/snapshot`,
    {
      method: "POST",
      body: JSON.stringify({ ids: imageIds }),
      signal
    }
  );
}
