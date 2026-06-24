import { Readable } from "node:stream";
import { ApiError } from "../core/http.js";

export async function streamToBuffer(stream: Readable, limit = Number.MAX_SAFE_INTEGER) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > limit) throw new ApiError(400, "object_too_large", "Object is too large to buffer safely", { limit });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// Wraps a Web upload stream so it throws as soon as more than `max` bytes flow
// through, without buffering the whole body. Lets large uploads stream straight
// to storage while still enforcing the configured size cap.
export function limitedWebStream(body: ReadableStream<Uint8Array>, max: number) {
  let total = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > max) throw new ApiError(400, "upload_too_large", "Upload too large");
      controller.enqueue(chunk);
    }
  });
  return body.pipeThrough(limiter);
}

export function nodeReadableFromWeb(stream: ReadableStream<Uint8Array>) {
  return Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]);
}
