export function AppLoadingIndicator() {
  return (
    <span
      className="app-loading-indicator"
      role="status"
      aria-live="polite"
    >
      <span className="app-loading-spinner" aria-hidden="true" />
      <span className="app-loading-label">加载中</span>
    </span>
  );
}

export function AppLoadingScreen() {
  return (
    <div className="center app-loading-screen">
      <AppLoadingIndicator />
    </div>
  );
}
