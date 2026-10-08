import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { isSortOrder, slugMaxLength, sortOrderMax, sortOrderMin } from "@imageshow/shared/browser";
import { sortOrderRangeMessage } from "../actions/SortOrderInput.js";
import { StableButtonLabel } from "../data-display/StableButtonLabel.js";
import { ActionFeedbackOutlet, type ActionFeedbackTarget } from "../feedback/ActionFeedbackRegion.js";
import { AdminIcon } from "../icon/AdminIcon.js";
import { createActionFeedback } from "../../lib/ui/action-feedback.js";
import { FieldError } from "./FieldError.js";

export function useEntityCreateDraft() {
  const [slug, setSlug] = useState("");
  const [display, setDisplay] = useState("");
  const [sortOrder, setSortOrder] = useState("");
  return {
    slug,
    setSlug,
    display,
    setDisplay,
    sortOrder,
    setSortOrder,
    sortOrderInvalid: sortOrder !== "" && !isSortOrder(Number(sortOrder)),
    sortOrderValue: sortOrder === "" ? undefined : Number(sortOrder),
    reset: () => {
      setSlug("");
      setDisplay("");
      setSortOrder("");
    }
  };
}

/**
 * 分组与词表页共用的新建表单。标识错误紧贴输入框；排序越界与已有排序输入一样，
 * 在页头副标题说明允许范围。页面专有字段放在显示名与排序之间。
 */
export function EntityCreateForm({
  draft,
  noun,
  slugPlaceholder,
  slugError,
  slugInvalid,
  disabled,
  submitBlocked,
  pending,
  feedbackTarget,
  onSlugChange,
  onSubmit,
  children
}: {
  draft: ReturnType<typeof useEntityCreateDraft>;
  noun: string;
  slugPlaceholder: string;
  slugError: string;
  slugInvalid: boolean;
  disabled: boolean;
  submitBlocked: boolean;
  pending: boolean;
  feedbackTarget: ActionFeedbackTarget;
  onSlugChange: () => void;
  onSubmit: (event: FormEvent) => void;
  children?: ReactNode;
}) {
  const sortFeedback = useMemo(
    () => draft.sortOrderInvalid ? createActionFeedback(sortOrderRangeMessage, "error") : null,
    [draft.sortOrderInvalid]
  );
  return (
    <form className="admin-create-form" onSubmit={onSubmit}>
      <div className="admin-create-field entity-slug-field">
        <input
          className="entity-create-slug"
          value={draft.slug}
          placeholder={slugPlaceholder}
          aria-label={`${noun}标识`}
          maxLength={slugMaxLength}
          disabled={disabled}
          aria-invalid={Boolean(slugError)}
          onChange={(event) => {
            draft.setSlug(event.target.value.toLowerCase());
            onSlugChange();
          }}
        />
        <FieldError message={slugError} announce />
      </div>
      <input
        className="vocabulary-create-display"
        value={draft.display}
        placeholder="显示名（可选）"
        aria-label={`${noun}显示名`}
        maxLength={64}
        disabled={disabled}
        onChange={(event) => draft.setDisplay(event.target.value)}
      />
      {children}
      <input
        className="vocabulary-create-sort"
        type="number"
        step={1}
        min={sortOrderMin}
        max={sortOrderMax}
        value={draft.sortOrder}
        placeholder="排序（可选）"
        aria-label={`${noun}排序（可选）`}
        aria-invalid={draft.sortOrderInvalid}
        disabled={disabled}
        onChange={(event) => draft.setSortOrder(event.target.value)}
      />
      <button
        className="button vocabulary-create-button"
        type="submit"
        disabled={submitBlocked || !draft.slug.trim() || slugInvalid || draft.sortOrderInvalid}
      >
        <AdminIcon name="add-line" />
        <StableButtonLabel idle={`新建${noun}`} busyText="新建中" busy={pending} />
      </button>
      {sortFeedback && <ActionFeedbackOutlet target={feedbackTarget} feedback={sortFeedback} />}
    </form>
  );
}
