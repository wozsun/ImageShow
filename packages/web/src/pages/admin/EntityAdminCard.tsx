import { useState, type DragEvent } from "react";
import { api } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { AsyncActionButton } from "../../components/actions/AsyncActionButton.js";
import { SlugChip } from "../../components/data-display/SlugChip.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";

type Entity = { slug: string; display_name: string; image_count: number; link?: string };

export function EntityAdminCard({ kind, item, onChanged, onDelete, onError, pinned = false, selected = false, onToggleSelect, onDragStart, onDragEnter, onDragEnd }: {
  kind: "themes" | "tags" | "authors";
  item: Entity;
  onChanged: () => void;
  onDelete: () => void;
  onError: (error: unknown) => void;
  pinned?: boolean;
  selected?: boolean;
  onToggleSelect?: (checked: boolean) => void;
  onDragStart?: (slug: string) => void;
  onDragEnter?: (slug: string) => void;
  onDragEnd?: () => void;
}) {
  const noun = kind === "themes" ? "主题" : kind === "tags" ? "标签" : "作者";

  const isAuthor = kind === "authors";
  const [display, setDisplay] = useState(item.display_name);
  const [link, setLink] = useState(item.link ?? "");
  const saveStatus = useAsyncActionStatus();

  const [armed, setArmed] = useState(false);
  const dirty = display !== item.display_name || (isAuthor && link.trim() !== (item.link ?? ""));
  const savePresentation = {
    idle: { icon: "save-3-line", label: "保存" },
    pending: { icon: "save-3-line", label: "保存中" },
    success: { icon: "check-line", label: "已保存" },
    error: { icon: "close-line", label: "保存失败" }
  } as const;

  const save = async () => {
    await saveStatus.run(async () => {
      try {
        const body = isAuthor
          ? { display_name: display.trim(), link: link.trim() }
          : { display_name: display.trim() };
        await api(`${adminApiBasePath}/${kind}/${item.slug}`, {
          method: "POST",
          body: JSON.stringify(body)
        });
        onChanged();
        return true;
      } catch (error) {
        onError(error);
        return false;
      }
    });
  };

  const begin = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.slug);
    onDragStart?.(item.slug);
  };

  return (
    <div
      className={`entity-card${pinned ? " is-pinned" : ""}${selected ? " is-selected" : ""}${armed ? " is-dragging" : ""}`}
      draggable={armed}
      onDragStart={begin}
      onDragEnter={() => { if (!pinned) onDragEnter?.(item.slug); }}
      onDragOver={(event) => { if (!pinned) event.preventDefault(); }}
      onDragEnd={() => { setArmed(false); onDragEnd?.(); }}
    >
      <div className="entity-card-row">
        {pinned
          ? <span className="entity-select-placeholder" aria-hidden="true" />
          : (
            <input
              type="checkbox"
              className="entity-select"
              checked={selected}
              onChange={(event) => onToggleSelect?.(event.target.checked)}
              aria-label={`选择${noun} ${item.slug}`}
            />
          )}
        <SlugChip value={item.slug} ariaLabel={`${noun} slug`} />
        {pinned
          ? (
            // none 卡片同样用输入框（禁用、不可编辑），与其他卡片的显示名框完全对齐。
            <input
              className="entity-display-input"
              value={item.display_name || "未设置"}
              disabled
              aria-label="未设置（不可编辑）"
            />
          )
          : (
            <input
              className="entity-display-input"
              value={display}
              onChange={(event) => setDisplay(event.target.value)}
              placeholder="显示名"
              disabled={saveStatus.pending}
              maxLength={64}
            />
          )}
      </div>
      {isAuthor && !pinned && (
        <div className="entity-card-row entity-card-link-row">
          <input
            className="entity-link-input"
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="链接 URL（HTTPS，可选）"
            disabled={saveStatus.pending}
            maxLength={2048}
            aria-label={`作者 ${item.slug} 链接`}
          />
        </div>
      )}
      <div className="entity-card-foot">
        <span className="muted entity-count">{item.image_count} 张</span>
        {pinned
          ? <span className="muted entity-pinned-note">未设置主题的图片归于此</span>
          : (
            <>
              {(dirty || saveStatus.status !== "idle") && (
                <AsyncActionButton
                  type="button"
                  className="button"
                  status={saveStatus.status}
                  presentation={savePresentation}
                  disabled={saveStatus.pending || (!dirty && saveStatus.status === "idle")}
                  onClick={() => void save()}
                />
              )}
              <button
                type="button"
                className="icon entity-drag-handle"
                title={`按住拖动排序`}
                aria-label="拖动排序"
                onMouseDown={() => setArmed(true)}
                onMouseUp={() => setArmed(false)}
              >
                <Icon name="drag-move-2-fill" />
              </button>
              <button
                className="icon danger-button"
                type="button"
                disabled={saveStatus.pending}
                title={`删除${noun}`}
                onClick={onDelete}
              >
                <Icon name="delete-bin-6-line" />
              </button>
            </>
          )}
      </div>
    </div>
  );
}
