import { createHash } from "node:crypto";

const credentialVersionPattern = /^[A-Za-z0-9_-]{43}$/u;

export function adminCredentialVersion(passwordHash: string) {
  return createHash("sha256")
    .update(passwordHash)
    .digest("base64url");
}

export type AdminCredentialTransitionVersions = [string, string];

export function adminCredentialTransitionVersions(
  currentPasswordHash: string,
  nextCredentialVersion: string
): AdminCredentialTransitionVersions {
  return [
    adminCredentialVersion(currentPasswordHash),
    nextCredentialVersion
  ];
}

export function parseAdminCredentialVersions(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    return null;
  }
  if (!value.every((item): item is string => (
    typeof item === "string" && credentialVersionPattern.test(item)
  ))) return null;
  if (new Set(value).size !== value.length) return null;
  return [...value];
}
