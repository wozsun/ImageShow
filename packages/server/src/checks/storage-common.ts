import { pool } from "../core/db.ts";
import { stagingSessionId } from "../images/imports/staging.ts";
import type { ImportMode } from "../images/imports/types.ts";
import { thumbnailObjectKey, thumbnailRef } from "../storage/image-paths.ts";
import { listStorageBackends } from "../storage/backend-registry.ts";

export type StorageRow = { id: string; object_key: string; status: string; storage_slug: string };

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

export async function storageBackends() {
  const all = await listStorageBackends();
  const defaultBackend = (all.find((backend) => backend.is_default) ?? all.find((backend) => backend.slug === "local") ?? all[0])?.slug ?? "local";
  return { defaultBackend, backends: all.map((backend) => backend.slug) };
}

export function expectedThumbs(rows: StorageRow[]) {
  const thumbs = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.status !== "ready" && row.status !== "deleted") continue;
    const ref = thumbnailRef(row);
    let set = thumbs.get(ref.slug);
    if (!set) { set = new Set<string>(); thumbs.set(ref.slug, set); }
    set.add(ref.key);
  }
  return { thumbs };
}
