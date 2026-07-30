import type { RefObject } from "react";
import type {
  BatchEditableImageSnapshot,
  FacetOption
} from "../../lib/types.js";
import { BatchMetadataModal } from "./BatchMetadataModal.js";
// 单图编辑器也会由公共详情按管理员意图加载；样式跟随真正的编辑器能力，
// 不再依赖 ImageAdmin 路由碰巧提前引入。
import "../../styles/admin/controls.css";
import "../../styles/admin/image-edit.css";

export function ImageEditModal({
  item,
  themes,
  allTags,
  authors,
  onClose,
  onSaved,
  returnFocusRef,
}: {
  item: BatchEditableImageSnapshot;
  themes: FacetOption[];
  allTags: FacetOption[];
  authors: FacetOption[];
  onClose: () => void;
  onSaved: (
    authoritativeItems?: BatchEditableImageSnapshot[] | null
  ) => void | Promise<void>;
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
