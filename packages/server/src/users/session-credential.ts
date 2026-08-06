import { createHash } from "node:crypto";

const credentialVersionPattern = /^[A-Za-z0-9_-]{43}$/u;

export function adminCredentialVersion(passwordHash: string) {
  return createHash("sha256")
    .update(passwordHash)
    .digest("base64url");
}

export function parseAdminCredentialVersions(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => (
    typeof item === "string" && credentialVersionPattern.test(item)
  )))].slice(0, 2);
}
