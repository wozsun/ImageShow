import { useLayoutEffect, useState } from "react";
import { useNavigate } from "react-router";
import { adminApiBasePath, adminBasePath, type ImageGroupDto } from "@imageshow/shared/browser";
import { api } from "../../../lib/api/client.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { SaveOrDeleteButton } from "../../../components/actions/SaveOrDeleteButton.js";
import { SortOrderInput } from "../../../components/actions/SortOrderInput.js";
import { SlugChip } from "../../../components/data-display/SlugChip.js";
import type { ActionFeedbackTarget } from "../../../components/feedback/ActionFeedbackRegion.js";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";

export function GroupAdminItem({
  item, viewMode, canDelete, busy, feedbackTarget, onSortSave, onChanged, onDelete
}: {
  item: ImageGroupDto;
  viewMode: "list" | "card";
  canDelete: boolean;
  busy: boolean;
  feedbackTarget: ActionFeedbackTarget;
  onSortSave: (value: number) => Promise<number>;
  onChanged: () => Promise<unknown>;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ display: item.display_name, saved: item.display_name });
  useLayoutEffect(() => {
    setForm((current) => ({
      display: current.display === current.saved ? item.display_name : current.display,
      saved: item.display_name
    }));
  }, [item.display_name]);
  const saving = useAsyncActionStatus();
  const dirty = form.display !== form.saved;
  const disabled = busy || saving.pending;
  const open = () => {
    if (!disabled) void navigate(`${adminBasePath}/groups/${item.slug}`);
  };
  const save = () => saving.run(async () => {
    const display = form.display.trim();
    try {
      await api(`${adminApiBasePath}/groups/${item.slug}`, {
        method: "POST", body: JSON.stringify({ display_name: display })
      });
      setForm({ display, saved: display });
      await onChanged();
      return true;
    } catch (error) {
      reportAdminUiError("group_admin.rename", error);
      return false;
    }
  });
  const cellRole = viewMode === "list" ? "cell" : undefined;
  return (
    <div
      className="vocabulary-item group-admin-item"
      data-group-slug={item.slug}
      role={viewMode === "list" ? "row" : "listitem"}
      tabIndex={0}
      aria-label={`打开分组 ${item.display_name || item.slug}`}
      onClick={(event) => {
        if ((event.target as Element).closest("button, input, a")) return;
        open();
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && event.key === "Enter") {
          event.preventDefault();
          open();
        }
      }}
    >
      <div className="vocabulary-item-identity">
        <div className="vocabulary-cell vocabulary-cell-slug" role={cellRole}>
          <SlugChip value={item.slug} ariaLabel={`分组 ${item.slug} 标识`} />
        </div>
        <div className="vocabulary-cell vocabulary-cell-display" role={cellRole}>
          <input
            className="vocabulary-display-input"
            aria-label={`分组 ${item.slug} 显示名`}
            placeholder="显示名"
            maxLength={64}
            disabled={disabled}
            value={form.display}
            onChange={(event) => {
              saving.reset();
              setForm({ ...form, display: event.target.value });
            }}
          />
        </div>
      </div>
      <div className="vocabulary-item-footer">
        <div className="vocabulary-cell vocabulary-cell-count" role={cellRole}>
          <span className="muted" title="图库中的分组成员">{item.image_count} 张</span>
        </div>
        <div className="vocabulary-cell vocabulary-cell-sort" role={cellRole}>
          <SortOrderInput itemLabel={`分组 ${item.slug}`} value={item.sort_order}
            disabled={disabled} feedbackTarget={feedbackTarget} onSave={onSortSave} />
        </div>
        <div className="vocabulary-cell vocabulary-cell-actions" role={cellRole}>
          <div className="vocabulary-item-actions">
            <SaveOrDeleteButton
              itemLabel={`分组 ${item.slug}`}
              status={saving.status}
              dirty={dirty}
              canDelete={canDelete}
              disabled={disabled}
              onSave={() => void save()}
              onDelete={onDelete}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
