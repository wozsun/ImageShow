import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { ApiError } from "../../core/api-error.ts";
import { safeFetchExternalImage } from "../../core/external-image-fetch.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { nodeReadableFromWeb } from "../../storage/stream-buffer.ts";
import {
  calculateDownloadProgress,
  downloadProgressLength
} from "./download-progress.ts";
import { publishRawImportPart } from "./temp-files.ts";

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

export async function fetchImportImageToFile(
  url: string,
  target: string,
  part: string,
  limitBytes: number,
  signal?: AbortSignal,
  onProgress?: (progress: number) => void
) {
  const fetched = await fetchImportResponse(url, limitBytes, signal);
  if (!fetched.response.body) {
    throw new ApiError(400, "link_fetch_failed", "下载响应没有内容", { url });
  }
  await mkdir(dirname(target), { recursive: true });
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
    await publishRawImportPart(part, target, signal);
    return total;
  } catch (error) {
    // Preserve a complete target that may belong to a lock-loss successor;
    // this attempt owns only the partial file until atomic publication.
    await rm(part, { force: true });
    if ((error as Error).name === "AbortError") {
      throw new ApiError(signal?.aborted ? 409 : 400, signal?.aborted ? "import_cancelled" : "link_timeout", signal?.aborted ? "导入已取消" : "下载超时", { url });
    }
    throw error;
  }
}
