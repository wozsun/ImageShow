export const defaultAsyncActionMinimumPendingMs = 500;

/**
 * 让已经显示的进行态至少保留指定时长，避免快速操作造成视觉闪烁。
 */
export function waitForMinimumPendingDuration(
  startedAt: number,
  minimumPendingMs = defaultAsyncActionMinimumPendingMs
) {
  const remainingPendingMs = Math.max(
    0,
    minimumPendingMs - (Date.now() - startedAt)
  );
  if (remainingPendingMs === 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, remainingPendingMs);
  });
}
