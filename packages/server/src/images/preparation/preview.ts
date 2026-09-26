import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import { fileTypeFromFile } from "file-type";
import type { ImageVariant } from "@imageshow/shared/browser";
import { ApiError } from "../../core/api-error.ts";
import { getIngestionMaxFileBytes, getIngestionMaxLongEdge } from "../../config/app-settings.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { runtimePaths } from "../../config/bootstrap-env.ts";
import { digestLocalFile } from "../../storage/drivers/local-publication.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import { startPreparationChild } from "./child-client.ts";
import { latestPreparationRun, readRecord } from "./repository.ts";
import { preparationId, preparationTarget } from "./paths.ts";

let originalPreviewActive = false;

export async function previewPreparationImage(image: string, variant: ImageVariant | "original", signal: AbortSignal) {
  preparationId(image);
  const run = await latestPreparationRun();
  const row = run && await readRecord(run.id, image);
  if (!run || !row) throw new ApiError(404, "preparation_image_missing", "图片未进入预生成任务");
  if (variant !== "original") {
    const facts = row.data.variants[variant]?.facts;
    if (!facts) throw new ApiError(409, "preparation_not_ready", "该档图片尚未完成核验");
    const path = preparationTarget(image, variant);
    const actual = await digestLocalFile(path, signal);
    if (actual.sha256 !== facts.sha256 || actual.bytes !== facts.bytes) throw new ApiError(409, "preparation_changed", "预生成文件已变化，请运行完整核验");
    return new Response(Readable.toWeb(createReadStream(path, { signal })) as ReadableStream<Uint8Array>, {
      headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store", "Content-Length": String(facts.bytes) }
    });
  }
  if (!row.data.input?.sha256) throw new ApiError(409, "preparation_source_missing", "原图尚未处理");
  if (originalPreviewActive) throw new ApiError(429, "preparation_preview_busy", "另一张原图正在下载核对，请稍后重试");
  originalPreviewActive = true;
  const directory = join(runtimePaths.configDirectory, "normalize-preparation", "preview", randomUuidV7());
  const input = join(directory, "original");
  let child: Awaited<ReturnType<typeof startPreparationChild>> | undefined;
  try {
    child = await startPreparationChild(signal);
    const result = await child.request({ action: "open", input, url: row.data.source.original,
      maxBytes: getIngestionMaxFileBytes(), maxLongEdge: getIngestionMaxLongEdge(),
      timeoutMs: getRuntimeConfig().import.fetch_timeout_seconds * 1000,
      profile: run.payload.profile, cache: join(directory, "cache")
    });
    if (result.input!.sha256 !== row.data.input.sha256) throw new ApiError(409, "preparation_original_changed", "当前 URL 的原图已变化，不能作为当时输入的抽查样本");
    await child.close();
    const mediaType = await fileTypeFromFile(input);
    const stream = createReadStream(input, { signal });
    stream.once("close", () => { void rm(directory, { recursive: true, force: true }); });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: { "Content-Type": mediaType?.mime ?? "application/octet-stream", "Cache-Control": "private, no-store", "Content-Length": String(result.input!.bytes) }
    });
  } catch (error) {
    await child?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally { originalPreviewActive = false; }
}
