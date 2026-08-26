import { ImageThumbnail } from "../../../../../components/image/ImageThumbnail.js";
import { formatImageClassification, imageDisplayTitle } from "../../../../../lib/ui/formatters.js";
import type { AdminImageListItem } from "../../../../../lib/types.js";

export type IngestionPreviewTarget = {
  jobId: string;
  attemptKey: string;
  sessionId?: string;
  imageId?: string;
  src: string;
  thumbSrc: string;
  width?: number;
  height?: number;
  opener?: HTMLElement;
};

export function DuplicateMatchPanel({
  libraryItems,
  disabled,
  confirmDisabled,
  onOpenDetail,
  onConfirm,
  onCancel
}: {
  libraryItems: AdminImageListItem[];
  disabled: boolean;
  confirmDisabled?: boolean;
  onOpenDetail: (item: AdminImageListItem, opener: HTMLElement) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="duplicate-panel">
      <div className="duplicate-note">
        <strong>已存在相同的最终入库文件</strong>
        <span>确认后可继续提交副本，或取消此任务。</span>
      </div>
      <div className="duplicate-body">
        <div className="duplicate-list">
          {!libraryItems.length && (
            <small className="duplicate-loading">
              正在读取图库中的重复图片…
            </small>
          )}
          {libraryItems.map((item) => (
            <button
              type="button"
              key={item.id}
              className="duplicate-item"
              onClick={(event) => onOpenDetail(item, event.currentTarget)}
            >
              <ImageThumbnail
                src={item.thumb_url}
                size="small"
              />
              <span>{imageDisplayTitle(item)}</span>
              <small>{formatImageClassification(item)}</small>
            </button>
          ))}
        </div>
        <div className="inline-actions">
          <button
            type="button"
            onClick={onConfirm}
            disabled={disabled || confirmDisabled}
          >
            仍然提交
          </button>
          <button
            className="danger-button"
            type="button"
            onClick={onCancel}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
