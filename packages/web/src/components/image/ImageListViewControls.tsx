import type { AdminImageSort, AdminPreferenceValues } from "@imageshow/shared/browser";

export function ImageListViewControls({
  sort,
  thumbnailFit,
  disabled,
  onSortChange,
  onThumbnailFitChange
}: {
  sort: Readonly<AdminImageSort>;
  thumbnailFit: AdminPreferenceValues["image_thumbnail_fit"];
  disabled: boolean;
  onSortChange: (value: AdminImageSort) => void;
  onThumbnailFitChange: (value: AdminPreferenceValues["image_thumbnail_fit"]) => void;
}) {
  const sortFieldLabel = sort.sort_by === "image_time" ? "图片" : "入库";
  const nextSortFieldLabel = sort.sort_by === "image_time" ? "入库" : "图片";
  const sortOrderLabel = sort.order === "latest" ? "最新" : "最旧";
  const nextSortOrderLabel = sort.order === "latest" ? "最旧" : "最新";
  const thumbnailFitLabel = thumbnailFit === "cover" ? "填充" : "完整";
  const thumbnailFitHelp = thumbnailFit === "cover"
    ? "缩略图填充显示；点击完整显示，保留比例且不裁切"
    : "缩略图完整显示；点击填充显示，铺满图片框";
  return (
    <div className="image-list-view-controls" role="group" aria-label="图片列表排序与缩略图显示">
      <button
        type="button"
        className="state-toggle-button"
        data-shifted={sort.sort_by === "created_at"}
        disabled={disabled}
        aria-label={`按${sortFieldLabel}时间排序；点击切换为${nextSortFieldLabel}时间`}
        title={`按${sortFieldLabel}时间排序；点击切换为${nextSortFieldLabel}时间`}
        onClick={() =>
          onSortChange({
            ...sort,
            sort_by: sort.sort_by === "image_time" ? "created_at" : "image_time"
          })
        }
      >
        <span className="state-toggle-label">{sortFieldLabel}</span>
        <span className="state-toggle-thumb" aria-hidden="true" />
      </button>
      <span className="image-list-view-divider" aria-hidden="true" />
      <button
        type="button"
        className="state-toggle-button"
        data-shifted={sort.order === "oldest"}
        disabled={disabled}
        aria-label={`${sortOrderLabel}优先；点击切换为${nextSortOrderLabel}优先`}
        title={`${sortOrderLabel}优先；点击切换为${nextSortOrderLabel}优先`}
        onClick={() =>
          onSortChange({
            ...sort,
            order: sort.order === "latest" ? "oldest" : "latest"
          })
        }
      >
        <span className="state-toggle-label">{sortOrderLabel}</span>
        <span className="state-toggle-thumb" aria-hidden="true" />
      </button>
      <span className="image-list-view-divider" aria-hidden="true" />
      <button
        type="button"
        className="state-toggle-button"
        data-shifted={thumbnailFit === "contain"}
        disabled={disabled}
        aria-label={thumbnailFitHelp}
        aria-pressed={thumbnailFit === "contain"}
        title={thumbnailFitHelp}
        onClick={() => onThumbnailFitChange(thumbnailFit === "cover" ? "contain" : "cover")}
      >
        <span className="state-toggle-label">{thumbnailFitLabel}</span>
        <span className="state-toggle-thumb" aria-hidden="true" />
      </button>
    </div>
  );
}
