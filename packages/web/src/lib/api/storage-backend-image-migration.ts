import { type StorageBackendMigrationResponseDto, adminApiBasePath } from "@imageshow/shared/browser";
import { api } from "./client.js";

export function migrateStorageBackendImages(source: string, target: string) {
  return api<StorageBackendMigrationResponseDto>(`${adminApiBasePath}/storage/backends/migrate`, {
    method: "POST",
    body: JSON.stringify({ source, target })
  });
}
