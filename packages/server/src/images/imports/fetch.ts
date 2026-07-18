import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { ApiError } from "../../core/http.ts";
import { safeFetchExternalImage } from "../../core/external-image-fetch.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { nodeReadableFromWeb } from "../../storage/stream-buffer.ts";

function declaredContentLength(headers: Headers) {
  const value = Number(headers.get("content-length") || 0);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Returns a declared length only when it is comparable to the decoded bytes
 * consumed by the import pipeline.
 *
 * @internal Exported only for local download-progress verification.
 */
export function downloadProgressLength(headers: Headers) {
  const contentEncoding = headers.get("content-encoding")?.trim().toLowerCase();
  return !contentEncoding || contentEncoding === "identity"
    ? declaredContentLength(headers)
    : undefined;
}

/** @internal Exported only for local download-progress verification. */
export function calculateDownloadProgress(receivedBytes: number, declaredBytes: number) {
  if (!Number.isFinite(receivedBytes) || receivedBytes < 0) return undefined;
  if (!Number.isFinite(declaredBytes) || declaredBytes <= 0) return undefined;
  return Math.min(100, Math.floor((receivedBytes / declaredBytes) * 100));
}

async function fetchImportResponse(url: string, limitBytes: number, externalSignal?: AbortSignal) {
  try {
    const response = await safeFetchExternalImage(url, {
      signal: externalSignal,
      timeoutMs: getRuntimeConfig().link_image.fetch_timeout_seconds * 1000,
      headers: { Accept: "image/*,*/*", "Accept-Encoding": "identity" },
      imageValidation: "sniff"
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiError(400, "link_fetch_failed", `下载失败（HTTP ${response.status}）`, { url });
    }
    const declared = downloadProgressLength(response.headers);
    if (declared !== undefined && declared > limitBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiError(400, "link_too_large", "图片大小超过限制", { limit: limitBytes });
    }
    return { response };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "link_fetch_failed", "下载失败", { url });
  }
}

async function readLimitedImageBuffer(response: Response, limitBytes: number, signal: AbortSignal | undefined, url: string) {
  if (!response.body) throw new ApiError(400, "link_fetch_failed", "下载响应没有内容", { url });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  const abort = () => reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new ApiError(409, "import_cancelled", "导入已取消", { url });
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new ApiError(409, "import_cancelled", "导入已取消", { url });
      if (done) {
        completed = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
      if (total > limitBytes) throw new ApiError(400, "link_too_large", "图片大小超过限制", { limit: limitBytes });
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!completed) await reader.cancel().catch(() => undefined);
  }
}

export async function fetchImportImage(url: string, limitBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const fetched = await fetchImportResponse(url, limitBytes, signal);
  try {
    return await readLimitedImageBuffer(fetched.response, limitBytes, signal, url);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as Error).name === "AbortError") throw new ApiError(signal?.aborted ? 409 : 400, signal?.aborted ? "import_cancelled" : "link_timeout", signal?.aborted ? "导入已取消" : "下载超时", { url });
    throw new ApiError(400, "link_fetch_failed", "下载失败", { url });
  }
}

export async function fetchImportImageToFile(
  url: string,
  target: string,
  limitBytes: number,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void
) {
  const fetched = await fetchImportResponse(url, limitBytes, signal);
  if (!fetched.response.body) {
    throw new ApiError(400, "link_fetch_failed", "下载响应没有内容", { url });
  }
  await mkdir(dirname(target), { recursive: true });
  const part = `${target}.part`;
  const declaredSize = downloadProgressLength(fetched.response.headers);
  let total = 0;
  let lastProgress = -1;
  const reportProgress = () => {
    if (declaredSize === undefined || !onProgress) return;
    const progress = calculateDownloadProgress(total, declaredSize);
    if (progress === undefined) return;
    if (progress === lastProgress) return;
    lastProgress = progress;
    onProgress(progress);
  };
  reportProgress();
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limitBytes) throw new ApiError(400, "link_too_large", "图片大小超过限制", { limit: limitBytes });
      reportProgress();
      controller.enqueue(chunk);
    }
  });
  try {
    await pipeline(nodeReadableFromWeb(fetched.response.body.pipeThrough(limiter)), createWriteStream(part), { signal });
    await rm(target, { force: true });
    await rename(part, target);
    return total;
  } catch (error) {
    await Promise.all([rm(part, { force: true }), rm(target, { force: true })]);
    if ((error as Error).name === "AbortError") {
      throw new ApiError(signal?.aborted ? 409 : 400, signal?.aborted ? "import_cancelled" : "link_timeout", signal?.aborted ? "导入已取消" : "下载超时", { url });
    }
    throw error;
  }
}
