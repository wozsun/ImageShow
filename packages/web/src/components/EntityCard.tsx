import { useState, type DragEvent } from "react";
import { api } from "../lib/api.js";
import { Icon } from "./Icon.js";
import { adminApiBasePath } from "../lib/constants.js";
import { errorMessage } from "../lib/formatters.js";

type Entity = { slug: string; display_name: string; image_count: number; link?: string };

// Shared card for the 主题/标签/作者 management pages: a fixed-width slug chip keeps every
// 显示名 input aligned across cards, with the count + 保存/拖动/删除 actions in the footer,
// plus a select checkbox for batch delete. Authors additionally edit a 链接 input row.
// `pinned` renders the read-only 'none'/未设置 sentinel (theme/author pages): no select, no
// drag, no delete. Dragging is armed only while the grip handle is held (left of delete), so
// the card isn't draggable by its body/inputs.
export function EntityCard({ kind, item, onChanged, onDelete, onError, pinned = false, selected = false, onToggleSelect, onDragStart, onDragEnter, onDragEnd }: {
  kind: "themes" | "tags" | "authors";
  item: Entity;
  onChanged: () => void;
  onDelete: () => void;
  onError: (message: string) => void;
  pinned?: boolean;
  selected?: boolean;
  onToggleSelect?: (checked: boolean) => void;
  onDragStart?: (slug: string) => void;
  onDragEnter?: (slug: string) => void;
  onDragEnd?: () => void;
}) {
  const noun = kind === "themes" ? "主题" : kind === "tags" ? "标签" : "作者";
  // Authors carry an extra editable link beyond the display name.
  const isAuthor = kind === "authors";
  const [display, setDisplay] = useState(item.display_name);
  const [link, setLink] = useState(item.link ?? "");
  const [busy, setBusy] = useState(false);
  // The card is only draggable while the grip handle is pressed, so the body/inputs stay
  // normally interactive.
  const [armed, setArmed] = useState(false);
  const dirty = display !== item.display_name || (isAuthor && link.trim() !== (item.link ?? ""));

  const save = async () => {
    setBusy(true);
    onError("");
    try {
      const body = isAuthor ? { display_name: display.trim(), link: link.trim() } : { display_name: display.trim() };
      await api(`${adminApiBasePath}/${kind}/${item.slug}`, { method: "POST", body: JSON.stringify(body) });
      onChanged();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const begin = (event: DragEvent<HTMLDivElement>) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.slug); // Firefox needs data set to drag
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
        {!pinned && (
          <input
            type="checkbox"
            className="entity-select"
            checked={selected}
            onChange={(event) => onToggleSelect?.(event.target.checked)}
            aria-label={`选择${noun} ${item.slug}`}
          />
        )}
        <code className="entity-slug" title={item.slug}>{item.slug}</code>
        {pinned
          ? <span className="entity-display-static">{item.display_name || "未设置"}</span>
          : (
            <input
              className="entity-display-input"
              value={display}
              onChange={(event) => setDisplay(event.target.value)}
              placeholder="显示名"
              disabled={busy}
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
            placeholder="链接 URL（http(s)，可选）"
            disabled={busy}
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
              {dirty && (
                <button type="button" className="button" disabled={busy} onClick={save}>
                  <Icon name="save-3-line" />保存
                </button>
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
                disabled={busy}
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
