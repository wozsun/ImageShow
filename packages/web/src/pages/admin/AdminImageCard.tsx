import { Icon } from "../../components/icon/Icon.js";
import { ThumbImage } from "../../components/image/ThumbImage.js";
import type { ImageItem } from "../../lib/types.js";
import {
  formatDate,
  formatImageClassification,
  imageDisplayTitle
} from "../../lib/ui/formatters.js";

type AdminImageCardProps = {
  item: ImageItem;
  storageName: (item: {
    is_link: boolean;
    storage_slug: string;
  }) => string;
  checked: boolean;
  busy: boolean;
  actionsDisabled: boolean;
  onCheck: (checked: boolean) => void;
  onDetail: (opener: HTMLElement) => void;
  onEdit: (opener: HTMLElement) => void;
  onPurge: () => void;
  onDelete: () => void;
  onRestore: () => void;
};

export function AdminImageCard({
  item,
  storageName,
  checked,
  busy,
  actionsDisabled,
  onCheck,
  onDetail,
  onEdit,
  onPurge,
  onDelete,
  onRestore
}: AdminImageCardProps) {
  const title = imageDisplayTitle(item);
  const classification = formatImageClassification(item);
  const storage = item.status === "ready" ? storageName(item) : "";
  const deletedAt = item.status === "deleted" && item.deleted_at
    ? `删除于 ${formatDate(item.deleted_at)}`
    : "";

  return (
    <article
      className={`admin-image-card${busy ? " is-busy" : ""}`}
      aria-busy={busy}
    >
      <input
        id={`admin-image-select-${item.id}`}
        className="admin-image-card-checkbox"
        type="checkbox"
        checked={checked}
        disabled={busy || actionsDisabled}
        aria-label={`选择图片：${title}`}
        onChange={(event) => onCheck(event.target.checked)}
      />
      <button
        type="button"
        className="admin-image-card-detail"
        disabled={busy}
        aria-label={`查看图片详情：${title}`}
        onClick={(event) => onDetail(event.currentTarget)}
      >
        <span className="admin-image-card-thumb">
          <ThumbImage src={item.thumb_url} alt="" />
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
                disabled={actionsDisabled}
                onClick={(event) => onEdit(event.currentTarget)}
              >
                <Icon name="pencil-line" />
              </button>
              <button
                type="button"
                className="danger-button"
                title="删除"
                aria-label={`删除图片：${title}`}
                disabled={busy || actionsDisabled}
                onClick={onDelete}
              >
                <Icon name="delete-bin-6-line" />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                title="恢复"
                aria-label={`恢复图片：${title}`}
                disabled={busy || actionsDisabled}
                onClick={onRestore}
              >
                <Icon name="arrow-go-back-line" />
              </button>
              <button
                type="button"
                className="danger-button"
                title="永久删除"
                aria-label={`永久删除图片：${title}`}
                disabled={actionsDisabled}
                onClick={onPurge}
              >
                <Icon name="delete-bin-7-line" />
              </button>
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
        <Icon name="hard-drive-2-line" />
        <span>{storage}</span>
      </span>
    );
  }

  if (deletedAt) {
    return <span className={className} title={deletedAt}>{deletedAt}</span>;
  }
  return null;
}
