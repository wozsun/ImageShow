import { AdminIcon } from "../../icon/AdminIcon.js";
import { ImageDraftFields } from "../../form/ImageDraftFields.js";
import { ImageThumbnail } from "../ImageThumbnail.js";
import {
  formatBytes,
  formatDimensions,
  shortImageId
} from "../../../lib/ui/formatters.js";
import {
  cardBrightnessSelectOptions,
  editCardDeviceSelectOptions
} from "../../../lib/ui/select-options.js";
import type {
  FacetOption,
  ImageEditorItem,
  ImageDraft
} from "../../../lib/types.js";
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
  busy,
  themes,
  allTags,
  authors,
  storageName,
  onPatch,
  onRemove,
  onPreview
}: {
  item: ImageEditorItem;
  draft: ImageDraft;
  changed: ImageMetadataChanges;
  lastSaveReport: ImageMetadataSaveReport | null;
  multipleItems: boolean;
  busy: boolean;
  themes: FacetOption[];
  allTags: FacetOption[];
  authors: FacetOption[];
  storageName: string;
  onPatch: (patch: Partial<ImageDraft>) => void;
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
        <ImageThumbnail src={item.thumb_url} onClick={onPreview} />
        {item.image_size
          ? <span className="image-editor-preview-size">{formatBytes(item.image_size)}</span>
          : null}
      </div>
      <div className="image-editor-content">
        <div className="image-editor-head">
          <div>
            <div className="image-editor-head-name">
              <strong className="image-editor-title-desktop" title={item.object_key}>{item.id}</strong>
              <strong className="image-editor-title-mobile" title={item.id}>{shortImageId(item.id)}</strong>
              {saveStatePresentation ? (
                <span className={`image-editor-save-badge ${saveStatePresentation.badgeClassName}`}>
                  {saveStatePresentation.label}
                </span>
              ) : cardChanged ? (
                <span className="changed-badge">已修改</span>
              ) : null}
            </div>
            <span className="image-editor-desktop-summary">
              {formatDimensions(item.width, item.height)} · {item.theme} · {item.device}/{item.brightness} · {storageName}
            </span>
            <span className="image-editor-summary-line image-editor-mobile-summary">
              {formatDimensions(item.width, item.height)} · {item.device}/{item.brightness} · {item.theme}
            </span>
            <span className="image-editor-summary-line image-editor-mobile-summary">
              {item.image_size ? formatBytes(item.image_size) : "大小未记录"} · {storageName}
            </span>
          </div>
          {multipleItems && (
            <button
              className="icon danger-button"
              type="button"
              title="从批量编辑中移除"
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
        disabled={busy}
        ariaPrefix={item.id}
        changed={changed}
      />
    </article>
  );
}
