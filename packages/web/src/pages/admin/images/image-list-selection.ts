type ImageRangeSelectionOptions = {
  pageIds: string[];
  selectedIds: string[];
  anchorId: string | null;
  targetId: string;
  checked: boolean;
};

type ImageSelectionUpdateOptions = Omit<ImageRangeSelectionOptions, "anchorId"> & {
  extendRange: boolean;
  busy: boolean;
};

const imageSelectionPreservingTargetSelector = [
  ".admin-image-grid",
  ".overlay-scrollbar",
  ".overlay-scrollbar-handle",
  "a",
  "button",
  "input",
  "label",
  "select",
  "textarea",
  "[contenteditable='true']",
  "[role='button']",
  "[role='menuitem']",
  "[role='option']",
  "[role='switch']"
].join(",");

export function isImageSelectionPreservingTarget(target: {
  closest: (selector: string) => unknown;
}) {
  return target.closest(imageSelectionPreservingTargetSelector) !== null;
}

function selectedIdsInPageOrder(pageIds: string[], selectedIds: string[]) {
  const selected = new Set(selectedIds);
  return pageIds.filter((id) => selected.has(id));
}

function updateSingleImageSelection(
  pageIds: string[],
  selectedIds: string[],
  targetId: string,
  checked: boolean
) {
  const selected = new Set(selectedIdsInPageOrder(pageIds, selectedIds));
  if (checked) selected.add(targetId);
  else selected.delete(targetId);
  return pageIds.filter((id) => selected.has(id));
}

function updateImageRangeSelection({
  pageIds,
  selectedIds,
  anchorId,
  targetId,
  checked
}: ImageRangeSelectionOptions) {
  const targetIndex = pageIds.indexOf(targetId);
  if (targetIndex < 0) {
    return selectedIdsInPageOrder(pageIds, selectedIds);
  }

  const anchorIndex = anchorId === null ? -1 : pageIds.indexOf(anchorId);
  if (anchorIndex < 0) {
    return updateSingleImageSelection(
      pageIds,
      selectedIds,
      targetId,
      checked
    );
  }

  const selected = new Set(selectedIdsInPageOrder(pageIds, selectedIds));
  const firstIndex = Math.min(anchorIndex, targetIndex);
  const lastIndex = Math.max(anchorIndex, targetIndex);
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const id = pageIds[index];
    if (checked) selected.add(id);
    else selected.delete(id);
  }
  return pageIds.filter((id) => selected.has(id));
}

export class ImageListSelectionController {
  #anchorId: string | null = null;

  update({
    pageIds,
    selectedIds,
    targetId,
    checked,
    extendRange,
    busy
  }: ImageSelectionUpdateOptions) {
    if (busy) return selectedIds;
    if (!extendRange) {
      this.#anchorId = targetId;
      return updateSingleImageSelection(
        pageIds,
        selectedIds,
        targetId,
        checked
      );
    }

    const anchorId = this.#anchorId !== null
      && pageIds.includes(this.#anchorId)
      ? this.#anchorId
      : targetId;
    this.#anchorId = anchorId;
    return updateImageRangeSelection({
      pageIds,
      selectedIds,
      anchorId,
      targetId,
      checked
    });
  }

  reconcile(pageIds: string[], selectedIds: string[]) {
    const reconciledSelectedIds = selectedIdsInPageOrder(
      pageIds,
      selectedIds
    );
    if (
      !reconciledSelectedIds.length
      || (this.#anchorId !== null && !pageIds.includes(this.#anchorId))
    ) {
      this.#anchorId = null;
    }
    return reconciledSelectedIds;
  }

  reset() {
    this.#anchorId = null;
  }
}
