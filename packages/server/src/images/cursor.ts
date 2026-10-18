import { hash } from "node:crypto";
import type { PublicImageOrder } from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import { normalizedUuidSchema } from "../core/uuid.ts";

const orderedPayloadBytes = 16;
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
  return normalizedUuid(
    [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20)
    ].join(
      "-"
    )
  );
}

export type ImageBrowseContext = {
  order: PublicImageOrder;
  period: number | null;
  start: number;
};

/** Ordered positions are the ID itself; random positions are in phase 1 once the ID suffix falls below the day's start. */
export type ImageBrowsePosition = {
  id: string;
  phase: 0 | 1;
};

export function createImageBrowseContext(
  order: PublicImageOrder,
  now = Date.now()
): ImageBrowseContext {
  const period = order === "random" ? Math.floor(now / millisecondsPerDay) : null;
  const date =
    period === null ? null : new Date(period * millisecondsPerDay).toISOString().split("T")[0]!;
  return {
    order,
    period,
    start:
      date === null ? 0
      : Number.parseInt(
        hash("sha256", `browse:${date}`, "hex").slice(0, 12), 16
      )
  };
}

/** Exact value boundaries; the request owns filtering and traversal direction. */
export function encodeImageCursor(row: { id: string }, context: ImageBrowseContext) {
  const id = uuidBytes(row.id);
  if (id?.length !== 16) throw new Error("Invalid image list cursor row");
  if (context.order !== "random") return id.toString("base64url");
  if (context.period === null) throw new Error("Missing image browse period");
  const payload = Buffer.alloc(randomPayloadBytes);
  payload.writeIntBE(context.period, 0, 3);
  id.copy(payload, 3);
  return payload.toString("base64url");
}

export function decodeImageCursor(
  value: string,
  context: ImageBrowseContext
): ImageBrowsePosition {
  try {
    const random = context.order === "random";
    const payloadBytes = random ? randomPayloadBytes : orderedPayloadBytes;
    if (value.length !== Math.ceil((payloadBytes * 4) / 3)) throw new Error();
    if (!cursorPattern.test(value)) throw new Error();
    const payload = Buffer.from(value, "base64url");
    if (payload.length !== payloadBytes
      || payload.toString("base64url") !== value) {
      throw new Error();
    }
    const id = uuidFromBytes(payload.subarray(random ? 3 : 0));
    if (!id) throw new Error();
    if (!random) return { id, phase: 0 };
    if (payload.readIntBE(0, 3) !== context.period) {
      throw new ApiError(409, "cursor_expired", "Image browse cursor has expired");
    }
    return { id, phase: Number.parseInt(id.slice(-12), 16) < context.start ? 1 : 0 };
  } catch (error) {
    if (error instanceof ApiError && error.code === "cursor_expired") throw error;
    throw new ApiError(400, "invalid_cursor", "Invalid image list cursor");
  }
}
