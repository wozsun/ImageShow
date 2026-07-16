import type { RefObject } from "react";
import type { FacetOption, ImageItem } from "../../lib/types.js";
import { BatchMetadataModal } from "./BatchMetadataModal.js";

export function ImageEditModal({
  item,
  themes,
  allTags,
  authors,
  onClose,
  onSaved,
  returnFocusRef,
}: {
  item: ImageItem;
  themes: FacetOption[];
  allTags: FacetOption[];
  authors: FacetOption[];
  onClose: () => void;
  onSaved: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <BatchMetadataModal
      items={[item]}
      pageSize={1}
      single
      themes={themes}
      allTags={allTags}
      authors={authors}
      onClose={onClose}
      onSaved={onSaved}
      returnFocusRef={returnFocusRef}
    />
  );
}
