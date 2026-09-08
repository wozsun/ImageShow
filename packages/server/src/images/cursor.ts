import { createHash } from "node:crypto";
import type { PublicImageOrder } from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import { normalizedUuidSchema } from "../core/uuid.ts";

const orderedPayloadBytes = 23;
const randomPayloadBytes = 19;
const millisecondsPerDay = 86_400_000;
const microsecondsPerSecond = 1_000_000n;
const minimumCursorMicroseconds = BigInt(Number.MIN_SAFE_INTEGER);
const maximumCursorMicroseconds = BigInt(Number.MAX_SAFE_INTEGER);
const cursorPattern = /^[A-Za-z0-9_-]+$/;
const cursorTimestampPattern = new RegExp(
  "^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})"
    + "(?:\\.(\\d{1,6}))?(Z|[+-]\\d{2}(?::?\\d{2})?)$"
);

function cursorTimestampMicroseconds(value: string) {
  const match = cursorTimestampPattern.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = Number((match[7] ?? "").padEnd(6, "0"));
  if (
    month < 1 || month > 12
    || day < 1 || day > 31
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    return null;
  }
  const localMilliseconds = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second
  );
  if (!Number.isFinite(localMilliseconds)) return null;
  const localDate = new Date(localMilliseconds);
  if (
    localDate.getUTCFullYear() !== year
    || localDate.getUTCMonth() !== month - 1
    || localDate.getUTCDate() !== day
    || localDate.getUTCHours() !== hour
    || localDate.getUTCMinutes() !== minute
    || localDate.getUTCSeconds() !== second
  ) {
    return null;
  }

  const zone = match[8]!;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const offsetHours = Number(digits.slice(0, 2));
    const offsetMinutePart = digits.length === 4
      ? Number(digits.slice(2))
      : 0;
    if (offsetHours > 23 || offsetMinutePart > 59) return null;
    offsetMinutes = (offsetHours * 60 + offsetMinutePart)
      * (zone.startsWith("-") ? -1 : 1);
  }
  const utcMilliseconds = localMilliseconds - offsetMinutes * 60_000;
  if (!Number.isSafeInteger(utcMilliseconds)) return null;
  const microseconds = BigInt(utcMilliseconds) * 1_000n + BigInt(fraction);
  // Redis ZSET scores and the existing cursor contract require an exact Number.
  return microseconds >= minimumCursorMicroseconds
    && microseconds <= maximumCursorMicroseconds
    ? microseconds
    : null;
}

function cursorImageTime(microseconds: bigint) {
  if (
    microseconds < minimumCursorMicroseconds
    || microseconds > maximumCursorMicroseconds
  ) {
    return null;
  }
  let seconds = microseconds / microsecondsPerSecond;
  let fraction = microseconds % microsecondsPerSecond;
  if (fraction < 0) {
    seconds -= 1n;
    fraction += microsecondsPerSecond;
  }
  const date = new Date(Number(seconds) * 1_000);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.toISOString().slice(0, 19)}.${String(fraction).padStart(6, "0")}Z`;
}

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
      createHash("sha256").update(`browse:${date}`).digest("hex").slice(0, 12), 16
    )
  };
}

/** Exact value boundaries; the request owns filtering and traversal direction. */
export function encodeImageCursor(
  row: { cursor_image_time: string; id: string },
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

  const microseconds = cursorTimestampMicroseconds(row.cursor_image_time);
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
    const imageTime = cursorImageTime(microseconds);
    if (!imageTime) throw new Error();
    return { imageTime, id, sortScore: Number(microseconds), phase: 0 };
  } catch (error) {
    if (error instanceof ApiError && error.code === "cursor_expired") throw error;
    throw new ApiError(400, "invalid_cursor", "Invalid image list cursor");
  }
}
