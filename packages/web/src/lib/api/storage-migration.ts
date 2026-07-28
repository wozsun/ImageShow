import type { StorageLocationMigrationResponse } from "@imageshow/shared/browser";
import { api } from "./client.js";
import { adminApiBasePath } from "../constants.js";

export function migrateStorageLocation(source: string, target: string) {
  return api<StorageLocationMigrationResponse>(
    `${adminApiBasePath}/check/migrate-storage-location`,
    {
      method: "POST",
      body: JSON.stringify({ source, target })
    }
  );
}
