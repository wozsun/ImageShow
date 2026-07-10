import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

const CURRENT_PASSWORD_HASH_POLICY = Object.freeze({
  algorithm: "argon2id" as const,
  version: 19,
  memory: 65_536,
  passes: 3,
  parallelism: 4,
  tagLength: 32,
  saltLength: 16
});

const ACCEPTED_PASSWORD_HASH_LIMITS = Object.freeze({
  minMemory: 16_384,
  maxMemory: 131_072,
  minPasses: 1,
  maxPasses: 10,
  minParallelism: 1,
  maxParallelism: 16,
  minSaltLength: 16,
  maxSaltLength: 64,
  minTagLength: 16,
  maxTagLength: 64,
  maxEncodedLength: 512
});

const encodedHashPattern = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

type PasswordHashParameters = {
  algorithm: "argon2id";
  version: number;
  memory: number;
  passes: number;
  parallelism: number;
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

function within(value: number, minimum: number, maximum: number) {
  return value >= minimum && value <= maximum;
}

function parsePasswordHash(encoded: string): PasswordHashParameters | null {
  try {
    if (encoded.length > ACCEPTED_PASSWORD_HASH_LIMITS.maxEncodedLength) return null;
    const match = encoded.match(encodedHashPattern);
    if (!match) return null;

    const version = parsePositiveInteger(match[1]);
    const memory = parsePositiveInteger(match[2]);
    const passes = parsePositiveInteger(match[3]);
    const parallelism = parsePositiveInteger(match[4]);
    const salt = decodeBase64(match[5]);
    const expected = decodeBase64(match[6]);
    const limits = ACCEPTED_PASSWORD_HASH_LIMITS;

    if (version !== CURRENT_PASSWORD_HASH_POLICY.version) return null;
    if (!within(memory, limits.minMemory, limits.maxMemory)) return null;
    if (!within(passes, limits.minPasses, limits.maxPasses)) return null;
    if (!within(parallelism, limits.minParallelism, limits.maxParallelism)) return null;
    if (memory < parallelism * 8) return null;
    if (!within(salt.length, limits.minSaltLength, limits.maxSaltLength)) return null;
    if (!within(expected.length, limits.minTagLength, limits.maxTagLength)) return null;

    return {
      algorithm: "argon2id",
      version,
      memory,
      passes,
      parallelism,
      salt,
      expected
    };
  } catch {
    return null;
  }
}

function derivePassword(password: string, parameters: {
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
  salt: Buffer;
}) {
  return new Promise<Buffer>((resolve, reject) => {
    argon2(CURRENT_PASSWORD_HASH_POLICY.algorithm, {
      message: Buffer.from(password, "utf8"),
      nonce: parameters.salt,
      parallelism: parameters.parallelism,
      tagLength: parameters.tagLength,
      memory: parameters.memory,
      passes: parameters.passes
    }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string) {
  const policy = CURRENT_PASSWORD_HASH_POLICY;
  const salt = randomBytes(policy.saltLength);
  const hash = await derivePassword(password, { ...policy, salt });
  return `$${policy.algorithm}$v=${policy.version}$m=${policy.memory},t=${policy.passes},p=${policy.parallelism}$${encodeBase64(salt)}$${encodeBase64(hash)}`;
}

export async function verifyPassword(encoded: string, password: string) {
  const parameters = parsePasswordHash(encoded);
  if (!parameters) return false;
  try {
    const actual = await derivePassword(password, {
      memory: parameters.memory,
      passes: parameters.passes,
      parallelism: parameters.parallelism,
      tagLength: parameters.expected.length,
      salt: parameters.salt
    });
    return actual.length === parameters.expected.length && timingSafeEqual(actual, parameters.expected);
  } catch {
    return false;
  }
}

export function passwordHashNeedsUpgrade(encoded: string) {
  const parameters = parsePasswordHash(encoded);
  if (!parameters) return true;
  const policy = CURRENT_PASSWORD_HASH_POLICY;
  return parameters.version !== policy.version ||
    parameters.memory !== policy.memory ||
    parameters.passes !== policy.passes ||
    parameters.parallelism !== policy.parallelism ||
    parameters.salt.length !== policy.saltLength ||
    parameters.expected.length !== policy.tagLength;
}
