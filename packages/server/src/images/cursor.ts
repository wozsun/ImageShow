import { ApiError } from "../core/api-error.ts";
import { uuidInput } from "../core/validation.ts";

const cursorTimestampPattern = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

function cursorSortScore(value: string) {
  const match = cursorTimestampPattern.exec(value);
  if (!match) return null;
  let zone = match[4]!;
  if (/^[+-]\d{2}$/.test(zone)) zone = `${zone}:00`;
  else if (/^[+-]\d{4}$/.test(zone)) {
    zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  }
  const milliseconds = Date.parse(`${match[1]}T${match[2]}${zone}`);
  const microseconds = Number((match[3] ?? "").padEnd(6, "0"));
  const score = milliseconds * 1_000 + microseconds;
  return Number.isSafeInteger(score) ? score : null;
}

export function encodeImageCursor(row: { cursor_image_time: string; id: string }) {
  return Buffer.from(JSON.stringify([row.cursor_image_time, row.id])).toString("base64url");
}

export function decodeImageCursor(value: string) {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") throw new Error();
    const sortScore = cursorSortScore(decoded[0]);
    if (sortScore === null || !uuidInput.safeParse(decoded[1]).success) throw new Error();
    return { imageTime: decoded[0], id: decoded[1], sortScore };
  } catch {
    throw new ApiError(400, "invalid_cursor", "Invalid image list cursor");
  }
}
