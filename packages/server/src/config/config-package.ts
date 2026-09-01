import { ApiError, errorMessage } from "../core/api-error.ts";
import { inspectTransactionOutcome } from "../core/database/transactions.ts";
import { logger } from "../core/logger.ts";
import { applicationVersion } from "../core/application-version.ts";
import {
  listStorageBackends
} from "../storage/backends/registry.ts";
import { importStorageBackends } from "../storage/backends/mutations.ts";
import {
  buildConfigPackage,
  materializeImportedRuntimeConfig,
  parseConfigPackage,
  projectConfigPackagePreview,
  resolveImportedStorageBackends
} from "./config-package-format.ts";
import {
  getRuntimeConfig,
  persistRuntimeConfigForPackageImport,
  publishRuntimeConfigForPackageImport,
  withRuntimeConfigWriteLease
} from "./runtime-config-store.ts";

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
  return withRuntimeConfigWriteLease(async () => {
    const existingSlugs = new Set(
      (await listStorageBackends()).map((backend) => backend.slug)
    );
    const resolved = resolveImportedStorageBackends(
      pkg,
      existingSlugs,
      slugMappings
    );
    const previousRuntimeConfig = structuredClone(getRuntimeConfig());
    const importedRuntimeConfig = materializeImportedRuntimeConfig(
      pkg.config,
      previousRuntimeConfig.site.domain
    );
    const importedBackends = resolved.map((backend) => ({
      slug: backend.slug,
      display_name: backend.display_name,
      enabled: backend.enabled,
      is_default: backend.is_default,
      config: backend.s3
    }));
    let candidateFileState: "pending" | "persisted" | "write_failed" =
      "pending";
    let importTransactionId: string | null = null;
    const restorePreviousRuntimeConfigFile = (originalError: unknown) => {
      try {
        persistRuntimeConfigForPackageImport(previousRuntimeConfig);
      } catch (restoreError) {
        const details = {
          transaction_id: importTransactionId,
          original_error: errorMessage(originalError),
          restore_error: errorMessage(restoreError)
        };
        logger.error("config_package_file_restore_failed", details);
        throw new ApiError(
          503,
          "config_package_file_restore_failed",
          "配置包数据库事务已回滚，但旧配置文件恢复失败，请立即检查配置文件",
          details
        );
      }
    };

    try {
      await importStorageBackends(
        importedBackends,
        () => {
          try {
            persistRuntimeConfigForPackageImport(importedRuntimeConfig);
            candidateFileState = "persisted";
          } catch (error) {
            candidateFileState = "write_failed";
            throw error;
          }
        },
        (transactionId) => {
          importTransactionId = transactionId;
        }
      );
      publishRuntimeConfigForPackageImport(importedRuntimeConfig);
    } catch (error) {
      if (candidateFileState === "pending") throw error;
      if (candidateFileState === "write_failed") {
        // beforeCommit failed, so COMMIT was never sent. Restore defensively:
        // the atomic rename may already be visible even if directory fsync threw.
        restorePreviousRuntimeConfigFile(error);
        throw error;
      }

      const outcome = importTransactionId
        ? await inspectTransactionOutcome(importTransactionId)
          .catch(() => "unknown" as const)
        : "unknown";
      if (outcome === "committed") {
        publishRuntimeConfigForPackageImport(importedRuntimeConfig);
        return;
      }
      if (outcome === "rolled_back") {
        restorePreviousRuntimeConfigFile(error);
        throw error;
      }

      publishRuntimeConfigForPackageImport(importedRuntimeConfig);
      const details = {
        transaction_id: importTransactionId,
        original_error: errorMessage(error)
      };
      logger.error("config_package_outcome_unknown", details);
      throw new ApiError(
        503,
        "config_package_outcome_unknown",
        "配置包数据库事务结果暂时无法确认，候选配置已加载；请核对存储后端注册表",
        details
      );
    }
  });
}
