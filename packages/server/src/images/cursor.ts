import { ApiError } from "../core/api-error.ts";
import { uuidInput } from "../core/validation.ts";

const cursorPayloadBytes = 24;
const cursorLength = 32;
const microsecondsPerSecond = 1_000_000n;
const minimumCursorMicroseconds = BigInt(Number.MIN_SAFE_INTEGER);
const maximumCursorMicroseconds = BigInt(Number.MAX_SAFE_INTEGER);
const cursorPattern = /^[A-Za-z0-9_-]{32}$/;
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
  if (!uuidInput.safeParse(value).success) return null;
  return value.toLowerCase();
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

export function encodeImageCursor(row: { cursor_image_time: string; id: string }) {
  const microseconds = cursorTimestampMicroseconds(row.cursor_image_time);
  const id = uuidBytes(row.id);
  if (microseconds === null || id?.length !== 16) {
    throw new Error("Invalid image list cursor row");
  }
  const payload = Buffer.alloc(cursorPayloadBytes);
  payload.writeBigInt64BE(microseconds, 0);
  id.copy(payload, 8);
  const encoded = payload.toString("base64url");
  if (encoded.length !== cursorLength) {
    throw new Error("Invalid image list cursor encoding");
  }
  return encoded;
}

export function decodeImageCursor(value: string) {
  try {
    if (value.length !== cursorLength) throw new Error();
    if (!cursorPattern.test(value)) throw new Error();
    const payload = Buffer.from(value, "base64url");
    if (
      payload.length !== cursorPayloadBytes
      || payload.toString("base64url") !== value
    ) {
      throw new Error();
    }
    const microseconds = payload.readBigInt64BE(0);
    const imageTime = cursorImageTime(microseconds);
    const id = uuidFromBytes(payload.subarray(8));
    if (!imageTime || !id) throw new Error();
    return { imageTime, id, sortScore: Number(microseconds) };
  } catch {
    throw new ApiError(400, "invalid_cursor", "Invalid image list cursor");
  }
}
