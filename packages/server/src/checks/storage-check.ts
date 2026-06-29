import { pool } from "../core/db.js";
import { errorMessage } from "../core/http.js";
import { thumbnailRef } from "../storage/image-paths.js";
import { listStorageKeys } from "../storage/storage.js";
import { expectedThumbs, storageBackends, type StorageRow } from "./storage-common.js";

// Cross-checks DB rows against stored objects/thumbs/trash/link per backend, reporting
// missing (referenced but absent) and orphan (present but unreferenced) keys.
export async function checkStorage() {
  const rows = (await pool.query("SELECT id, object_key, status, storage_slug, is_link, device, brightness, theme FROM metadata")).rows as StorageRow[];
  const { defaultBackend, backends } = await storageBackends();
  const expected = expectedThumbs(rows);
  const missingObjects: Array<Record<string, unknown>> = [];
  const missingThumbs: Array<Record<string, unknown>> = [];
  const missingTrash: Array<Record<string, unknown>> = [];
  const orphanObjects: Array<Record<string, unknown>> = [];
  const orphanThumbs: Array<Record<string, unknown>> = [];
  const orphanTrash: Array<Record<string, unknown>> = [];
  const unavailableBackends: string[] = [];
  let stagingFiles: string[] = [];
  // Each image is checked against the storage it actually lives in. Backends are checked in
  // parallel, and within a backend its objects/thumbs/trash/link (+ _uploads on the default)
  // listings run in parallel too — those listings are the slow, I/O-bound part (especially
  // remote WebDAV), so this collapses serial latency into a single round.
  await Promise.all(backends.map(async (backend) => {
    try {
      const ready = rows.filter((row) => row.storage_slug === backend && row.status === "ready");
      const deleted = rows.filter((row) => row.storage_slug === backend && row.status === "deleted");
      const isDefaultBackend = backend === defaultBackend;
      const [objectKeys, thumbKeys, trashKeys, linkThumbKeys, stagingKeys] = await Promise.all([
        listStorageKeys("objects", backend),
        listStorageKeys("thumbs", backend),
        listStorageKeys("trash", backend),
        listStorageKeys("link", backend),
        isDefaultBackend ? listStorageKeys("_uploads", backend) : Promise.resolve<string[]>([])
      ]);
      if (isDefaultBackend) stagingFiles = stagingKeys;
      const objectSet = new Set(objectKeys);
      const thumbSet = new Set(thumbKeys);
      const trashSet = new Set(trashKeys);
      const linkThumbSet = new Set(linkThumbKeys);
      const readySet = new Set(ready.map((row) => row.object_key));
      const readyThumbSet = expected.thumbs.get(backend) ?? new Set<string>();
      const expectedLinkSet = expected.link.get(backend) ?? new Set<string>();
      const deletedKeySet = new Set(deleted.map((row) => row.object_key));
      for (const image of ready) {
        // Link originals are external URLs, not stored objects; their thumbnails are
        // validated against the link set below, so skip the stored-object checks here.
        if (image.is_link) continue;
        if (!objectSet.has(image.object_key)) { missingObjects.push({ id: image.id, object_key: image.object_key, backend }); continue; }
        const thumbKey = thumbnailRef(image).key;
        if (!thumbSet.has(thumbKey)) missingThumbs.push({ id: image.id, object_key: image.object_key, thumb_key: thumbKey, backend });
      }
      for (const image of deleted) {
        // A soft-deleted link image keeps no trash object (delete is a no-op for links).
        if (image.is_link) continue;
        if (!trashSet.has(image.object_key)) missingTrash.push({ id: image.id, object_key: image.object_key, backend });
      }
      // A soft-deleted image's original lingers in objects/ until delete.finalize moves it to
      // trash/; treat those keys as known (not orphans) for the same reason cleanupStorage does,
      // so the check never reports a transient orphan that cleanup (correctly) refuses to remove.
      for (const key of objectKeys) if (!readySet.has(key) && !deletedKeySet.has(key)) orphanObjects.push({ key, backend });
      for (const key of thumbKeys) if (!readyThumbSet.has(key)) orphanThumbs.push({ key, backend });
      for (const key of trashKeys) if (!deletedKeySet.has(key)) orphanTrash.push({ key, backend });
      // Link thumbnails live under the top-level "link" prefix in their chosen backend.
      for (const key of expectedLinkSet) if (!linkThumbSet.has(key)) missingThumbs.push({ thumb_key: key, prefix: "link", backend });
      for (const key of linkThumbKeys) if (!expectedLinkSet.has(key)) orphanThumbs.push({ key, prefix: "link", backend });
    } catch (error) {
      unavailableBackends.push(`${backend}: ${errorMessage(error)}`);
    }
  }));
  return {
    missing_objects: missingObjects,
    missing_thumbs: missingThumbs,
    missing_trash: missingTrash,
    orphan_objects: orphanObjects,
    orphan_thumbs: orphanThumbs,
    orphan_trash: orphanTrash,
    staging_files: stagingFiles,
    unavailable_backends: unavailableBackends
  };
}
