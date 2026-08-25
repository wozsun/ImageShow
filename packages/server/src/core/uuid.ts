import { randomUUIDv7 } from "node:crypto";

const UUID_V7_MAX_TIMESTAMP = 0xffffffffffff;

export function randomUuidV7() {
  return randomUUIDv7();
}

export function randomUuidV7At(date: Date, randA?: number) {
  const timestamp = date.getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > UUID_V7_MAX_TIMESTAMP) {
    throw new RangeError("UUIDv7 timestamp must fit in 48 bits");
  }
  if (randA !== undefined && (!Number.isInteger(randA) || randA < 0 || randA > 0xfff)) {
    throw new RangeError("UUIDv7 rand_a must fit in 12 bits");
  }

  const source = randomUUIDv7().replaceAll("-", "");
  const encodedRandA = randA === undefined ? source.slice(13, 16) : randA.toString(16).padStart(3, "0");
  const value = timestamp.toString(16).padStart(12, "0") + source.slice(12, 13) + encodedRandA + source.slice(16);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

const uuidV7Pattern = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Return the embedded Unix millisecond timestamp only for a valid UUIDv7. */
export function uuidV7Timestamp(value: string) {
  const match = uuidV7Pattern.exec(value);
  if (!match) return null;
  const timestamp = Number.parseInt(`${match[1]}${match[2]}`, 16);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}
