import { pool } from "../core/database-pools.ts";
import { errorMessage } from "../core/api-error.ts";
import { stagingSessionId } from "../images/imports/staging-keys.ts";
import type { ImportMode } from "@imageshow/shared/browser";
import { thumbnailObjectKey } from "../storage/image-paths.ts";
import { listStorageBackends } from "../storage/backend-registry.ts";
import type { StorageBackendRecord } from "../storage/backend-config.ts";
import { shareStorageNamespace } from "../storage/storage-namespace.ts";
import { collectStorageNamespaceSnapshot } from "../storage/object-access.ts";
import type { StorageKeyListOptions } from "../storage/key-listing.ts";

export type StorageRow = {
  id: string;
  object_key: string;
  status: string;
  storage_slug: string;
  thumbnail_size?: string | number;
};

export type ActiveImportStorageReference = {
  id: string;
  mode: ImportMode;
  status: string;
  storage_slug: string;
  final_object_key: string | null;
  expires_at: string | Date;
};

type ImportFinalStorageReference = {
  prefix: "media" | "thumbs";
  key: string;
};

type ClassifiedStagingKey = {
  key: string;
  session: ActiveImportStorageReference;
};

const ACTIVE_IMPORT_STORAGE_STATUSES = [
  "created",
  "materializing",
  "received",
  "preparing",
  "ready",
  "committing"
] as const;

export function importFinalStorageReferences(
  session: Pick<ActiveImportStorageReference, "mode" | "final_object_key">
): ImportFinalStorageReference[] {
  const key = session.final_object_key;
  if (!key) return [];
  return [
    { prefix: "media", key },
    { prefix: "thumbs", key: thumbnailObjectKey(key) }
  ];
}

export async function activeImportStorageReferences() {
  const rows = (await pool.query(
    `SELECT id, mode, status, storage_slug, final_object_key, expires_at
     FROM import_session
     WHERE status = ANY($1::text[])
       AND expires_at >= now()`,
    [ACTIVE_IMPORT_STORAGE_STATUSES]
  )).rows as ActiveImportStorageReference[];
  const sessionsByBackend = new Map<string, Map<string, ActiveImportStorageReference>>();

  for (const row of rows) {
    let sessions = sessionsByBackend.get(row.storage_slug);
    if (!sessions) {
      sessions = new Map<string, ActiveImportStorageReference>();
      sessionsByBackend.set(row.storage_slug, sessions);
    }
    sessions.set(String(row.id), row);
  }

  return { rows, sessionsByBackend };
}

export async function importSessionIdsByBackend() {
  const rows = (await pool.query(
    "SELECT id, storage_slug FROM import_session"
  )).rows as Array<{ id: string; storage_slug: string }>;
  const idsByBackend = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = idsByBackend.get(row.storage_slug);
    if (ids) ids.add(String(row.id));
    else idsByBackend.set(row.storage_slug, new Set([String(row.id)]));
  }
  return idsByBackend;
}

export function mergeImportSessionIds(
  ...snapshots: ReadonlyArray<ReadonlyMap<string, ReadonlySet<string>>>
) {
  const merged = new Map<string, Set<string>>();
  for (const snapshot of snapshots) {
    for (const [backend, snapshotIds] of snapshot) {
      let ids = merged.get(backend);
      if (!ids) {
        ids = new Set<string>();
        merged.set(backend, ids);
      }
      for (const id of snapshotIds) ids.add(id);
    }
  }
  return merged;
}

export function classifyStagingKeys(
  keys: string[],
  activeSessions: ReadonlyMap<string, ActiveImportStorageReference>
) {
  const active: ClassifiedStagingKey[] = [];
  const orphan: string[] = [];

  for (const key of keys) {
    const session = activeSessions.get(stagingSessionId(key));
    if (session) {
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

function appendStorageBackend(
  groups: StorageBackendRecord[][],
  backend: StorageBackendRecord
) {
  const matches = groups.flatMap((group, index) => (
    group.some((candidate) => shareStorageNamespace(candidate, backend))
      ? [index]
      : []
  ));
  if (!matches.length) {
    groups.push([backend]);
    return;
  }

  const merged = matches.flatMap((index) => groups[index]);
  merged.push(backend);
  for (const index of matches.toReversed()) {
    groups.splice(index, 1);
  }
  groups.push(merged);
}

export async function storageBackendGroups(): Promise<StorageBackendGroup[]> {
  const grouped: StorageBackendRecord[][] = [];
  for (const backend of await listStorageBackends()) {
    appendStorageBackend(grouped, backend);
  }
  return grouped.map((backends) => ({
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
