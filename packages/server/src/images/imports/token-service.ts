import {
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { appConfig } from "@imageshow/shared";
import { ApiError } from "../../core/api-error.ts";
import { stableJson } from "./session-projection.ts";

export const importTokenPurposes = [
  "imageshow/upload-intent-credential/v1",
  "imageshow/queue-watermark/v1",
  "imageshow/queue-continuation/v1"
] as const;
export type ImportTokenPurpose = typeof importTokenPurposes[number];

type ImportTokenEnvelope = Record<string, unknown> & {
  purpose: ImportTokenPurpose;
  issued_at: number;
  expires_at: number;
};

type ImportTokenServiceOptions = {
  rootKey?: Uint8Array;
  now?: () => number;
  maximumTokenBytes?: number;
  maximumPayloadBytes?: number;
};

function invalidToken(message = "导入凭证无效") {
  return new ApiError(401, "invalid_import_token", message);
}

function decodeBase64Url(value: string, maximumBytes: number) {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) throw invalidToken();
  let decoded: Buffer;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw invalidToken();
  }
  if (
    decoded.length > maximumBytes
    || decoded.toString("base64url") !== value
  ) throw invalidToken();
  return decoded;
}

function validateEnvelope(
  value: unknown,
  expectedPurpose: ImportTokenPurpose,
  now: number
): ImportTokenEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidToken();
  }
  const envelope = value as ImportTokenEnvelope;
  if (
    envelope.purpose !== expectedPurpose
    || !Number.isSafeInteger(envelope.issued_at)
    || !Number.isSafeInteger(envelope.expires_at)
    || envelope.issued_at < 0
    || envelope.expires_at <= envelope.issued_at
    || envelope.issued_at > now
    || envelope.expires_at <= now
  ) throw invalidToken("导入凭证已过期或时间无效");
  return envelope;
}

export class ImportTokenService {
  readonly #rootKey: Buffer;
  readonly #now: () => number;
  readonly #maximumTokenBytes: number;
  readonly #maximumPayloadBytes: number;

  constructor(options: ImportTokenServiceOptions = {}) {
    const rootKey = Buffer.from(options.rootKey ?? randomBytes(32));
    if (rootKey.length !== 32) {
      throw new RangeError("Import token root key must contain exactly 256 bits");
    }
    this.#rootKey = Buffer.from(rootKey);
    this.#now = options.now ?? Date.now;
    this.#maximumTokenBytes = options.maximumTokenBytes
      ?? appConfig.importRuntime.tokenMaxBytes;
    this.#maximumPayloadBytes = options.maximumPayloadBytes
      ?? appConfig.importRuntime.tokenPayloadMaxBytes;
  }

  #mac(purpose: ImportTokenPurpose, payload: Buffer) {
    return createHmac("sha256", this.#rootKey)
      .update(purpose, "utf8")
      .update("\0", "utf8")
      .update(payload)
      .digest();
  }

  sign(
    purpose: ImportTokenPurpose,
    claims: Readonly<Record<string, unknown>>,
    expiresAt: number,
    issuedAt = this.#now()
  ) {
    if (
      "purpose" in claims
      || "issued_at" in claims
      || "expires_at" in claims
      || !Number.isSafeInteger(issuedAt)
      || !Number.isSafeInteger(expiresAt)
      || issuedAt < 0
      || expiresAt <= issuedAt
    ) throw new RangeError("Import token claims or lifetime are invalid");
    const envelope = {
      purpose,
      issued_at: issuedAt,
      expires_at: expiresAt,
      ...claims
    } satisfies ImportTokenEnvelope;
    const payload = Buffer.from(stableJson(envelope), "utf8");
    if (payload.length > this.#maximumPayloadBytes) {
      throw new RangeError("Import token payload exceeds its byte limit");
    }
    const token = `${payload.toString("base64url")}.${this.#mac(
      purpose,
      payload
    ).toString("base64url")}`;
    if (Buffer.byteLength(token, "utf8") > this.#maximumTokenBytes) {
      throw new RangeError("Import token exceeds its byte limit");
    }
    return token;
  }

  verify<T extends ImportTokenEnvelope>(
    purpose: ImportTokenPurpose,
    token: string,
    validateClaims: (value: ImportTokenEnvelope) => value is T
  ): T {
    if (
      typeof token !== "string"
      || Buffer.byteLength(token, "utf8") > this.#maximumTokenBytes
    ) throw invalidToken();
    const segments = token.split(".");
    if (segments.length !== 2) throw invalidToken();
    const payload = decodeBase64Url(
      segments[0] ?? "",
      this.#maximumPayloadBytes
    );
    const suppliedMac = decodeBase64Url(segments[1] ?? "", 32);
    const expectedMac = this.#mac(purpose, payload);
    if (
      suppliedMac.length !== expectedMac.length
      || !timingSafeEqual(suppliedMac, expectedMac)
    ) throw invalidToken();
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.toString("utf8"));
    } catch {
      throw invalidToken();
    }
    const envelope = validateEnvelope(parsed, purpose, this.#now());
    if (!validateClaims(envelope)) throw invalidToken();
    return envelope;
  }
}

export type { ImportTokenEnvelope };
