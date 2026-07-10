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
