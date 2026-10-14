/**
 * Lowercase hexadecimal of the bytes. `Uint8Array.prototype.toHex()` needs
 * Safari 18.2, newer than the supported browsers in the web reference.
 */
export function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
