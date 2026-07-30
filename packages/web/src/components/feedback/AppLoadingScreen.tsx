export type AppLoadingExtraDots = 0 | 1 | 2 | 3;

export function AppLoadingText({
  extraDots = 0
}: {
  extraDots?: AppLoadingExtraDots;
}) {
  return (
    <span
      className="app-loading-text"
      role="status"
      aria-live="polite"
      aria-label="加载中"
    >
      <span aria-hidden="true">
        加载中…{".".repeat(extraDots)}
        <span className="app-loading-reserved-dots">
          {".".repeat(3 - extraDots)}
        </span>
      </span>
    </span>
  );
}

export function AppLoadingRegion({
  className,
  extraDots = 0
}: {
  className?: string;
  extraDots?: AppLoadingExtraDots;
}) {
  return (
    <div
      className={[
        "app-loading-region",
        className
      ].filter(Boolean).join(" ")}
    >
      <AppLoadingText extraDots={extraDots} />
    </div>
  );
}

export function AppLoadingScreen() {
  return <AppLoadingRegion className="app-loading-screen" />;
}
