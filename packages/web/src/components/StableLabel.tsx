// A button caption that swaps between its idle text and a shorter/longer "busy" text
// (保存中 / 运行中 / 清理中 …) without ever changing the button's width. Both captions are
// stacked in one grid cell, so the cell always reserves the wider of the two; whichever
// caption is hidden still holds its space. This keeps a clicked button from jumping wider
// or narrower and prevents the leading icon from shifting. CSS: .btn-label-slot in
// styles/admin/settings-check.css.
export function StableLabel({ idle, busyText, busy }: { idle: string; busyText: string; busy: boolean }) {
  return (
    <span className="btn-label-slot">
      <span className={`btn-label-cell${busy ? " is-hidden" : ""}`} aria-hidden={busy}>{idle}</span>
      <span className={`btn-label-cell${busy ? "" : " is-hidden"}`} aria-hidden={!busy}>{busyText}</span>
    </span>
  );
}
