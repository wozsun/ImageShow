import { ImageThumbnail } from "../../../components/image/ImageThumbnail.js";
import { formatImageClassification, imageDisplayTitle } from "../../../lib/ui/formatters.js";
import type { BatchDuplicateMatch, ImageItem } from "../../../lib/types.js";
import { importPositionText } from "./import-job-utils.js";

export type ImportPreviewTarget = {
  src: string;
  thumbSrc: string;
  width?: number;
  height?: number;
  opener?: HTMLElement;
};

export function DuplicateMatchPanel({
  libraryItems,
  batchDuplicate,
  onOpenDetail,
  onPreview,
  onConfirm,
  onCancel
}: {
  libraryItems: ImageItem[];
  batchDuplicate?: BatchDuplicateMatch;
  onOpenDetail: (item: ImageItem, opener: HTMLElement) => void;
  onPreview: (target: ImportPreviewTarget) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const batchPositionText = batchDuplicate ? importPositionText(batchDuplicate) : "";

  return (
    <div className="duplicate-panel">
      <div className="duplicate-note">
        <strong>已存在相同的最终入库文件</strong>
        <span>确认后可继续提交副本，或取消此任务。</span>
      </div>
      <div className="duplicate-body">
        <div className="duplicate-list">
          {libraryItems.map((item) => (
            <button
              type="button"
              key={item.id}
              className="duplicate-item"
              onClick={(event) => onOpenDetail(item, event.currentTarget)}
            >
              <ImageThumbnail src={item.thumb_url} size="small" />
              <span>{imageDisplayTitle(item)}</span>
              <small>{formatImageClassification(item)}</small>
            </button>
          ))}
          {batchDuplicate && (
            <button
              type="button"
              className="duplicate-item batch-duplicate-item"
              disabled={!batchDuplicate.available}
              onClick={(event) => onPreview({
                src: batchDuplicate.previewFull,
                thumbSrc: batchDuplicate.preview,
                width: batchDuplicate.width,
                height: batchDuplicate.height,
                opener: event.currentTarget,
              })}
            >
              {batchDuplicate.preview
                ? <ImageThumbnail src={batchDuplicate.preview} size="small" />
                : <span className="image-thumbnail is-small" aria-hidden="true" />}
              <span className="duplicate-item-source" title={batchDuplicate.original}>
                {batchDuplicate.original}
              </span>
              <small>
                {batchDuplicate.available
                  ? [
                      batchPositionText || "同批处理任务",
                      batchDuplicate.theme,
                      `${batchDuplicate.device}/${batchDuplicate.brightness}`
                    ].filter(Boolean).join(" · ")
                  : "来源预览暂不可用"}
              </small>
            </button>
          )}
        </div>
        <div className="inline-actions">
          <button type="button" onClick={onConfirm}>仍然提交</button>
          <button className="danger-button" type="button" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  );
}
