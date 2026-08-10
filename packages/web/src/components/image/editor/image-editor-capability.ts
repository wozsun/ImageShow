import type { QueryClient } from "@tanstack/react-query";
import type { ImportVocabularyDto } from "@imageshow/shared/browser";
import { readEditableImageSnapshots } from "../../../lib/api/image-edit.js";
import { importVocabularyQueryOptions } from "../../../lib/api/import-vocabulary.js";
import {
  invalidateImageData,
  invalidateImageDataAfterDelete
} from "../../../lib/api/query-invalidation.js";
import { storageOptionsQueryOptions } from "../../../lib/api/storage-options.js";
import type {
  ImageEditorSource
} from "./image-editor-types.js";
import type {
  EditableImageSnapshot
} from "../../../lib/types.js";
// 单图与批量编辑共用同一懒加载能力入口。共享样式独占字段内部排布，编辑器专属
// 样式只负责卡片外框和宿主定位，因此即使浏览器并行预载 CSS，应用顺序也不会改变
// 属性位置；冷入口同样不依赖图片列表、上传窗口或另一种编辑入口碰巧加载样式。
import "../../../styles/admin/semantic-colors.css";
import "../../../styles/admin/controls.css";
import "../../../styles/admin/image-workflow.css";
import "../../../styles/admin/image-edit.css";
import { ImageMetadataEditorDialog } from "./ImageMetadataEditorDialog.js";

export { ImageMetadataEditorDialog };

class ImageNotEditableError extends Error {
  constructor() {
    super("图片当前不可编辑");
    this.name = "ImageNotEditableError";
  }
}

function editableSnapshotFromSource(
  source: ImageEditorSource
): EditableImageSnapshot | null {
  if (source.deleted_at) return null;
  if (source.status && source.status !== "ready") return null;
  if (
    typeof source.original !== "string"
    || typeof source.object_key !== "string"
  ) {
    return null;
  }
  return source as EditableImageSnapshot;
}

async function loadEditableSnapshots(
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
  const response = await readEditableImageSnapshots(ids);
  const itemById = new Map(response.items.map((item) => [item.id, item]));
  const items = ids.map((id) => itemById.get(id));
  if (items.some((item) => !item)) throw new ImageNotEditableError();
  return items as EditableImageSnapshot[];
}

export async function prepareImageEditor(
  queryClient: QueryClient,
  sources: ImageEditorSource[]
): Promise<{
  items: EditableImageSnapshot[];
  vocabulary: ImportVocabularyDto;
}> {
  const [vocabulary, , items] = await Promise.all([
    queryClient.fetchQuery(importVocabularyQueryOptions),
    queryClient.fetchQuery(storageOptionsQueryOptions),
    loadEditableSnapshots(sources)
  ]);
  return { items, vocabulary };
}

export async function refreshImageEditorAfterSave<TAdjacentData>({
  queryClient,
  imageIds,
  authoritativeItems,
  loadAdjacentData
}: {
  queryClient: QueryClient;
  imageIds: string[];
  authoritativeItems?: EditableImageSnapshot[] | null;
  loadAdjacentData?: () => Promise<TAdjacentData>;
}) {
  await invalidateImageData(queryClient);
  const snapshotRequest =
    authoritativeItems === undefined
      ? readEditableImageSnapshots(imageIds)
      : authoritativeItems === null
        ? Promise.reject(new Error("图片权威快照读取失败"))
        : Promise.resolve({ items: authoritativeItems });
  const adjacentDataRequest: Promise<TAdjacentData | null> = loadAdjacentData
    ? loadAdjacentData()
    : Promise.resolve(null);
  const [snapshotResult, adjacentDataResult] = await Promise.allSettled([
    snapshotRequest,
    adjacentDataRequest
  ]);
  return { snapshotResult, adjacentDataResult };
}

export async function refreshImageEditorAfterDelete({
  queryClient,
  imageIds,
  onDeleteCommitted
}: {
  queryClient: QueryClient;
  imageIds: string[];
  onDeleteCommitted?: (imageIds: string[]) => void | Promise<void>;
}) {
  await onDeleteCommitted?.(imageIds);
  await invalidateImageDataAfterDelete(queryClient, imageIds);
}
