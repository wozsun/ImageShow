import { errorMessage } from "../core/api-error.ts";
import { stagingSessionId } from "../images/imports/staging-keys.ts";
import type {
  ActiveImportStorageReference
} from "../images/imports/storage-references.ts";
export {
  activeImportStorageReferences
} from "../images/imports/storage-references.ts";
import { thumbnailObjectKey } from "../storage/image-paths.ts";
import { listStorageBackends } from "../storage/backend-registry.ts";
import type { StorageBackendRecord } from "../storage/backend-config.ts";
import { groupStorageNamespaces } from "../storage/storage-namespace.ts";
import { collectStorageNamespaceSnapshot } from "../storage/object-access.ts";
import type { StorageKeyListOptions } from "../storage/key-listing.ts";

export type StorageRow = {
  id: string;
  object_key: string;
  status: string;
  storage_slug: string;
  thumbnail_size?: string | number;
};

type ImportFinalStorageReference = {
  prefix: "media" | "thumbs";
  key: string;
};

type ClassifiedStagingKey = {
  key: string;
  session: ActiveImportStorageReference;
};

export function importFinalStorageReferences(
  session: Pick<ActiveImportStorageReference, "final_object_key">
): ImportFinalStorageReference[] {
  const key = session.final_object_key;
  if (!key) return [];
  return [
    { prefix: "media", key },
    { prefix: "thumbs", key: thumbnailObjectKey(key) }
  ];
}

export function classifyStagingKeys(
  keys: string[],
  activeSessions: ReadonlyMap<string, ActiveImportStorageReference>
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

export function mergeActiveImportSessions(
  ...sessionMaps: ReadonlyArray<ReadonlyMap<string, ActiveImportStorageReference>>
) {
  const merged = new Map<string, ActiveImportStorageReference>();
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
