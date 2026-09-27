import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { ApiError } from "../../core/api-error.ts";
import type { OpenedRead } from "../drivers/driver.ts";

/** Memory safety for completed objects; unrelated to admission of new uploads. */
export const STORAGE_BUFFER_MAX_BYTES = 256 * 1024 * 1024;

async function streamToBuffer(stream: Readable, limit = Number.MAX_SAFE_INTEGER) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) throw new ApiError(
      400,
      "object_too_large",
      "图片大小超过限制",
      { limit }
    );
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function openedReadToBuffer(
  opened: OpenedRead,
  limit: number,
  expectedSize?: number
) {
  const closed = finished(opened.body, { cleanup: true }).catch(() => undefined);
  try {
    if (!Number.isSafeInteger(limit) || limit < 0 ||
        (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0))) {
      throw new RangeError("Invalid object buffer size");
    }
    if ((opened.size ?? 0) > limit || (expectedSize ?? 0) > limit) {
      throw new ApiError(400, "object_too_large", "图片大小超过缓冲读取限制", { limit });
    }
    if (expectedSize !== undefined && opened.size !== undefined && opened.size !== expectedSize) {
      throw new ApiError(502, "storage_read_size_mismatch", "对象体积与登记信息不一致");
    }
    const buffer = await streamToBuffer(opened.body, expectedSize ?? limit);
    if (expectedSize !== undefined && buffer.length !== expectedSize) {
      throw new ApiError(502, "storage_read_size_mismatch", "对象体积与登记信息不一致");
    }
    return buffer;
  } finally {
    opened.body.destroy();
    await closed;
  }
}

export function nodeReadableFromWeb(stream: ReadableStream<Uint8Array>) {
  return Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]);
}

/**
 * Adapts a Node stream explicitly instead of passing it to the Fetch Response
 * constructor as an undocumented BodyInit. Node 26.5 can otherwise close the
 * same byte stream twice after a short ranged file response and terminate the
 * process with ERR_INVALID_STATE.
 */
export function webReadableFromNode(stream: Readable): ReadableStream<Uint8Array> {
  const iterator = stream[Symbol.asyncIterator]();
  let active = true;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await iterator.next();
        if (!active) return;
        if (chunk.done) {
          active = false;
          controller.close();
          return;
        }
        controller.enqueue(Buffer.isBuffer(chunk.value) ? chunk.value : Buffer.from(chunk.value));
      } catch (error) {
        if (!active) return;
        active = false;
        controller.error(error);
      }
    },
    async cancel(reason) {
      if (!active) return;
      active = false;
      // Observe teardown errors even before the iterator's first read.
      const closed = finished(stream, { cleanup: true, writable: false }).catch(() => undefined);
      stream.destroy(reason instanceof Error ? reason : undefined);
      await iterator.return?.().catch(() => undefined);
      await closed;
    }
  });
}
