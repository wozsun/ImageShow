export function abortSignalError(
  signal: AbortSignal,
  fallbackMessage = "Operation aborted"
) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(fallbackMessage);
}

export function raceWithAbortSignal<T>(
  signal: AbortSignal,
  operation: Promise<T>,
  fallbackMessage = "Operation aborted"
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(abortSignalError(signal, fallbackMessage));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", aborted);
    const aborted = () => {
      cleanup();
      reject(abortSignalError(signal, fallbackMessage));
    };
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}
