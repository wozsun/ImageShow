import type { Context } from "hono";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  createChallenge,
  randomInt,
  verifySolution
} from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "./api-error.ts";
import { requestClientIp } from "./http/request-security.ts";
import {
  noStoreCacheControl,
  safeResponseHeaderValue
} from "./http/headers.ts";
import { redis } from "./redis/client.ts";
import { runRequiredRedisCommand } from "./runtime-availability.ts";
import { reserveRedisWindows } from "./redis/window-limit.ts";

const altchaAlgorithm = "PBKDF2/SHA-256";
const maximumPayloadLength = 16 * 1024;
const hex32Bytes = /^[a-f0-9]{64}$/;
const hex16Bytes = /^[a-f0-9]{32}$/;
const altchaTemporaryKeyPrefix = "imageshow:tmp:altcha";

const challengeParametersSchema = z.strictObject({
  algorithm: z.literal(altchaAlgorithm),
  nonce: z.string().regex(hex16Bytes),
  salt: z.string().regex(hex16Bytes),
  cost: z.number().int().min(1000).max(100_000),
  keyLength: z.literal(32),
  keyPrefix: z.string().regex(hex16Bytes),
  keySignature: z.string().regex(hex32Bytes),
  expiresAt: z.number().int().positive(),
  data: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()])
  ).optional()
});

const payloadSchema = z.strictObject({
  challenge: z.strictObject({
    parameters: challengeParametersSchema,
    signature: z.string().regex(hex32Bytes)
  }),
  solution: z.strictObject({
    counter: z.number().int().min(0).max(0xffff_ffff),
    derivedKey: z.string().regex(hex32Bytes),
    time: z.number().finite().nonnegative().optional()
  })
});
type AltchaPayload = z.infer<typeof payloadSchema>;

function derivePurposeSecret(masterSecret: Uint8Array, purpose: string) {
  return createHmac("sha256", masterSecret)
    .update(`imageshow-altcha:${purpose}`)
    .digest("base64url");
}

let altchaSecrets: {
  challengeSignatureSecret: string;
  keySignatureSecret: string;
} | undefined;

function getAltchaSecrets() {
  if (altchaSecrets) return altchaSecrets;
  const masterSecret = randomBytes(32);
  altchaSecrets = {
    challengeSignatureSecret: derivePurposeSecret(masterSecret, "challenge-signature"),
    keySignatureSecret: derivePurposeSecret(masterSecret, "key-signature")
  };
  return altchaSecrets;
}

function temporaryKey(kind: string, id: string) {
  return `${altchaTemporaryKeyPrefix}:${kind}:${id}`;
}

async function reserveChallengeRequest(c: Context) {
  const security = getRuntimeConfig().security;
  const ipLimit = security.login_max_failures * 3;
  const globalLimit = security.login_global_max_attempts * 5;
  const source = createHash("sha256").update(requestClientIp(c)).digest("base64url");
  const [ipReservation, globalReservation] = await reserveRedisWindows([
    {
      key: temporaryKey("challenge-rate-ip", source),
      capacity: ipLimit,
      windowSeconds: security.login_failure_window_seconds
    },
    {
      key: temporaryKey("challenge-rate-global", "all"),
      capacity: globalLimit,
      windowSeconds: security.login_global_window_seconds
    }
  ]);
  if (!ipReservation || !globalReservation) {
    throw new Error("ALTCHA rate-limit reservations are missing");
  }
  if (!ipReservation.allowed) {
    c.header("Retry-After", safeResponseHeaderValue(
      "Retry-After",
      String(ipReservation.retryAfterSeconds)
    ));
    throw new ApiError(429, "altcha_rate_limited", "安全验证请求过于频繁，请稍后再试");
  }
  if (!globalReservation.allowed) {
    c.header("Retry-After", safeResponseHeaderValue(
      "Retry-After",
      String(globalReservation.retryAfterSeconds)
    ));
    throw new ApiError(429, "altcha_global_rate_limited", "安全验证服务请求过于频繁，请稍后再试");
  }
}

export async function issueAltchaChallenge(c: Context) {
  const config = getRuntimeConfig().altcha;
  if (!config.enabled) {
    throw new ApiError(404, "not_found", "Not found");
  }

  await reserveChallengeRequest(c);
  c.header("Cache-Control", noStoreCacheControl);
  const secrets = getAltchaSecrets();
  const [minCounter, maxCounter] = config.counter_range;

  return createChallenge({
    algorithm: altchaAlgorithm,
    cost: config.cost,
    counter: randomInt(maxCounter, minCounter),
    deriveKey,
    expiresAt: new Date(Date.now() + config.ttl_seconds * 1000),
    hmacSignatureSecret: secrets.challengeSignatureSecret,
    hmacKeySignatureSecret: secrets.keySignatureSecret
  });
}

function decodePayload(value: unknown): AltchaPayload | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumPayloadLength ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    const parsed = payloadSchema.safeParse(decoded);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function verifyAltchaProof(proofValue: unknown) {
  if (!getRuntimeConfig().altcha.enabled) return;

  const payload = decodePayload(proofValue);
  if (!payload) {
    throw new ApiError(400, "altcha_invalid", "安全验证失败，请重试");
  }

  let verification;
  try {
    const secrets = getAltchaSecrets();
    verification = await verifySolution({
      challenge: payload.challenge,
      deriveKey,
      hmacSignatureSecret: secrets.challengeSignatureSecret,
      hmacKeySignatureSecret: secrets.keySignatureSecret,
      solution: payload.solution
    });
  } catch {
    throw new ApiError(400, "altcha_invalid", "安全验证失败，请重试");
  }

  if (verification.expired) {
    throw new ApiError(400, "altcha_expired", "安全验证已过期，请重试");
  }
  if (!verification.verified) {
    throw new ApiError(400, "altcha_invalid", "安全验证失败，请重试");
  }

  const nowSeconds = Date.now() / 1000;
  const remainingSeconds = Math.max(
    1,
    Math.min(60 * 60, Math.ceil(payload.challenge.parameters.expiresAt - nowSeconds))
  );
  const claimed = await runRequiredRedisCommand(() => redis.set(
    temporaryKey("used", payload.challenge.parameters.nonce),
    "1",
    "EX",
    remainingSeconds,
    "NX"
  ));
  if (claimed !== "OK") {
    throw new ApiError(400, "altcha_replayed", "安全验证已使用，请重新验证");
  }
}
