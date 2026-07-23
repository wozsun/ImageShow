import { inspectTransactionOutcome, withAdvisoryLock } from "../core/db.ts";
import { applicationVersion } from "../core/application-version.ts";
import {
  importStorageBackends,
  listStorageBackends
} from "../storage/backend-registry.ts";
import {
  buildConfigPackage,
  parseConfigPackage,
  projectConfigPackagePreview,
  resolveImportedStorageBackends
} from "./config-package-format.ts";
import {
  getRuntimeConfig,
  replaceRuntimeConfigIfRevision,
  updateRuntimeConfigWithRevision,
  withRuntimeConfigWriteLease
} from "./runtime-config-store.ts";
import { advancedConfigWriteLockKey } from "./full-config.ts";

export async function createConfigPackage() {
  return buildConfigPackage(
    getRuntimeConfig(),
    await listStorageBackends(),
    applicationVersion()
  );
}

export async function previewConfigPackage(value: unknown) {
  const pkg = parseConfigPackage(value);
  const existingSlugs = new Set(
    (await listStorageBackends()).map((backend) => backend.slug)
  );
  return projectConfigPackagePreview(pkg, existingSlugs);
}

export async function importConfigPackage(
  value: unknown,
  slugMappings: Record<string, string>
) {
  const pkg = parseConfigPackage(value);
  return withRuntimeConfigWriteLease(() => withAdvisoryLock(
    advancedConfigWriteLockKey,
    async (signal, lockClient) => {
      signal.throwIfAborted();
      const existingSlugs = new Set(
        (await listStorageBackends()).map((backend) => backend.slug)
      );
      signal.throwIfAborted();
      const resolved = resolveImportedStorageBackends(
        pkg,
        existingSlugs,
        slugMappings
      );
      const previousRuntimeConfig = structuredClone(getRuntimeConfig());
      const importedBackends = resolved.map((backend) => ({
        slug: backend.slug,
        display_name: backend.display_name,
        type: backend.type,
        enabled: backend.enabled,
        is_default: backend.is_default,
        config: backend.type === "s3" ? backend.s3 : backend.webdav
      }));
      let appliedRuntimeConfigRevision: number | null = null;
      let importTransactionId: string | null = null;

      try {
        await importStorageBackends(
          importedBackends,
          async () => {
            signal.throwIfAborted();
            appliedRuntimeConfigRevision = (
              await updateRuntimeConfigWithRevision(pkg.config)
            ).revision;
          },
          lockClient,
          (transactionId) => {
            importTransactionId = transactionId;
          }
        );
        signal.throwIfAborted();
      } catch (error) {
        if (appliedRuntimeConfigRevision !== null) {
          const outcome = importTransactionId
            ? await inspectTransactionOutcome(importTransactionId)
              .catch(() => "unknown" as const)
            : "unknown";
          try {
            if (outcome === "rolled_back") {
              await replaceRuntimeConfigIfRevision(
                appliedRuntimeConfigRevision,
                previousRuntimeConfig
              );
            }
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              "导入失败，且无法恢复原运行时配置"
            );
          }
        }
        throw error;
      }

      return {
        imported_backends: resolved.map((backend) => backend.slug),
        default_backend: resolved.find((backend) => backend.is_default)?.slug ?? null
      };
    }
  ));
}
