import { useLayoutEffect, useRef, type RefObject } from "react";
import { workspaceScrollContainer } from "../lib/ui/workspace-scroll.js";

/**
 * 卡片 / 列表切换前记下视口顶端第一条可见条目的位置，切换后把它放回原处，
 * 避免两种布局高度不同导致阅读位置跳走。
 */
export function useViewModeScrollAnchor(
  listRef: RefObject<HTMLElement | null>,
  itemSelector: string,
  viewMode: string
) {
  const anchorRef = useRef<{ element: HTMLElement; offset: number } | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const viewport = workspaceScrollContainer(listRef.current);
    if (!viewport || !anchor?.element.isConnected) return;
    const viewportTop = viewport.getBoundingClientRect().top;
    viewport.scrollTop += anchor.element.getBoundingClientRect().top - viewportTop - anchor.offset;
  }, [listRef, viewMode]);

  return () => {
    const viewport = workspaceScrollContainer(listRef.current);
    if (!viewport || viewport.scrollTop <= 0) return;
    const viewportTop = viewport.getBoundingClientRect().top;
    const element = Array.from(viewport.querySelectorAll<HTMLElement>(itemSelector))
      .find((candidate) => candidate.getBoundingClientRect().bottom > viewportTop);
    anchorRef.current = element
      ? { element, offset: element.getBoundingClientRect().top - viewportTop }
      : null;
  };
}
