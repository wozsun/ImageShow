import { errorMessage } from "../core/api-error.ts";
import { stagingSessionId } from "../images/ingestion/staging-keys.ts";
import type {
  ActiveIngestionStorageReference
} from "../images/ingestion/cleanup/storage-references.ts";
export {
  activeIngestionStorageReferences
} from "../images/ingestion/cleanup/storage-references.ts";
import {
  imageObjectPrefix,
  thumbnailObjectKey,
  type ImageObjectPrefix
} from "../storage/objects/image-paths.ts";
import { listStorageBackends } from "../storage/backends/registry.ts";
import type { StorageBackendRecord } from "../storage/backends/config.ts";
import { groupStorageNamespaces } from "../storage/objects/namespace.ts";
import { collectStorageNamespaceSnapshot } from "../storage/objects/access.ts";
import type { StorageKeyListOptions } from "../storage/objects/key-listing.ts";

export type StorageRow = {
  id: string;
  object_key: string;
  status: string;
  storage_slug: string;
  thumbnail_size?: string | number;
};

type IngestionFinalStorageReference = {
  prefix: ImageObjectPrefix | "thumbs";
  key: string;
};

type ClassifiedStagingKey = {
  key: string;
  session: ActiveIngestionStorageReference;
};

export function ingestionFinalStorageReferences(
  session: Pick<ActiveIngestionStorageReference, "final_object_key">
): IngestionFinalStorageReference[] {
  const key = session.final_object_key;
  if (!key) return [];
  return [
    { prefix: imageObjectPrefix(key), key },
    { prefix: "thumbs", key: thumbnailObjectKey(key) }
  ];
}

export function classifyStagingKeys(
  keys: string[],
  activeSessions: ReadonlyMap<string, ActiveIngestionStorageReference>
) {
  const active: ClassifiedStagingKey[] = [];
  const orphan: string[] = [];

  for (const key of keys) {
    const session = activeSessions.get(stagingSessionId(key));
    if (
      session
      && (
        key === session.prepared_image_key
        || key === session.prepared_thumbnail_key
      )
    ) {
      active.push({ key, session });
    } else {
      orphan.push(key);
    }
  }

  return { active, orphan };
}

export function mergeActiveIngestionSessions(
  ...sessionMaps: ReadonlyArray<ReadonlyMap<string, ActiveIngestionStorageReference>>
) {
  const merged = new Map<string, ActiveIngestionStorageReference>();
  for (const sessions of sessionMaps) {
    for (const [id, session] of sessions) merged.set(id, session);
  }
  return merged;
}

export function mergeStorageReferenceRows(
  ...snapshots: ReadonlyArray<readonly StorageRow[]>
) {
  const rowsByObjectLocation = new Map<string, StorageRow>();
  for (const rows of snapshots) {
    for (const row of rows) {
      rowsByObjectLocation.set(`${row.storage_slug}\0${row.object_key}`, row);
    }
  }
  return [...rowsByObjectLocation.values()];
}

export type StorageBackendGroup = {
  backends: StorageBackendRecord[];
  slugs: string[];
};

export function storageBackendGroupName(group: StorageBackendGroup) {
  return group.slugs.toSorted().join(" / ");
}

export async function storageBackendGroups(): Promise<StorageBackendGroup[]> {
  return groupStorageNamespaces(await listStorageBackends()).map((backends) => ({
    backends,
    slugs: backends.map((backend) => backend.slug)
  }));
}

export async function collectStorageBackendGroupSnapshot(
  group: StorageBackendGroup,
  options: StorageKeyListOptions = {}
) {
  const errors: Array<{ backend: string; error: string }> = [];
  for (const backend of group.backends) {
    try {
      const snapshot = await collectStorageNamespaceSnapshot(
        backend.slug,
        options
      );
      return { backend: backend.slug, snapshot, errors };
    } catch (error) {
      options.signal?.throwIfAborted();
      errors.push({ backend: backend.slug, error: errorMessage(error) });
    }
  }
  return { backend: group.slugs[0] ?? "unknown", snapshot: null, errors };
}
