import { createHash } from "node:crypto";
import { ApiError } from "../../../core/api-error.ts";
import type { IngestionQueueType } from "./model.ts";

const sessionIdentityDomain = "imageshow/ingestion/session";
const ownerKeyDomain = "imageshow/ingestion/owner";

function lengthPrefixed(value: string) {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function identityDigest(domain: string, values: readonly string[]) {
  const hash = createHash("sha256");
  hash.update(domain);
  for (const value of values) hash.update(`\0${lengthPrefixed(value)}`);
  return hash.digest("base64url");
}

export function createIngestionSessionId(
  owner: string,
  queue: IngestionQueueType,
  idempotencyKey: string
) {
  return identityDigest(sessionIdentityDomain, [owner, queue, idempotencyKey]);
}

export function ingestionOwnerKey(owner: string) {
  return identityDigest(ownerKeyDomain, [owner]).slice(0, 32);
}

function compactUuid(value: string) {
  const compact = value.toLowerCase().replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/u.test(compact)) {
    throw new ApiError(400, "invalid_image_identity", "图片身份不是合法 UUID");
  }
  return compact;
}

export function createIngestionDisplayOrderKey(
  batchKey: string,
  batchPosition: number,
  sessionId: string
) {
  if (
    !Number.isInteger(batchPosition)
    || batchPosition < 0
    || batchPosition > 0xfff
    || !/^[A-Za-z0-9_-]{43}$/u.test(sessionId)
  ) {
    throw new ApiError(400, "invalid_ingestion_order", "内容接入批次位置无效");
  }
  const inversePosition = (0xfff - batchPosition)
    .toString(16)
    .padStart(3, "0");
  return `${compactUuid(batchKey)}:${inversePosition}:${sessionId}`;
}

export function inspectImageUuidV7(value: string) {
  const compact = compactUuid(value);
  const timestamp = Number.parseInt(compact.slice(0, 12), 16);
  const version = Number.parseInt(compact.slice(12, 13), 16);
  const randA = Number.parseInt(compact.slice(13, 16), 16);
  const variant = Number.parseInt(compact.slice(16, 17), 16) >> 2;
  return { timestamp, version, variant, randA };
}

export function assertImageIdentity(
  imageId: string,
  imageTime: string,
  batchPosition?: number | null
) {
  const inspected = inspectImageUuidV7(imageId);
  const timestamp = new Date(imageTime).getTime();
  if (
    inspected.version !== 7
    || inspected.variant !== 2
    || !Number.isSafeInteger(timestamp)
    || inspected.timestamp !== timestamp
    || (
      batchPosition !== undefined
      && batchPosition !== null
      && inspected.randA !== batchPosition
    )
  ) {
    throw new ApiError(
      409,
      "invalid_image_identity",
      "图片身份与已冻结的图片时间或批次位置不一致"
    );
  }
  return inspected;
}
