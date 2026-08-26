import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { TwoStepConfirmIconButton } from "../../../components/actions/TwoStepConfirmIconButton.js";
import { ThumbImage } from "../../../components/image/ThumbImage.js";
import type { AdminImageListItem } from "../../../lib/types.js";
import {
  formatDate,
  formatImageClassification,
  imageDisplayTitle
} from "../../../lib/ui/formatters.js";
import { preloadIntentProps } from "../../../lib/ui/preload-intent.js";

type AdminImageCardProps = {
  item: AdminImageListItem;
  storageName: (item: {
    storage_slug: string;
  }) => string;
  checked: boolean;
  busy: boolean;
  actionsDisabled: boolean;
  canPurge: boolean;
  onCheck: (checked: boolean, extendRange: boolean) => void;
  onSelectRange: () => void;
  rangeSelectionHelpId: string;
  detailDisabled: boolean;
  detailPending: boolean;
  onPreloadDetail: () => void;
  onDetail: (opener: HTMLElement) => void;
  editDisabled: boolean;
  editPending: boolean;
  onPreloadEdit: () => void;
  onEdit: (opener: HTMLElement) => void;
  onPurge: () => void;
  onTrash: () => void;
  onRestore: () => void;
};

export function AdminImageCard({
  item,
  storageName,
  checked,
  busy,
  actionsDisabled,
  canPurge,
  onCheck,
  onSelectRange,
  rangeSelectionHelpId,
  detailDisabled,
  detailPending,
  onPreloadDetail,
  onDetail,
  editDisabled,
  editPending,
  onPreloadEdit,
  onEdit,
  onPurge,
  onTrash,
  onRestore
}: AdminImageCardProps) {
  const title = imageDisplayTitle(item);
  const classification = formatImageClassification(item);
  const storage = item.status === "ready" ? storageName(item) : "";
  const deletedAt = item.status === "deleted" && item.deleted_at
    ? `删除于 ${formatDate(item.deleted_at)}`
    : "";
  const selectionDisabled = busy || actionsDisabled || detailPending;

  return (
    <article
      className={`admin-image-card${checked ? " is-selected" : ""}${busy ? " is-busy" : ""}`}
      aria-busy={busy}
    >
      <label
        className="admin-image-card-checkbox-hit-area"
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          if (selectionDisabled) return;
          event.currentTarget.control?.focus();
          onCheck(!checked, event.shiftKey);
        }}
      >
        <input
          id={`admin-image-select-${item.id}`}
          className="admin-image-card-checkbox"
          type="checkbox"
          checked={checked}
          disabled={selectionDisabled}
          aria-label={`选择图片：${title}`}
          onChange={(event) => onCheck(
            event.target.checked,
            "shiftKey" in event.nativeEvent && event.nativeEvent.shiftKey === true
          )}
        />
      </label>
      <button
        type="button"
        className="admin-image-card-detail"
        disabled={busy || detailDisabled || detailPending}
        aria-busy={detailPending || undefined}
        aria-label={`查看图片详情：${title}`}
        aria-describedby={rangeSelectionHelpId}
        aria-keyshortcuts="Shift+Enter"
        {...preloadIntentProps(onPreloadDetail)}
        onClick={(event) => {
          if (event.shiftKey) {
            event.preventDefault();
            onSelectRange();
            return;
          }
          onDetail(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.shiftKey && event.key === "Enter") {
            event.preventDefault();
            onSelectRange();
          }
        }}
      >
        <span className="admin-image-card-thumb">
          <ThumbImage
            src={item.thumb_url}
            alt=""
          />
        </span>
        <span className="admin-image-card-main">
          <strong title={title}>{title}</strong>
          <span title={classification}>{classification}</span>
          <AdminImageCardMetadata
            placement="inline"
            storage={storage}
            deletedAt={deletedAt}
          />
        </span>
      </button>
      <footer className="admin-image-card-footer">
        <AdminImageCardMetadata
          placement="footer"
          storage={storage}
          deletedAt={deletedAt}
        />
        <div className="admin-image-card-actions">
          {item.status === "ready" ? (
            <>
              <button
                type="button"
                title="编辑"
                aria-label={`编辑图片：${title}`}
                aria-busy={editPending || undefined}
                disabled={busy || editDisabled || editPending}
                {...preloadIntentProps(onPreloadEdit)}
                onClick={(event) => onEdit(event.currentTarget)}
              >
                <AdminIcon name="pencil-line" />
              </button>
              <TwoStepConfirmIconButton
                className="danger-button"
                idleIcon="delete-bin-6-line"
                confirmIcon="delete-bin-2-line"
                idleLabel={`删除图片：${title}`}
                confirmLabel={`再次点击确认删除图片：${title}`}
                idleTitle="删除"
                confirmTitle="再次点击确认删除"
                disabled={busy || actionsDisabled || detailPending}
                busy={busy}
                onConfirm={onTrash}
              />
            </>
          ) : (
            <>
              <button
                type="button"
                title="恢复"
                aria-label={`恢复图片：${title}`}
                disabled={busy || actionsDisabled || detailPending}
                onClick={onRestore}
              >
                <AdminIcon name="arrow-go-back-line" />
              </button>
              {canPurge && (
                <TwoStepConfirmIconButton
                  className="danger-button"
                  idleIcon="delete-bin-7-line"
                  confirmIcon="delete-bin-2-line"
                  idleLabel={`永久删除图片：${title}`}
                  confirmLabel={`再次点击确认永久删除图片：${title}`}
                  idleTitle="永久删除"
                  confirmTitle="再次点击确认永久删除"
                  disabled={busy || actionsDisabled || detailPending}
                  busy={busy}
                  onConfirm={onPurge}
                />
              )}
            </>
          )}
        </div>
      </footer>
    </article>
  );
}

function AdminImageCardMetadata({
  placement,
  storage,
  deletedAt
}: {
  placement: "inline" | "footer";
  storage: string;
  deletedAt: string;
}) {
  const className = `admin-image-card-meta is-${placement}`;

  if (storage) {
    return (
      <span className={className} title={`存储：${storage}`}>
        <AdminIcon name="hard-drive-2-line" />
        <span>{storage}</span>
      </span>
    );
  }

  if (deletedAt) {
    return <span className={className} title={deletedAt}>{deletedAt}</span>;
  }
  return null;
}
