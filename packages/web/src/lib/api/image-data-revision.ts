import type { QueryClient } from "@tanstack/react-query";

export type ImageDataRevision = Readonly<{ sequence: number }>;

const revisions = new WeakMap<QueryClient, ImageDataRevision>();
type DetailValidation = Readonly<{ expiresAt: number }>;
const detailValidations = new WeakMap<QueryClient, Map<string, DetailValidation>>();

// A closed detail owns no HTTP entity. Preserve only the need to validate a
// locally changed image until any pre-commit shared response has expired.
export function markPublicDetailValidation(client: QueryClient, ids: readonly string[]) {
  const now = Date.now();
  const entries = detailValidations.get(client) ?? new Map<string, DetailValidation>();
  for (const [id, token] of entries) if (token.expiresAt <= now) entries.delete(id);
  for (const id of ids) entries.set(id, { expiresAt: now + 60_000 });
  detailValidations.set(client, entries);
}

export function publicDetailValidation(client: QueryClient, id: string) {
  const entries = detailValidations.get(client);
  const token = entries?.get(id);
  if (token && token.expiresAt > Date.now()) return token;
  entries?.delete(id);
  return undefined;
}

export function completePublicDetailValidation(client: QueryClient, id: string, token: DetailValidation) {
  const entries = detailValidations.get(client);
  if (entries?.get(id) === token) entries.delete(id);
}

export function imageDataRevision(client: QueryClient) {
  let revision = revisions.get(client);
  if (!revision) {
    revision = { sequence: 0 };
    revisions.set(client, revision);
  }
  return revision;
}

export function advanceImageDataRevision(client: QueryClient) {
  revisions.set(client, { sequence: imageDataRevision(client).sequence + 1 });
}
