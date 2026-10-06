import { imageObjectKey } from "../storage/objects/image-paths.ts";
import { errorMessage } from "../core/api-error.ts";
import type { ActiveIngestionStorageReference } from "../images/ingestion/cleanup/storage-references.ts";
export { activeIngestionStorageReferences } from "../images/ingestion/cleanup/storage-references.ts";
import { STORAGE_PREFIXES, type StoragePrefix } from "../storage/objects/keys.ts";
import { listStorageBackends } from "../storage/backends/registry.ts";
import type { StorageBackendRecord } from "../storage/backends/config.ts";
import { groupStorageNamespaces } from "../storage/objects/namespace.ts";
import { collectStorageNamespaceSnapshot } from "../storage/objects/access.ts";
import type { StorageKeyListOptions } from "../storage/objects/key-listing.ts";

export type ImageStorageReferenceRow = {
  id: string;
  status: string;
  storage_slug: string;
};

type IngestionFinalStorageReference = {
  prefix: StoragePrefix;
  key: string;
};

export function ingestionFinalStorageReferences(
  reference: Pick<ActiveIngestionStorageReference, "image_id" | "committing">
): IngestionFinalStorageReference[] {
  if (!reference.committing) return [];
  const key = imageObjectKey(reference.image_id);
  return STORAGE_PREFIXES.map((prefix) => ({ prefix, key }));
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
      rowsByObjectLocation.set(`${row.storage_slug}\0${imageObjectKey(row.id)}`, row);
    }
  }
  return [...rowsByObjectLocation.values()];
}

export type StorageBackendGroup = {
  /** Enabled backends: the only ones that list, probe or maintain the namespace. */
  backends: StorageBackendRecord[];
  /** Every slug sharing the namespace, disabled ones included, so their images stay referenced. */
  slugs: string[];
};

export function storageBackendGroupName(group: StorageBackendGroup) {
  return group.slugs.toSorted().join(" / ");
}

/**
 * Namespaces that checks and maintenance inspect. A disabled backend makes no
 * storage request: a namespace reached only through disabled backends is left out.
 */
export async function storageBackendGroups(): Promise<StorageBackendGroup[]> {
  return groupStorageNamespaces(await listStorageBackends()).flatMap((backends) => {
    const enabled = backends.filter((backend) => backend.enabled);
    return enabled.length
      ? [{ backends: enabled, slugs: backends.map((backend) => backend.slug) }]
      : [];
  });
}

/** Slugs whose images checks and maintenance inspect. */
export function inspectedStorageSlugs(groups: readonly StorageBackendGroup[]) {
  return new Set(groups.flatMap((group) => group.backends.map((backend) => backend.slug)));
}

export async function collectStorageBackendGroupSnapshot(
  group: StorageBackendGroup,
  options: StorageKeyListOptions & { signal: AbortSignal }
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
      options.signal.throwIfAborted();
      errors.push({ backend: backend.slug, error: errorMessage(error) });
    }
  }
  return { backend: group.slugs[0] ?? "unknown", snapshot: null, errors };
}
