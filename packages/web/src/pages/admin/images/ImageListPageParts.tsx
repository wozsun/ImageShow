import { useEffect, type RefObject } from "react";
import { QueryErrorState } from "../../../components/feedback/QueryErrorState.js";
import { workspaceScrollContainer } from "../../../lib/ui/workspace-scroll.js";
import type { useImageAdminSelection } from "./useImageAdminSelection.js";

// 图片列表页与分组详情页共用的列表部件；两页不会同时挂载，区间选择说明共用一个 ID。
export const imageRangeSelectionHelpId = "admin-image-range-selection-help";

export function ImageListViewSwitch<View extends string>({
  options,
  value,
  disabled,
  onChange
}: {
  options: readonly { value: View; label: string }[];
  value: View;
  disabled: boolean;
  onChange: (next: View) => void;
}) {
  return (
    <div className="image-admin-view-switch">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ImageListSelectionBar({
  selection,
  disabled
}: {
  selection: ReturnType<typeof useImageAdminSelection>;
  disabled: boolean;
}) {
  const count = selection.selected.length;
  return (
    <div className="inline-actions image-list-selection">
      <span id={imageRangeSelectionHelpId} className="image-list-selection-help">
        按住 Shift 点击卡片主体，或按 Shift+Enter，可将图片作为连续选择的区间端点。
      </span>
      <label className="image-list-check-label">
        <input
          type="checkbox"
          checked={selection.allSelected}
          disabled={disabled}
          onChange={(event) => selection.selectAll(event.target.checked, disabled)}
        />
        全选
      </label>
      <span className={`image-list-selection-status${count ? "" : " is-empty"}`} role="status">
        {count ? `已选 ${count}` : "未选择图片"}
      </span>
    </div>
  );
}

/** 网格的读取失败、加载与空状态；ready 为假时（例如分组尚未确认）不显示空状态。 */
export function ImageGridStatus({
  navigation,
  reportContext,
  emptyText,
  waiting = false,
  ready = true
}: {
  navigation: {
    items: readonly unknown[];
    isError: boolean;
    error: unknown;
    isFetching: boolean;
    refetch: () => unknown;
  };
  reportContext: string;
  emptyText: string;
  waiting?: boolean;
  ready?: boolean;
}) {
  const empty = !navigation.items.length;
  return (
    <>
      {navigation.isError && (
        <QueryErrorState
          error={navigation.error}
          onRetry={() => void navigation.refetch()}
          reportContext={reportContext}
        />
      )}
      {empty && (waiting || navigation.isFetching) && <p className="muted">加载中</p>}
      {empty && ready && !navigation.isError && !navigation.isFetching && <p className="muted">{emptyText}</p>}
    </>
  );
}

/** 每个数字页与筛选范围都清空选择并从顶部开始，避免首屏卡片只露出残片。 */
export function useImageListPageReset(
  clearSelection: () => void,
  gridRef: RefObject<HTMLElement | null>,
  scopeKey: string,
  pageNumber: number
) {
  useEffect(() => {
    clearSelection();
    workspaceScrollContainer(gridRef.current)?.scrollTo({ top: 0, left: 0 });
  }, [clearSelection, gridRef, pageNumber, scopeKey]);
}
