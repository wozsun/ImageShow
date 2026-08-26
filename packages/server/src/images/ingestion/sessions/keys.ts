import type { IngestionQueueType } from "./model.ts";
import { ingestionOwnerKey } from "./identity.ts";

const ingestionRuntimePrefix = "imageshow:import";

export const ingestionCanonicalKeyRoot = `${ingestionRuntimePrefix}:session:`;
export const ingestionOwnerQueueKeyRoot = `${ingestionRuntimePrefix}:owner:`;
export const ingestionDisplayQueueKeyRoot = `${ingestionRuntimePrefix}:display:`;
export const ingestionQueueMetadataKeyRoot = `${ingestionRuntimePrefix}:metadata:`;

export const ingestionRunnableKey = `${ingestionRuntimePrefix}:runnable`;
export const ingestionExpiresKey = `${ingestionRuntimePrefix}:expires`;

export function ingestionUploadIntentKey(owner: string, sessionId: string) {
  return `${ingestionRuntimePrefix}:upload-intent:${ingestionOwnerKey(owner)}:${sessionId}`;
}

export function ingestionCanonicalKey(owner: string, sessionId: string) {
  return `${ingestionCanonicalKeyRoot}${ingestionOwnerKey(owner)}:${sessionId}`;
}

export function ingestionCanonicalKeyPrefix(owner: string) {
  return `${ingestionCanonicalKeyRoot}${ingestionOwnerKey(owner)}:`;
}

export function ingestionOwnerQueueKey(owner: string, queue: IngestionQueueType) {
  return `${ingestionOwnerQueueKeyRoot}${ingestionOwnerKey(owner)}:${queue}`;
}

export function ingestionDisplayQueueKey(owner: string, queue: IngestionQueueType) {
  return `${ingestionDisplayQueueKeyRoot}${ingestionOwnerKey(owner)}:${queue}`;
}

export function ingestionQueueMetadataKey(
  owner: string,
  queue: IngestionQueueType
) {
  return `${ingestionQueueMetadataKeyRoot}${ingestionOwnerKey(owner)}:${queue}`;
}

export function ingestionSessionKeys(
  owner: string,
  queue: IngestionQueueType,
  sessionId: string
) {
  return {
    canonical: ingestionCanonicalKey(owner, sessionId),
    owner: ingestionOwnerQueueKey(owner, queue),
    display: ingestionDisplayQueueKey(owner, queue),
    metadata: ingestionQueueMetadataKey(owner, queue),
    runnable: ingestionRunnableKey,
    expires: ingestionExpiresKey
  } as const;
}
