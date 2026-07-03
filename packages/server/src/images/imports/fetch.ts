import { appConfig } from "@imageshow/shared";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { ApiError } from "../../core/http.js";
import { nodeReadableFromWeb } from "../../storage/stream-buffer.js";

async function fetchImportResponse(url: string, limitBytes: number, externalSignal?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, appConfig.linkImport.fetchTimeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { Accept: "image/*,*/*" }
    });
    if (!response.ok) throw new ApiError(400, "link_fetch_failed", `下载失败（HTTP ${response.status}）`, { url });
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared && declared > limitBytes) {
      throw new ApiError(400, "link_too_large", "图片大小超过限制", { limit: limitBytes });
    }
    return { response, signal: controller.signal, dispose: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abort);
    } };
  } catch (error) {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", abort);
    if (error instanceof ApiError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new ApiError(externalSignal?.aborted ? 409 : 400, externalSignal?.aborted ? "import_cancelled" : "link_timeout", externalSignal?.aborted ? "导入已取消" : "下载超时", { url });
    }
    throw new ApiError(400, "link_fetch_failed", "下载失败", { url });
  }
}

export async function fetchImportImage(url: string, limitBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const fetched = await fetchImportResponse(url, limitBytes, signal);
  try {
    const buffer = Buffer.from(await fetched.response.arrayBuffer());
    if (buffer.byteLength > limitBytes) {
      throw new ApiError(400, "link_too_large", "图片大小超过限制", { limit: limitBytes });
    }
    return buffer;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as Error).name === "AbortError") throw new ApiError(signal?.aborted ? 409 : 400, signal?.aborted ? "import_cancelled" : "link_timeout", signal?.aborted ? "导入已取消" : "下载超时", { url });
    throw new ApiError(400, "link_fetch_failed", "下载失败", { url });
  } finally {
    fetched.dispose();
  }
}

export async function fetchImportImageToFile(url: string, target: string, limitBytes: number, signal?: AbortSignal) {
  const fetched = await fetchImportResponse(url, limitBytes, signal);
  if (!fetched.response.body) {
    fetched.dispose();
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
    await pipeline(nodeReadableFromWeb(fetched.response.body.pipeThrough(limiter)), createWriteStream(part), { signal: fetched.signal });
    await rm(target, { force: true });
    await rename(part, target);
    return total;
  } catch (error) {
    await Promise.all([rm(part, { force: true }), rm(target, { force: true })]);
    if ((error as Error).name === "AbortError") {
      throw new ApiError(signal?.aborted ? 409 : 400, signal?.aborted ? "import_cancelled" : "link_timeout", signal?.aborted ? "导入已取消" : "下载超时", { url });
    }
    throw error;
  } finally {
    fetched.dispose();
  }
}
