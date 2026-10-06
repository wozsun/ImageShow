import { useLayoutEffect, useRef, useState } from "react";
import { mobileViewportMediaQuery, useMediaQuery } from "../../hooks/useMediaQuery.js";
import { OverlayScrollbar } from "./OverlayScrollbar.js";

/**
 * 带操作区显隐的工作区（.workspace-has-toolbar）在窄屏整体滚动，原生滚动指示条会画过吸顶的
 * 标题区与吸底的翻页栏；这里改用自定义滚动条，轨道夹在二者之间，触屏上同样启用。放在工作区内
 * 即可，由自身位置找到所在工作区、标题区与翻页栏。桌面上工作区不滚动，不挂载。
 */
export function WorkspaceToolbarScrollbar() {
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const pinnedRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLElement | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    workspaceRef.current = anchorRef.current?.closest<HTMLElement>(".workspace") ?? null;
    pinnedRef.current =
      workspaceRef.current?.querySelector<HTMLElement>("[data-workspace-pinned]") ?? null;
    footerRef.current =
      workspaceRef.current?.querySelector<HTMLElement>(":scope > .admin-pagination") ?? null;
    setReady(workspaceRef.current !== null);
  }, []);

  return (
    <>
      <span ref={anchorRef} hidden />
      {ready && mobileLayout && (
        <OverlayScrollbar
          targetRef={workspaceRef}
          topInsetRef={pinnedRef}
          bottomInsetRef={footerRef}
          enableOnTouch
        />
      )}
    </>
  );
}
