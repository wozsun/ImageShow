import { timestampMicroseconds, microsecondsTimestamp } from "../core/microseconds.ts";
import { hash } from "node:crypto";
import type { PublicImageOrder } from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import { normalizedUuidSchema } from "../core/uuid.ts";

const orderedPayloadBytes = 23;
const randomPayloadBytes = 19;
const millisecondsPerDay = 86_400_000;
const cursorPattern = /^[A-Za-z0-9_-]+$/;

function normalizedUuid(value: string) {
  const result = normalizedUuidSchema.safeParse(value);
  return result.success ? result.data : null;
}

function uuidBytes(value: string) {
  const normalized = normalizedUuid(value);
  return normalized
    ? Buffer.from(normalized.replaceAll("-", ""), "hex")
    : null;
}

function uuidFromBytes(value: Buffer) {
  const hex = value.toString("hex");
  return normalizedUuid([
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join("-"));
}

export type ImageBrowseContext = {
  order: PublicImageOrder;
  period: number | null;
  start: number;
};

export type ImageBrowsePosition = {
  id: string;
  imageTime: string;
  sortScore: number;
  phase: 0 | 1;
};

export function createImageBrowseContext(
  order: PublicImageOrder,
  now = Date.now()
): ImageBrowseContext {
  const period = order === "random" ? Math.floor(now / millisecondsPerDay) : null;
  const date = period === null ? null : new Date(period * millisecondsPerDay).toISOString().split("T")[0]!;
  return {
    order,
    period,
    start: date === null ? 0 : Number.parseInt(
      hash("sha256", `browse:${date}`, "hex").slice(0, 12), 16
    )
  };
}

/** Exact value boundaries; the request owns filtering and traversal direction. */
export function encodeImageCursor(
  row: { id: string } & ({ cursor_image_time: string } | { sort_score: number }),
  context: ImageBrowseContext
) {
  const id = uuidBytes(row.id);
  if (id?.length !== 16) throw new Error("Invalid image list cursor row");
  if (context.order === "random") {
    if (context.period === null) throw new Error("Missing image browse period");
    const payload = Buffer.alloc(randomPayloadBytes);
    payload.writeIntBE(context.period, 0, 3);
    id.copy(payload, 3);
    return payload.toString("base64url");
  }

  const microseconds = "sort_score" in row
    ? (Number.isSafeInteger(row.sort_score) ? BigInt(row.sort_score) : null)
    : timestampMicroseconds(row.cursor_image_time);
  if (microseconds === null) throw new Error("Invalid image list cursor row");
  const payload = Buffer.alloc(orderedPayloadBytes + 1);
  payload.writeBigInt64BE(microseconds, 0);
  id.copy(payload, 8);
  // Safe-integer microseconds fit in 54 signed bits; omit the sign-extension byte.
  return payload.subarray(1).toString("base64url");
}

export function decodeImageCursor(
  value: string,
  context: ImageBrowseContext
): ImageBrowsePosition {
  try {
    const random = context.order === "random";
    const payloadBytes = random ? randomPayloadBytes : orderedPayloadBytes;
    if (value.length !== Math.ceil(payloadBytes * 4 / 3)) throw new Error();
    if (!cursorPattern.test(value)) throw new Error();
    const payload = Buffer.from(value, "base64url");
    if (
      payload.length !== payloadBytes
      || payload.toString("base64url") !== value
    ) {
      throw new Error();
    }
    const id = uuidFromBytes(payload.subarray(random ? 3 : 7));
    if (!id) throw new Error();
    if (random) {
      if (payload.readIntBE(0, 3) !== context.period) {
        throw new ApiError(409, "cursor_expired", "Image browse cursor has expired");
      }
      const sortScore = Number.parseInt(id.slice(-12), 16);
      return { id, imageTime: "", sortScore, phase: sortScore < context.start ? 1 : 0 };
    }

    const timestamp = Buffer.alloc(8, payload[0]! & 0x80 ? 0xff : 0);
    payload.copy(timestamp, 1, 0, 7);
    const microseconds = timestamp.readBigInt64BE(0);
    const imageTime = microsecondsTimestamp(microseconds);
    if (!imageTime) throw new Error();
    return { imageTime, id, sortScore: Number(microseconds), phase: 0 };
  } catch (error) {
    if (error instanceof ApiError && error.code === "cursor_expired") throw error;
    throw new ApiError(400, "invalid_cursor", "Invalid image list cursor");
  }
}
