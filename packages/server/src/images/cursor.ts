import { ApiError } from "../core/http.js";
import { uuidInput } from "../core/validation.js";

// Opaque keyset-pagination cursor over (created_at, id) for image lists ordered
// by `created_at DESC, id DESC`. Shared by the admin and public image lists.
export function encodeImageCursor(row: { cursor_created_at: string; id: string }) {
  return Buffer.from(JSON.stringify([row.cursor_created_at, row.id])).toString("base64url");
}

export function decodeImageCursor(value: string) {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!Array.isArray(decoded) || decoded.length !== 2 || typeof decoded[0] !== "string" || typeof decoded[1] !== "string") throw new Error();
    if (!Number.isFinite(Date.parse(decoded[0])) || !uuidInput.safeParse(decoded[1]).success) throw new Error();
    return { createdAt: decoded[0], id: decoded[1] };
  } catch {
    throw new ApiError(400, "invalid_cursor", "Invalid image list cursor");
  }
}
