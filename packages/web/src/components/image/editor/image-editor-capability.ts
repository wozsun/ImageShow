import type { QueryClient } from "@tanstack/react-query";
import type { IngestionVocabularyDto, EditableImageSnapshotDto } from "@imageshow/shared/browser";
import { readEditableImageSnapshots } from "../../../lib/api/image-edit.js";
import { ingestionVocabularyQueryOptions } from "../../../lib/api/ingestion-vocabulary.js";
import {
  invalidateImageData,
  invalidateImageDataAfterMetadataSave
} from "../../../lib/api/query-invalidation.js";
import type { ImageEditorTarget, ImageMetadataSaveCommit } from "./image-editor-types.js";
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

async function loadEditableSnapshots(target: ImageEditorTarget) {
  if (target.items) {
    if (!target.items.length || target.items.some(
      (item) => item.deleted_at || (item.status && item.status !== "ready")
    )) {
      throw new ImageNotEditableError();
    }
    return target.items;
  }

  if (!target.ids.length) throw new ImageNotEditableError();
  const response = await readEditableImageSnapshots(target.ids);
  const itemById = new Map(response.items.map((item) => [item.id, item]));
  return target.ids.map((id) => {
    const item = itemById.get(id);
    if (!item) throw new ImageNotEditableError();
    return item;
  });
}

export async function prepareImageEditor(
  queryClient: QueryClient,
  target: ImageEditorTarget
): Promise<{
  items: EditableImageSnapshotDto[];
  vocabulary: IngestionVocabularyDto;
}> {
  const [vocabulary, items] = await Promise.all([
    queryClient.fetchQuery(ingestionVocabularyQueryOptions),
    loadEditableSnapshots(target)
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
  const adjacentDataRequest: Promise<TAdjacentData | null> =
    loadAdjacentData
      && (commit === undefined || commit.updates.length > 0)
      ? loadAdjacentData()
      : Promise.resolve(null);
  const [snapshotResult, adjacentDataResult] = await Promise.allSettled([
    snapshotRequest,
    adjacentDataRequest
  ]);
  return { snapshotResult, adjacentDataResult };
}
