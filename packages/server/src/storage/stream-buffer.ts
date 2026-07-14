import { Readable } from "node:stream";
import { ApiError } from "../core/http.ts";

export async function streamToBuffer(stream: Readable, limit = Number.MAX_SAFE_INTEGER) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) throw new ApiError(400, "object_too_large", "图片大小超过限制", { limit });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function nodeReadableFromWeb(stream: ReadableStream<Uint8Array>) {
  return Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]);
}

export function sliceReadable(stream: Readable, start: number, end: number) {
  async function* chunks() {
    let offset = 0;
    try {
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const nextOffset = offset + buffer.length;
        if (nextOffset <= start) {
          offset = nextOffset;
          continue;
        }
        if (offset > end) break;
        const from = Math.max(0, start - offset);
        const to = Math.min(buffer.length, end - offset + 1);
        if (to > from) yield buffer.subarray(from, to);
        offset = nextOffset;
        if (offset > end) break;
      }
    } finally {
      stream.destroy();
    }
  }
  return Readable.from(chunks());
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
      stream.destroy(reason instanceof Error ? reason : undefined);
      await iterator.return?.().catch(() => undefined);
    }
  });
}
