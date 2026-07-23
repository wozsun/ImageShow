export function createIntegerProgressReporter(
  onProgress: (progress: number) => void,
  initialProgress = -1
) {
  let lastProgress = initialProgress;
  return (progress: number) => {
    if (!Number.isFinite(progress)) return;
    const normalizedProgress = Math.min(100, Math.max(0, Math.round(progress)));
    if (normalizedProgress === lastProgress) return;
    lastProgress = normalizedProgress;
    onProgress(normalizedProgress);
  };
}
