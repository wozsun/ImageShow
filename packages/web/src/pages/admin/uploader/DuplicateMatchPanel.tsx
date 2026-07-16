import { ImageThumbnail } from "../../../components/image/ImageThumbnail.js";
import { formatImageClassification, imageDisplayTitle } from "../../../lib/ui/formatters.js";
import type { BatchDuplicateMatch, ImageItem } from "../../../lib/types.js";

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
  confirmMode,
  onOpenDetail,
  onPreview,
  onConfirm,
  onCancel
}: {
  libraryItems: ImageItem[];
  batchDuplicate?: BatchDuplicateMatch;
  confirmMode: boolean;
  onOpenDetail: (item: ImageItem, opener: HTMLElement) => void;
  onPreview: (target: ImportPreviewTarget) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const sourceText = batchDuplicate
    ? batchDuplicate.manifestLine
      ? `与 JSONL 第 ${batchDuplicate.manifestLine} 行的处理后文件重复`
      : "与同批处理任务的最终文件重复"
    : `与图库中 ${libraryItems.length} 张图片的最终文件重复`;

  return (
    <div className="duplicate-panel">
      <div className="duplicate-note">
        <strong>{confirmMode ? "已存在相同的最终入库文件" : "检测到重复图片，已自动跳过"}</strong>
        <span>{confirmMode ? "确认后可继续提交副本，或取消此任务。" : sourceText}</span>
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
                      batchDuplicate.manifestLine ? `JSONL 第 ${batchDuplicate.manifestLine} 行` : "同批处理任务",
                      batchDuplicate.theme,
                      `${batchDuplicate.device}/${batchDuplicate.brightness}`
                    ].filter(Boolean).join(" · ")
                  : "对应处理任务已移除"}
              </small>
            </button>
          )}
        </div>
        {confirmMode && (
          <div className="inline-actions">
            <button type="button" onClick={onConfirm}>仍然提交</button>
            <button className="danger-button" type="button" onClick={onCancel}>取消</button>
          </div>
        )}
      </div>
    </div>
  );
}
