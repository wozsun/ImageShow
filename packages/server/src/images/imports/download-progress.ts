function declaredContentLength(headers: Headers) {
  const value = Number(headers.get("content-length") || 0);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Returns a declared length only when it is comparable to the decoded bytes
 * consumed by the import pipeline.
 */
export function downloadProgressLength(headers: Headers) {
  const contentEncoding = headers.get("content-encoding")?.trim().toLowerCase();
  return !contentEncoding || contentEncoding === "identity"
    ? declaredContentLength(headers)
    : undefined;
}

export function calculateDownloadProgress(
  receivedBytes: number,
  declaredBytes: number
) {
  if (!Number.isFinite(receivedBytes) || receivedBytes < 0) return undefined;
  if (!Number.isFinite(declaredBytes) || declaredBytes <= 0) return undefined;
  return Math.min(100, Math.floor((receivedBytes / declaredBytes) * 100));
}
