import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from "react";
import type { AdminImageListItem } from "../../../lib/types.js";
import {
  ImageListSelectionController,
  isImageSelectionPreservingTarget
} from "./image-list-selection.js";

/** Owns the current-page selection, range anchor, and background-click reset. */
export function useImageAdminSelection(items: readonly AdminImageListItem[]) {
  const [selected, setSelected] = useState<string[]>([]);
  const controllerRef = useRef(new ImageListSelectionController());
  const pageIds = useMemo(() => items
    .filter((item) => !item.purge_pending)
    .map((item) => item.id), [items]);

  const clear = useCallback(() => {
    controllerRef.current.reset();
    setSelected([]);
  }, []);

  useLayoutEffect(() => {
    const reconciled = controllerRef.current.reconcile(pageIds, selected);
    if (
      reconciled.length !== selected.length
      || reconciled.some((id, index) => id !== selected[index])
    ) {
      setSelected(reconciled);
    }
  }, [pageIds, selected]);

  const update = useCallback((
    targetId: string,
    checked: boolean,
    extendRange: boolean,
    busy: boolean
  ) => {
    setSelected((current) => controllerRef.current.update({
      pageIds,
      selectedIds: current,
      targetId,
      checked,
      extendRange,
      busy
    }));
  }, [pageIds]);

  const selectAll = useCallback((checked: boolean, busy: boolean) => {
    if (busy) return;
    controllerRef.current.reset();
    setSelected(checked ? pageIds : []);
  }, [pageIds]);

  const clearFromPageClick = useCallback((
    event: ReactMouseEvent<HTMLElement>,
    busy: boolean
  ) => {
    if (!selected.length || busy) return;
    const target = event.target;
    if (
      !(target instanceof Element)
      || !event.currentTarget.contains(target)
      || isImageSelectionPreservingTarget(target)
    ) return;
    clear();
  }, [clear, selected.length]);

  const selectedItems = useMemo(
    () => items.filter((item) => selected.includes(item.id)),
    [items, selected]
  );

  return {
    selected,
    selectedItems,
    allSelected: pageIds.length > 0 && selected.length === pageIds.length,
    clear,
    update,
    selectAll,
    clearFromPageClick
  };
}
