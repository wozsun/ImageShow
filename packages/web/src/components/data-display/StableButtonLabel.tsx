export function StableButtonLabel({ idle, busyText, busy }: { idle: string; busyText: string; busy: boolean }) {
  return (
    <span className="btn-label-slot">
      <span className={`btn-label-cell${busy ? " is-hidden" : ""}`} aria-hidden={busy}>{idle}</span>
      <span className={`btn-label-cell${busy ? "" : " is-hidden"}`} aria-hidden={!busy}>{busyText}</span>
    </span>
  );
}
