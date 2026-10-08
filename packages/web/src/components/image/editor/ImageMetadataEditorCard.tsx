import {
  imageVariantUrl,
  storageObjectKey,
  type FacetOptionDto,
  type EditableImageSnapshotDto,
  type ImageDraftDto
} from "@imageshow/shared/browser";
import { AdminIcon } from "../../icon/AdminIcon.js";
import { ImageDraftFields } from "../../form/ImageDraftFields.js";
import { ImageThumbnailFrame } from "../ImageThumbnailFrame.js";
import {
  formatBytes,
  formatDimensions,
  formatImageClassification,
  shortImageId
} from "../../../lib/ui/formatters.js";
import {
  cardBrightnessSelectOptions,
  editCardDeviceSelectOptions
} from "../../../lib/ui/select-options.js";
import type { ImageEditorIntent } from "./image-editor-types.js";
import {
  imageMetadataCardSaveState,
  type ImageMetadataChanges,
  type ImageMetadataSaveReport
} from "./image-metadata-session.js";

export function ImageMetadataEditorCard({
  item,
  draft,
  changed,
  lastSaveReport,
  multipleItems,
  intent,
  busy,
  themes,
  allTags,
  authors,
  storageName,
  onPatch,
  onRemove,
  onPreview
}: {
  item: EditableImageSnapshotDto;
  draft: ImageDraftDto;
  changed: ImageMetadataChanges;
  lastSaveReport: ImageMetadataSaveReport | null;
  multipleItems: boolean;
  intent: ImageEditorIntent;
  busy: boolean;
  themes: FacetOptionDto[];
  allTags: FacetOptionDto[];
  authors: FacetOptionDto[];
  storageName: string;
  onPatch: (patch: Partial<ImageDraftDto>) => void;
  onRemove: () => void;
  onPreview: (opener: HTMLElement) => void;
}) {
  const cardChanged = Object.values(changed).some(Boolean);
  const lastSaveState = imageMetadataCardSaveState(lastSaveReport, item.id);
  // A new edit supersedes an earlier success badge. Failed and pending cards
  // retain their feedback because the draft still needs another save or an
  // authoritative confirmation.
  const cardSaveState = cardChanged && lastSaveState === "saved"
    ? null
    : lastSaveState;
  const saveStatePresentation = cardSaveState
    ? {
        saved: {
          rowClassName: "is-save-saved",
          badgeClassName: "is-saved",
          label: "保存成功"
        },
        failed: {
          rowClassName: "is-save-failed",
          badgeClassName: "is-failed",
          label: "保存失败"
        },
        pending: {
          rowClassName: "is-save-pending",
          badgeClassName: "is-pending",
          label: "待确认"
        }
      }[cardSaveState]
    : null;

  return (
    <article
      className={`image-editor-row${cardChanged ? " is-changed" : ""}${saveStatePresentation ? ` ${saveStatePresentation.rowClassName}` : ""}`}
    >
      <div className="image-editor-preview">
        <ImageThumbnailFrame src={imageVariantUrl(item, "small")} onClick={onPreview} />
        {item.variants.large.byte_size ? (
          <span className="image-editor-preview-size">{formatBytes(item.variants.large.byte_size)}</span>
        ) : null}
      </div>
      <div className="image-editor-content">
        <div className="image-editor-head">
          <div>
            <div className="image-editor-head-name">
              <strong
                className="image-editor-title-desktop"
                title={storageObjectKey(item.id)}
              >
                {item.id}
              </strong>
              <strong className="image-editor-title-mobile" title={item.id}>
                {shortImageId(item.id)}
              </strong>
              {saveStatePresentation ? (
                <span className={`image-editor-save-badge ${saveStatePresentation.badgeClassName}`}>
                  {saveStatePresentation.label}
                </span>
              ) : cardChanged ? (
                <span className="changed-badge">已修改</span>
              ) : null}
            </div>
            <span className="image-editor-desktop-summary">
              {formatDimensions(item.variants.large.width, item.variants.large.height)} · {formatImageClassification(item)} ·{" "}
              {storageName}
            </span>
            <span className="image-editor-summary-line image-editor-mobile-summary">
              {formatDimensions(item.variants.large.width, item.variants.large.height)} · {formatImageClassification(item)}
            </span>
            <span className="image-editor-summary-line image-editor-mobile-summary">
              {item.variants.large.byte_size ? formatBytes(item.variants.large.byte_size) : "大小未记录"} · {storageName}
            </span>
          </div>
          {(multipleItems || intent !== "edit") && (
            <button
              className="icon danger-button"
              type="button"
              title={intent === "edit" ? "从批量编辑中移除" : intent === "delete" ? "从批量删除中移除" : "从本次操作中移除"}
              disabled={busy}
              onClick={onRemove}
            >
              <AdminIcon name="close-line" />
            </button>
          )}
        </div>
      </div>
      <ImageDraftFields
        draft={draft}
        onPatch={onPatch}
        themes={themes}
        allTags={allTags}
        authors={authors}
        deviceOptions={editCardDeviceSelectOptions}
        brightnessOptions={cardBrightnessSelectOptions}
        disabled={busy || intent !== "edit"}
        ariaPrefix={item.id}
        changed={changed}
      />
    </article>
  );
}
