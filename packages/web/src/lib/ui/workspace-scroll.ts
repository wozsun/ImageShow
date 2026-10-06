/**
 * 返回实际承担滚动的元素。窄屏带操作区显隐的页面由整个工作区原生滚动，内部列表区域不再滚动
 * （见 useWorkspaceToolbarCollapse）；其余情况由列表区域自身滚动。
 */
export function workspaceScrollContainer(listElement: HTMLElement | null) {
  if (!listElement) return null;
  return getComputedStyle(listElement).overflowY === "visible"
    ? listElement.closest<HTMLElement>(".workspace")
    : listElement;
}
