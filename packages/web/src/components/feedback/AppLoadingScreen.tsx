import { useState } from "react";

const appLoadingSpinDurationMs = 720;

export function AppLoadingIndicator() {
  // Align every newly mounted indicator to the same wall-clock phase. Route
  // fallbacks and page-level waiting surfaces can replace each other without
  // making the ring visibly jump back to its zero-degree frame.
  const [spinnerAnimationDelay] = useState(
    () => `${-(Date.now() % appLoadingSpinDurationMs)}ms`
  );

  return (
    <span
      className="app-loading-indicator"
      role="status"
      aria-live="polite"
    >
      <span
        className="app-loading-spinner"
        style={{ animationDelay: spinnerAnimationDelay }}
        aria-hidden="true"
      />
      <span className="app-loading-label">加载中</span>
    </span>
  );
}

export function AppLoadingRegion({
  className
}: {
  className?: string;
}) {
  return (
    <div
      className={[
        "app-loading-region",
        className
      ].filter(Boolean).join(" ")}
    >
      <AppLoadingIndicator />
    </div>
  );
}

export function AppLoadingScreen() {
  return <AppLoadingRegion className="app-loading-screen" />;
}
