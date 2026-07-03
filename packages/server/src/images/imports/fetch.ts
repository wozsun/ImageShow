import { appConfig } from "@imageshow/shared";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { ApiError } from "../../core/http.js";
import { safeFetchExternalImage } from "../../core/external-image-fetch.js";
import { nodeReadableFromWeb } from "../../storage/stream-buffer.js";

async function fetchImportResponse(url: string, limitBytes: number, externalSignal?: AbortSignal) {
  try {
    const response = await safeFetchExternalImage(url, {
      signal: externalSignal,
      timeoutMs: appConfig.linkImport.fetchTimeoutMs,
      headers: { Accept: "image/*,*/*" },
      imageValidation: "sniff"
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiError(400, "link_fetch_failed", `下载失败（HTTP ${response.status}）`, { url });
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared && declared > limitBytes) {
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

export async function fetchImportImageToFile(url: string, target: string, limitBytes: number, signal?: AbortSignal) {
  const fetched = await fetchImportResponse(url, limitBytes, signal);
  if (!fetched.response.body) {
    throw new ApiError(400, "link_fetch_failed", "下载响应没有内容", { url });
  }
  await mkdir(dirname(target), { recursive: true });
  const part = `${target}.part`;
  let total = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limitBytes) throw new ApiError(400, "link_too_large", "图片大小超过限制", { limit: limitBytes });
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
