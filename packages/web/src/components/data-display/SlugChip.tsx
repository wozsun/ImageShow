export function SlugChip({ value, ariaLabel }: { value: string; ariaLabel?: string }) {
  // 用只读输入框承载 slug，而不是 <code>：长 slug 可点击聚焦、方向键横向滚动，也能完整选中复制。
  // 未聚焦时由原生 text-overflow:ellipsis 截断；聚焦后浏览器自动让位到光标位置。
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
