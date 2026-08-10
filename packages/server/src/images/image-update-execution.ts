import type {
  ImageUpdateItemResultDto
} from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import { mapWithWorkerPool } from "../core/concurrency.ts";
import type { ImageUpdateItemInput } from "../core/validation.ts";

const imageUpdateConcurrency = 2;

type ImageMetadataUpdate = Omit<ImageUpdateItemInput, "id" | "tags">;

type ImageUpdateItemExecutors = {
  updateMetadata: (id: string, metadata: ImageMetadataUpdate) => Promise<void>;
  updateTags: (id: string, tags: string[]) => Promise<void>;
};

function publicItemError(error: unknown): Pick<
  Extract<ImageUpdateItemResultDto, { status: "failed" }>,
  "code" | "message"
> {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "image_update_failed",
    message: "Image update failed"
  };
}

export async function executeImageUpdateItems(
  items: ImageUpdateItemInput[],
  executors: ImageUpdateItemExecutors,
  concurrency = imageUpdateConcurrency
) {
  let maxItemDurationMs = 0;
  const results = await mapWithWorkerPool(items, concurrency, async (item) => {
    const itemStartedAt = performance.now();
    const { id, tags, ...metadata } = item;
    let itemError: unknown;
    try {
      if (Object.keys(metadata).length) {
        await executors.updateMetadata(id, metadata);
      }
      if (tags !== undefined) {
        await executors.updateTags(id, tags);
      }
    } catch (error) {
      itemError = error;
    }
    const result: ImageUpdateItemResultDto = itemError
      ? { id, status: "failed", ...publicItemError(itemError) }
      : { id, status: "updated" };
    maxItemDurationMs = Math.max(
      maxItemDurationMs,
      performance.now() - itemStartedAt
    );
    return result;
  });
  const updated = results.filter(
    (result) => result.status === "updated"
  ).length;
  return {
    failed: items.length - updated,
    maxItemDurationMs,
    results,
    updated
  };
}
