/** 卡片 / 列表两态切换，位于页头标题旁。 */
export function ViewModeToggle({
  noun,
  value,
  onChange
}: {
  noun: string;
  value: "card" | "list";
  onChange: (next: "card" | "list") => void;
}) {
  const current = value === "card" ? "卡片" : "列表";
  const next = value === "card" ? "列表" : "卡片";
  return (
    <button
      type="button"
      className="state-toggle-button vocabulary-view-switch"
      data-shifted={value === "list"}
      aria-pressed={value === "list"}
      aria-label={`${noun}以${current}显示；点击切换为${next}`}
      title={`切换为${next}`}
      onClick={() => onChange(value === "card" ? "list" : "card")}
    >
      <span className="state-toggle-label">{current}</span>
      <span className="state-toggle-thumb" aria-hidden="true" />
    </button>
  );
}
