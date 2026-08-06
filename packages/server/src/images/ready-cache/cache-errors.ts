export class ReadyImageCoreCacheError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ReadyImageCoreCacheError";
  }
}

export function isReadyImageCoreCacheError(
  error: unknown
): error is ReadyImageCoreCacheError {
  return error instanceof ReadyImageCoreCacheError;
}
