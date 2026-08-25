import type { ImportQueueType } from "./session-model.ts";
import { importOwnerKey } from "./session-identity.ts";

const importRuntimePrefix = "imageshow:import";

export const importCanonicalKeyRoot = `${importRuntimePrefix}:session:`;
export const importOwnerQueueKeyRoot = `${importRuntimePrefix}:owner:`;
export const importDisplayQueueKeyRoot = `${importRuntimePrefix}:display:`;
export const importQueueMetadataKeyRoot = `${importRuntimePrefix}:metadata:`;

export const importRunnableKey = `${importRuntimePrefix}:runnable`;
export const importExpiresKey = `${importRuntimePrefix}:expires`;

export function importUploadIntentKey(owner: string, sessionId: string) {
  return `${importRuntimePrefix}:upload-intent:${importOwnerKey(owner)}:${sessionId}`;
}

export function importCanonicalKey(owner: string, sessionId: string) {
  return `${importCanonicalKeyRoot}${importOwnerKey(owner)}:${sessionId}`;
}

export function importCanonicalKeyPrefix(owner: string) {
  return `${importCanonicalKeyRoot}${importOwnerKey(owner)}:`;
}

export function importOwnerQueueKey(owner: string, queue: ImportQueueType) {
  return `${importOwnerQueueKeyRoot}${importOwnerKey(owner)}:${queue}`;
}

export function importDisplayQueueKey(owner: string, queue: ImportQueueType) {
  return `${importDisplayQueueKeyRoot}${importOwnerKey(owner)}:${queue}`;
}

export function importQueueMetadataKey(
  owner: string,
  queue: ImportQueueType
) {
  return `${importQueueMetadataKeyRoot}${importOwnerKey(owner)}:${queue}`;
}

export function importSessionKeys(
  owner: string,
  queue: ImportQueueType,
  sessionId: string
) {
  return {
    canonical: importCanonicalKey(owner, sessionId),
    owner: importOwnerQueueKey(owner, queue),
    display: importDisplayQueueKey(owner, queue),
    metadata: importQueueMetadataKey(owner, queue),
    runnable: importRunnableKey,
    expires: importExpiresKey
  } as const;
}
