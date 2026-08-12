import { ImageThumbnail } from "../../../components/image/ImageThumbnail.js";
import { formatImageClassification, imageDisplayTitle } from "../../../lib/ui/formatters.js";
import type { AdminImageListItem, ImportJob } from "../../../lib/types.js";
import {
  importJobPreviewAvailable,
  importJobSourceLabel
} from "./duplicate-match.js";
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
  queueDuplicate,
  onOpenDetail,
  onPreview,
  onConfirm,
  onCancel
}: {
  libraryItems: AdminImageListItem[];
  queueDuplicate?: ImportJob;
  onOpenDetail: (item: AdminImageListItem, opener: HTMLElement) => void;
  onPreview: (target: ImportPreviewTarget) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const queuePositionText = queueDuplicate
    ? importPositionText(queueDuplicate)
    : "";
  const queueSource = queueDuplicate
    ? importJobSourceLabel(queueDuplicate)
    : "";
  const queuePreview = queueDuplicate?.preview ?? "";
  const queuePreviewFull = queueDuplicate?.previewFull || queuePreview;
  const queuePreviewAvailable = Boolean(
    queueDuplicate && importJobPreviewAvailable(queueDuplicate)
  );

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
              <ImageThumbnail
                src={item.thumb_url}
                size="small"
              />
              <span>{imageDisplayTitle(item)}</span>
              <small>{formatImageClassification(item)}</small>
            </button>
          ))}
          {queueDuplicate && (
            <button
              type="button"
              className="duplicate-item batch-duplicate-item"
              disabled={!queuePreviewAvailable}
              onClick={(event) => onPreview({
                src: queuePreviewFull,
                thumbSrc: queuePreview,
                width: queueDuplicate.width,
                height: queueDuplicate.height,
                opener: event.currentTarget,
              })}
            >
              {queuePreview
                ? (
                    <ImageThumbnail
                      src={queuePreview}
                      size="small"
                    />
                  )
                : <span className="image-thumbnail is-small" aria-hidden="true" />}
              <span className="duplicate-item-source" title={queueSource}>
                {queueSource}
              </span>
              <small>
                {queuePreviewAvailable
                  ? [
                      queuePositionText || "同批处理任务",
                      queueDuplicate.draft.theme,
                      `${queueDuplicate.draft.device}/${queueDuplicate.draft.brightness}`
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
