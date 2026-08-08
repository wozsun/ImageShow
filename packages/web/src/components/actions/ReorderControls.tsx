import type { DragEvent } from "react";
import { AdminIcon } from "../icon/AdminIcon.js";
import type { ReorderDirection } from "../../lib/ui/reorder.js";

export function ReorderControls({
  itemLabel,
  busy,
  canMovePrevious,
  canMoveNext,
  onMove,
  onControlRef,
  dragPreviewRef,
  onDragStart,
  onDragEnd
}: {
  itemLabel: string;
  busy: boolean;
  canMovePrevious: boolean;
  canMoveNext: boolean;
  onMove: (direction: ReorderDirection) => void;
  onControlRef: (
    direction: ReorderDirection,
    node: HTMLButtonElement | null
  ) => void;
  dragPreviewRef: { current: HTMLElement | null };
  onDragStart: (event: DragEvent<HTMLSpanElement>) => void;
  onDragEnd: () => void;
}) {
  const button = (
    direction: ReorderDirection,
    canMove: boolean
  ) => {
    const previous = direction === "previous";
    const action = previous ? "向前移动一位" : "向后移动一位";
    const unavailable = busy || !canMove;
    return (
      <button
        ref={(node) => onControlRef(direction, node)}
        type="button"
        className={`icon reorder-step-button is-${direction}`}
        title={`${itemLabel}：${action}`}
        aria-label={`${itemLabel}：${action}`}
        aria-disabled={unavailable}
        onClick={() => {
          if (!unavailable) onMove(direction);
        }}
      >
        <AdminIcon name="arrow-up-line" />
      </button>
    );
  };

  return (
    <span
      className="reorder-control-group"
      role="group"
      aria-label={`${itemLabel}：调整顺序`}
    >
      {button("previous", canMovePrevious)}
      <span
        className={`reorder-pointer-handle${busy ? " is-disabled" : ""}`}
        title={`${itemLabel}：按住拖动排序`}
        aria-hidden="true"
        draggable={!busy}
        onDragStart={(event) => {
          if (busy) {
            event.preventDefault();
            return;
          }
          // Keep drag initiation scoped to the handle without degrading the
          // browser's native feedback to a handle-only drag image.
          const preview = dragPreviewRef.current;
          if (preview) {
            const bounds = preview.getBoundingClientRect();
            const offsetX = Math.max(
              0,
              Math.min(event.clientX - bounds.left, bounds.width)
            );
            const offsetY = Math.max(
              0,
              Math.min(event.clientY - bounds.top, bounds.height)
            );
            event.dataTransfer.setDragImage(preview, offsetX, offsetY);
          }
          onDragStart(event);
        }}
        onDragEnd={onDragEnd}
      >
        <AdminIcon name="drag-move-2-fill" />
      </span>
      {button("next", canMoveNext)}
    </span>
  );
}
