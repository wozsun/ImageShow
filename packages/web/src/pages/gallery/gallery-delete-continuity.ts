import type { GalleryImageCard } from "../../lib/types.js";

/**
 * 删除当前详情图片后优先把焦点交给原位置的下一张；删除末项时退到上一张。
 * 输入可能仍是 mutation 前的 React 快照，因此先明确排除已删除 ID。
 */
export function galleryDeletionFocusTarget(
  items: readonly GalleryImageCard[],
  deletedId: string,
  originalIndex: number
) {
  const remaining = items.filter((item) => item.id !== deletedId);
  if (!remaining.length) return null;
  const targetIndex = Math.min(
    Math.max(0, originalIndex),
    remaining.length - 1
  );
  return remaining[targetIndex] ?? null;
}
