import type { QueryClient } from "@tanstack/react-query";

export type ImageDataRevision = Readonly<{ sequence: number }>;

const revisions = new WeakMap<QueryClient, ImageDataRevision>();

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
