import type { QueryClient } from "@tanstack/react-query";
import type {
  BatchImageSnapshotResponse,
  ImportVocabularyDto
} from "@imageshow/shared/browser";
import {
  imageEditSnapshotQueryOptions,
  readEditableImageSnapshots
} from "../../lib/api/image-edit.js";
import { importVocabularyQueryOptions } from "../../lib/api/import-vocabulary.js";
import {
  invalidateImageData,
  invalidateImageDataAfterDelete
} from "../../lib/api/query-invalidation.js";
import { storageOptionsQueryOptions } from "../../lib/api/storage-options.js";
import type {
  ImageEditorSource
} from "../../lib/image-editor-capability-loader.js";
import type {
  BatchEditableImageSnapshot
} from "../../lib/types.js";
import { BatchMetadataModal } from "./BatchMetadataModal.js";
import { ImageEditModal } from "./ImageEditModal.js";

export { BatchMetadataModal, ImageEditModal };

class ImageNotEditableError extends Error {
  constructor() {
    super("图片当前不可编辑");
    this.name = "ImageNotEditableError";
  }
}

function editableSnapshotFromSource(
  source: ImageEditorSource
): BatchEditableImageSnapshot | null {
  if (source.deleted_at) return null;
  if (source.status && source.status !== "ready") return null;
  if (
    typeof source.original !== "string"
    || typeof source.object_key !== "string"
  ) {
    return null;
  }
  return source as BatchEditableImageSnapshot;
}

async function loadEditableSnapshots(
  queryClient: QueryClient,
  sources: ImageEditorSource[]
) {
  if (!sources.length) throw new ImageNotEditableError();
  if (sources.some((source) => (
    source.deleted_at || (source.status && source.status !== "ready")
  ))) {
    throw new ImageNotEditableError();
  }

  const directItems = sources.map(editableSnapshotFromSource);
  if (directItems.every((item) => item !== null)) {
    return directItems;
  }

  const ids = sources.map((source) => source.id);
  const response = ids.length === 1
    ? await queryClient.fetchQuery(imageEditSnapshotQueryOptions(ids[0]))
    : await readEditableImageSnapshots(ids);
  const itemById = new Map(response.items.map((item) => [item.id, item]));
  const items = ids.map((id) => itemById.get(id));
  if (items.some((item) => !item)) throw new ImageNotEditableError();
  return items as BatchEditableImageSnapshot[];
}

export async function prepareImageEditor(
  queryClient: QueryClient,
  sources: ImageEditorSource[]
): Promise<{
  items: BatchEditableImageSnapshot[];
  vocabulary: ImportVocabularyDto;
}> {
  const [vocabulary, , items] = await Promise.all([
    queryClient.fetchQuery(importVocabularyQueryOptions),
    queryClient.fetchQuery(storageOptionsQueryOptions),
    loadEditableSnapshots(queryClient, sources)
  ]);
  return { items, vocabulary };
}

export async function refreshSingleImageAfterSave<TAdminInfo>({
  queryClient,
  imageId,
  authoritativeItems,
  loadAdminInfo
}: {
  queryClient: QueryClient;
  imageId: string;
  authoritativeItems?: BatchEditableImageSnapshot[] | null;
  loadAdminInfo?: () => Promise<TAdminInfo>;
}) {
  await invalidateImageData(queryClient);
  const snapshotRequest: Promise<BatchImageSnapshotResponse> =
    authoritativeItems
      ? Promise.resolve({ items: authoritativeItems })
      : queryClient.fetchQuery({
          ...imageEditSnapshotQueryOptions(imageId),
          staleTime: 0
        });
  const adminInfoRequest: Promise<TAdminInfo | null> = loadAdminInfo
    ? loadAdminInfo()
    : Promise.resolve(null);
  const [snapshotResult, adminInfoResult] = await Promise.allSettled([
    snapshotRequest,
    adminInfoRequest
  ]);
  return { snapshotResult, adminInfoResult };
}

export async function refreshSingleImageAfterDelete({
  queryClient,
  imageId,
  onDeleteCommitted
}: {
  queryClient: QueryClient;
  imageId: string;
  onDeleteCommitted?: (imageId: string) => void | Promise<void>;
}) {
  await onDeleteCommitted?.(imageId);
  await invalidateImageDataAfterDelete(queryClient, imageId);
}
