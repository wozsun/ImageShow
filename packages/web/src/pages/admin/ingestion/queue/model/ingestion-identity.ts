export function webUuidV7(now = Date.now()) {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random values are unavailable");
  }
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new RangeError("UUIDv7 timestamp is outside the 48-bit range");
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let lastIngestionBatchTimestamp = -1;

/**
 * Keep batch UUIDs strictly time-ordered inside one browser document, including
 * multiple selections created within the same millisecond.
 */
export function webIngestionBatchKey(now = Date.now()) {
  const timestamp = Math.max(now, lastIngestionBatchTimestamp + 1);
  const batchKey = webUuidV7(timestamp);
  lastIngestionBatchTimestamp = timestamp;
  return batchKey;
}
