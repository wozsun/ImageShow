import type { QueryClient } from "@tanstack/react-query";
import type { IngestionVocabularyDto } from "@imageshow/shared/browser";
import { readEditableImageSnapshots } from "../../../lib/api/image-edit.js";
import { ingestionVocabularyQueryOptions } from "../../../lib/api/ingestion-vocabulary.js";
import {
  invalidateImageData,
  invalidateImageDataAfterMetadataSave
} from "../../../lib/api/query-invalidation.js";
import { storageOptionsQueryOptions } from "../../../lib/api/storage-options.js";
import type {
  ImageEditorSource
} from "./image-editor-types.js";
import type {
  ImageEditorItem
} from "../../../lib/types.js";
import type { ImageMetadataSaveCommit } from "./image-editor-types.js";
// 单图与批量编辑共用同一懒加载能力入口。共享样式独占字段内部排布，编辑器专属
// 样式只负责卡片外框和宿主定位，因此即使浏览器并行预载 CSS，应用顺序也不会改变
// 属性位置；冷入口同样不依赖图片列表、内容接入窗口或另一种编辑入口碰巧加载样式。
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
): ImageEditorItem | null {
  if (source.deleted_at) return null;
  if (source.status && source.status !== "ready") return null;
  if (
    typeof source.original !== "string"
    || typeof source.object_key !== "string"
  ) {
    return null;
  }
  return source as ImageEditorItem;
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
  return items as ImageEditorItem[];
}

export async function prepareImageEditor(
  queryClient: QueryClient,
  sources: ImageEditorSource[]
): Promise<{
  items: ImageEditorItem[];
  vocabulary: IngestionVocabularyDto;
}> {
  const [vocabulary, , items] = await Promise.all([
    queryClient.fetchQuery(ingestionVocabularyQueryOptions),
    queryClient.fetchQuery(storageOptionsQueryOptions),
    loadEditableSnapshots(sources)
  ]);
  return { items, vocabulary };
}

export async function refreshImageEditorAfterSave<TAdjacentData>({
  queryClient,
  imageIds,
  commit,
  loadAdjacentData
}: {
  queryClient: QueryClient;
  imageIds: string[];
  commit?: ImageMetadataSaveCommit;
  loadAdjacentData?: () => Promise<TAdjacentData>;
}) {
  await (commit
    ? invalidateImageDataAfterMetadataSave(
        queryClient,
        commit.updates,
        commit.authoritativeItems
      )
    : invalidateImageData(queryClient));
  const snapshotRequest =
    commit === undefined
      ? readEditableImageSnapshots(imageIds)
      : commit.authoritativeItems === null
        ? Promise.reject(new Error("图片权威快照读取失败"))
        : Promise.resolve({ items: commit.authoritativeItems });
  const adjacentDataRequest: Promise<TAdjacentData | null> = loadAdjacentData
    && (commit === undefined || commit.updates.length > 0)
    ? loadAdjacentData()
    : Promise.resolve(null);
  const [snapshotResult, adjacentDataResult] = await Promise.allSettled([
    snapshotRequest,
    adjacentDataRequest
  ]);
  return { snapshotResult, adjacentDataResult };
}
