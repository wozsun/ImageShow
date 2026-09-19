import { storageObjectKey } from "@imageshow/shared/browser";
import { errorMessage } from "../core/api-error.ts";
import type {
  ActiveIngestionStorageReference
} from "../images/ingestion/cleanup/storage-references.ts";
export {
  activeIngestionStorageReferences
} from "../images/ingestion/cleanup/storage-references.ts";
import { thumbnailObjectKey } from "../storage/objects/image-paths.ts";
import { listStorageBackends } from "../storage/backends/registry.ts";
import type { StorageBackendRecord } from "../storage/backends/config.ts";
import { groupStorageNamespaces } from "../storage/objects/namespace.ts";
import { collectStorageNamespaceSnapshot } from "../storage/objects/access.ts";
import type { StorageKeyListOptions } from "../storage/objects/key-listing.ts";

export type ImageStorageReferenceRow = {
  id: string;
  ext: string;
  status: string;
  storage_slug: string;
  thumbnail_size?: string | number;
};

type IngestionFinalStorageReference = {
  prefix: "full" | "thumbs";
  key: string;
};

export function ingestionFinalStorageReferences(
  reference: Pick<ActiveIngestionStorageReference, "image_id" | "commit_ext">
): IngestionFinalStorageReference[] {
  if (!reference.commit_ext) return [];
  const key = storageObjectKey(reference.image_id, reference.commit_ext);
  return [
    { prefix: "full", key },
    { prefix: "thumbs", key: thumbnailObjectKey(reference.image_id) }
  ];
}

export function mergeActiveIngestionStorageReferences(
  ...referenceMaps: ReadonlyArray<ReadonlyMap<string, ActiveIngestionStorageReference>>
) {
  const merged = new Map<string, ActiveIngestionStorageReference>();
  for (const references of referenceMaps) {
    for (const [id, reference] of references) merged.set(id, reference);
  }
  return merged;
}

export function mergeStorageReferenceRows(
  ...snapshots: ReadonlyArray<readonly ImageStorageReferenceRow[]>
) {
  const rowsByObjectLocation = new Map<string, ImageStorageReferenceRow>();
  for (const rows of snapshots) {
    for (const row of rows) {
      rowsByObjectLocation.set(`${row.storage_slug}\0${storageObjectKey(row.id, row.ext)}`, row);
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
