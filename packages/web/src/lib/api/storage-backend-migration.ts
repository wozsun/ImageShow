import type { StorageBackendMigrationResponseDto } from "@imageshow/shared/browser";
import { api } from "./client.js";
import { adminApiBasePath } from "../constants.js";

export function migrateStorageBackend(source: string, target: string) {
  return api<StorageBackendMigrationResponseDto>(
    `${adminApiBasePath}/storage/backends/migrate`,
    {
      method: "POST",
      body: JSON.stringify({ source, target })
    }
  );
}
