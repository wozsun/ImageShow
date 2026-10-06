import { useRef, type ReactNode, type RefObject } from "react";
import { OverlayScrollbar } from "./OverlayScrollbar.js";

/**
 * 页头固定的工作区（.workspace-contained）中承担滚动的主体区域。窄屏带操作区显隐的页面改由
 * 整个工作区原生滚动，此区域不再自行滚动，并以等于操作区高度的上边距让出位置
 * （data-workspace-content，见 useWorkspaceToolbarCollapse）。需要引用滚动元素的页面传入 ref。
 */
export function WorkspaceScrollBody({
  ref,
  className = "",
  children
}: {
  ref?: RefObject<HTMLDivElement | null>;
  className?: string;
  children: ReactNode;
}) {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = ref ?? ownRef;
  return (
    <>
      <div
        ref={scrollRef}
        className={["workspace-scroll-body", className].filter(Boolean).join(" ")}
        data-workspace-content=""
      >
        {children}
      </div>
      <OverlayScrollbar targetRef={scrollRef} pageEdge />
    </>
  );
}
