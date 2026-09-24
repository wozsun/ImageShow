import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

const CURRENT_PASSWORD_HASH_POLICY = Object.freeze({
  algorithm: "argon2id" as const,
  version: 19,
  memory: 65_536,
  passes: 3,
  parallelism: 4,
  tagLength: 32,
  saltLength: 24
});
const MAX_ENCODED_PASSWORD_HASH_LENGTH = 256;

const encodedHashPattern =
  /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

type PasswordHashValues = {
  salt: Buffer;
  expected: Buffer;
};

function encodeBase64(value: Uint8Array) {
  return Buffer.from(value).toString("base64").replace(/=+$/, "");
}

function decodeBase64(value: string) {
  const decoded = Buffer.from(value, "base64");
  if (encodeBase64(decoded) !== value) throw new Error("Invalid Argon2 PHC base64");
  return decoded;
}

function parsePositiveInteger(value: string) {
  if (!/^\d+$/.test(value)) throw new Error("Invalid Argon2 PHC parameter");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("Invalid Argon2 PHC parameter");
  return parsed;
}

function parsePasswordHash(encoded: string): PasswordHashValues | null {
  try {
    if (encoded.length > MAX_ENCODED_PASSWORD_HASH_LENGTH) return null;
    const match = encoded.match(encodedHashPattern);
    if (!match) return null;

    const version = parsePositiveInteger(match[1]);
    const memory = parsePositiveInteger(match[2]);
    const passes = parsePositiveInteger(match[3]);
    const parallelism = parsePositiveInteger(match[4]);
    const salt = decodeBase64(match[5]);
    const expected = decodeBase64(match[6]);
    const policy = CURRENT_PASSWORD_HASH_POLICY;

    if (
      version !== policy.version ||
      memory !== policy.memory ||
      passes !== policy.passes ||
      parallelism !== policy.parallelism ||
      salt.length !== policy.saltLength ||
      expected.length !== policy.tagLength
    )
      return null;

    return { salt, expected };
  } catch {
    return null;
  }
}

export function isCurrentPasswordHash(encoded: string) {
  return parsePasswordHash(encoded) !== null;
}

function derivePassword(password: string, salt: Buffer) {
  const policy = CURRENT_PASSWORD_HASH_POLICY;
  return new Promise<Buffer>((resolve, reject) => {
    argon2(
      policy.algorithm,
      {
        message: Buffer.from(password, "utf8"),
        nonce: salt,
        parallelism: policy.parallelism,
        tagLength: policy.tagLength,
        memory: policy.memory,
        passes: policy.passes
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      }
    );
  });
}

export async function hashPassword(password: string) {
  const policy = CURRENT_PASSWORD_HASH_POLICY;
  const salt = randomBytes(policy.saltLength);
  const hash = await derivePassword(password, salt);
  return `$${policy.algorithm}$v=${policy.version}$m=${policy.memory},t=${policy.passes},p=${policy.parallelism}$${encodeBase64(salt)}$${encodeBase64(hash)}`;
}

export async function verifyPassword(encoded: string, password: string) {
  const parameters = parsePasswordHash(encoded);
  if (!parameters) return false;
  try {
    const actual = await derivePassword(password, parameters.salt);
    return (
      actual.length === parameters.expected.length && timingSafeEqual(actual, parameters.expected)
    );
  } catch {
    return false;
  }
}
