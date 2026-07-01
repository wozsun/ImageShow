// 主题 / 标签 / 作者 / 用户管理卡片左侧那块等宽的 slug 小框。
//
// 用「只读输入框」承载 slug，而不是 <code>：光标可点进去、用方向键右移并横向滚动，从而查看并
// 选中完整的长 slug（普通文本元素无法用方向键定位，溢出后也不滚动，长 slug 根本选不全）。
// slug 超出框宽时，由原生 text-overflow:ellipsis 紧贴文字末尾画出截断号「…」（间距最短、与文字
// 相连）；聚焦时浏览器自动让位，可滚动 / 选中到末尾。
export function SlugChip({ value, ariaLabel }: { value: string; ariaLabel?: string }) {
  return (
    <input
      className="entity-slug"
      value={value}
      title={value}
      readOnly
      // 不进 Tab 顺序（与原 <code> 一致，避免一长串只读框塞满 Tab 链）；仍可点击聚焦后选中。
      tabIndex={-1}
      aria-label={ariaLabel ?? value}
    />
  );
}
