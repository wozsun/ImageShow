import { createWriteStream } from "node:fs";
import { link, mkdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { appConfig } from "@imageshow/shared";
import { fileTypeFromFile } from "file-type";
import sharp, { type Metadata } from "sharp";
import { ApiError } from "../../../core/api-error.ts";
import { nodeReadableFromWeb } from "../../../storage/objects/stream-buffer.ts";
import type {
  IngestionQueueType,
  IngestionSessionPair
} from "../sessions/model.ts";
import {
  ingestionRawPathIsActive,
  pruneIngestionRawParents,
  tryWithInactiveIngestionRawPath
} from "./lease-registry.ts";
import { ingestionRawPartPath, ingestionRawPath } from "./paths.ts";

const allowedRawExtensions = new Set(["jpg", "png", "webp", "gif", "avif"]);

export async function statIngestionRawIfExists(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function publishIngestionRawPart(
  partPath: string,
  rawPath: string,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  try {
    await link(partPath, rawPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await statIngestionRawIfExists(rawPath);
    if (!existing?.isFile()) throw error;
  }
  // Publication already succeeded; a leftover part is an orphan-cleanup
  // concern and must not make the caller abandon the referenced raw file.
  await rm(partPath, { force: true }).catch(() => undefined);
  return rawPath;
}

async function validateRawImagePart(path: string, maxLongEdge: number) {
  const detected = await fileTypeFromFile(path);
  if (!detected || !allowedRawExtensions.has(detected.ext)) {
    throw new ApiError(400, "unsupported_image_body", "上传正文不是支持的图片格式");
  }
  let metadata: Metadata;
  try {
    metadata = await sharp(path, { animated: false }).metadata();
  } catch {
    throw new ApiError(400, "invalid_image_body", "上传图片无法解码");
  }
  const width = Number(metadata.width ?? 0);
  const height = Number(metadata.height ?? 0);
  if (!width || !height) {
    throw new ApiError(400, "invalid_image_dimensions", "无法读取上传图片尺寸");
  }
  if (Math.max(width, height) > maxLongEdge) {
    throw new ApiError(400, "upload_dimensions_exceeded", "图片长边超过限制", {
      limit: maxLongEdge,
      width,
      height
    });
  }
}

export async function receiveUploadRaw(
  input: Readonly<{
    pair: IngestionSessionPair;
    raw_generation: string;
    execution_token: string;
    body: ReadableStream<Uint8Array>;
    expected_size: number;
    maximum_size: number;
    max_long_edge: number;
    signal?: AbortSignal;
    heartbeat?: () => Promise<void>;
  }>
) {
  const rawPath = ingestionRawPath("upload", input.pair, input.raw_generation);
  const partPath = ingestionRawPartPath(
    "upload",
    input.pair,
    input.raw_generation,
    input.execution_token
  );
  await mkdir(dirname(rawPath), { recursive: true });
  let total = 0;
  const heartbeatController = new AbortController();
  const combinedSignal = input.signal
    ? AbortSignal.any([input.signal, heartbeatController.signal])
    : heartbeatController.signal;
  let stopped = false;
  let pendingHeartbeat = Promise.resolve();
  const queueHeartbeat = () => {
    pendingHeartbeat = pendingHeartbeat.then(async () => {
      if (stopped || combinedSignal.aborted || !input.heartbeat) return;
      try {
        await input.heartbeat();
      } catch (error) {
        if (!stopped && !combinedSignal.aborted) {
          heartbeatController.abort(error);
        }
      }
    });
  };
  const heartbeatTimer = input.heartbeat
    ? setInterval(
      queueHeartbeat,
      appConfig.ingestionRuntime.workerHeartbeatSeconds * 1000
    )
    : null;
  heartbeatTimer?.unref();
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > input.maximum_size || total > input.expected_size) {
        throw new ApiError(400, "upload_too_large", "图片大小超过限制", {
          limit: Math.min(input.maximum_size, input.expected_size)
        });
      }
      controller.enqueue(chunk);
    }
  });
  try {
    await pipeline(
      nodeReadableFromWeb(input.body.pipeThrough(limiter)),
      createWriteStream(partPath),
      { signal: combinedSignal }
    );
    if (total !== input.expected_size) {
      throw new ApiError(400, "size_mismatch", "Upload size mismatch", {
        expected: input.expected_size,
        actual: total
      });
    }
    await validateRawImagePart(partPath, input.max_long_edge);
    combinedSignal.throwIfAborted();
    await publishIngestionRawPart(partPath, rawPath, combinedSignal);
    return { rawPath, rawSize: total };
  } catch (error) {
    await rm(partPath, { force: true }).catch(() => undefined);
    if (heartbeatController.signal.aborted) {
      throw heartbeatController.signal.reason;
    }
    throw error;
  } finally {
    stopped = true;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await pendingHeartbeat;
  }
}

export async function removeIngestionRaw(
  queue: IngestionQueueType,
  pair: IngestionSessionPair,
  rawGeneration: string
) {
  const path = ingestionRawPath(queue, pair, rawGeneration);
  const removed = await tryWithInactiveIngestionRawPath(path, async () => {
    if (ingestionRawPathIsActive(path)) return false;
    await rm(path, { force: true });
    return true;
  });
  if (removed) await pruneIngestionRawParents(path);
}

/** Delete an exact raw generation while the caller owns its active-path lease. */
export async function removeOwnedIngestionRaw(
  queue: IngestionQueueType,
  pair: IngestionSessionPair,
  rawGeneration: string
) {
  const path = ingestionRawPath(queue, pair, rawGeneration);
  await rm(path, { force: true });
  await pruneIngestionRawParents(path);
}

export async function removeIngestionRawPart(
  queue: IngestionQueueType,
  pair: IngestionSessionPair,
  rawGeneration: string,
  executionToken: string
) {
  const path = ingestionRawPartPath(queue, pair, rawGeneration, executionToken);
  // Part-file callers execute inside withActiveIngestionRawPaths and therefore
  // already own the exclusion lease that makes this exact unlink safe.
  await rm(path, { force: true });
  await pruneIngestionRawParents(path);
}
