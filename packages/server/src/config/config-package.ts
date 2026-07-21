import { z } from "zod";
import { appConfig, slugPattern, type RuntimeConfig } from "@imageshow/shared";
import { inspectTransactionOutcome, withAdvisoryLock } from "../core/db.ts";
import { ApiError } from "../core/api-error.ts";
import { applicationVersion } from "../core/application-version.ts";
import {
  s3SettingsSchema,
  webdavSettingsSchema,
  type StorageBackendRecord
} from "../storage/backend-config.ts";
import {
  importStorageBackends,
  listStorageBackends
} from "../storage/backend-registry.ts";
import {
  portableRuntimeConfigSchema,
  type PortableRuntimeConfig
} from "./runtime-config.ts";
import {
  getRuntimeConfig,
  replaceRuntimeConfigIfRevision,
  updateRuntimeConfigWithRevision,
  withRuntimeConfigWriteLease
} from "./runtime-config-store.ts";
import { advancedConfigWriteLockKey } from "./full-config.ts";

/** @internal Exported for focused format tests. */
export const configPackageFormat = "imageshow-config" as const;
/** @internal Exported for focused format tests. */
export const configPackageFormatVersion = 2 as const;
/** @internal Exported for focused format tests. */
export const configPackageMaxBackends = appConfig.imports.configPackageMaxBackends;
const configPackageMaxBytes = appConfig.imports.configPackageMaxBytes;

const packageSlug = z.string().trim().toLowerCase().min(1).max(32).regex(slugPattern)
  .refine((slug) => slug !== "local", "local is not importable");
const packageDisplayName = z.string().trim().max(64);
const packageBackendBase = {
  slug: packageSlug,
  display_name: packageDisplayName,
  enabled: z.boolean(),
  is_default: z.boolean()
};
const packageStorageBackendSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...packageBackendBase,
    type: z.literal("s3"),
    s3: s3SettingsSchema.strict()
  }),
  z.strictObject({
    ...packageBackendBase,
    type: z.literal("webdav"),
    webdav: webdavSettingsSchema.strict()
  })
]);

/** @internal Exported for focused schema tests. */
export const configPackageSchema = z.strictObject({
  format: z.literal(configPackageFormat),
  format_version: z.literal(configPackageFormatVersion),
  application_version: z.string().trim().min(1).max(64),
  exported_at: z.iso.datetime(),
  config: portableRuntimeConfigSchema,
  storage_backends: z.array(packageStorageBackendSchema).max(configPackageMaxBackends)
}).superRefine((value, context) => {
  const slugs = new Set<string>();
  let defaultCount = 0;
  value.storage_backends.forEach((backend, index) => {
    if (slugs.has(backend.slug)) {
      context.addIssue({
        code: "custom",
        message: `duplicate storage slug: ${backend.slug}`,
        path: ["storage_backends", index, "slug"]
      });
    }
    slugs.add(backend.slug);
    if (backend.is_default) defaultCount += 1;
  });
  if (defaultCount > 1) {
    context.addIssue({
      code: "custom",
      message: "only one imported backend may be default",
      path: ["storage_backends"]
    });
  }
  const importedDefault = value.storage_backends.find((backend) => backend.is_default);
  if (importedDefault && !importedDefault.enabled) {
    context.addIssue({
      code: "custom",
      message: "the imported default backend must be enabled",
      path: ["storage_backends"]
    });
  }
});

export type ConfigPackage = z.infer<typeof configPackageSchema>;
export type ConfigPackageStorageBackend = ConfigPackage["storage_backends"][number];

function portableConfig(runtime: RuntimeConfig): PortableRuntimeConfig {
  const { domain: _domain, ...portableSite } = runtime.site;
  return portableRuntimeConfigSchema.parse({ ...runtime, site: portableSite });
}

function portableBackends(backends: StorageBackendRecord[]): ConfigPackageStorageBackend[] {
  const portable: ConfigPackageStorageBackend[] = [];
  for (const backend of backends) {
    if (backend.type === "local") continue;
    const base = {
      slug: backend.slug,
      display_name: backend.display_name,
      enabled: backend.enabled,
      is_default: backend.is_default
    };
    portable.push(backend.type === "s3"
      ? { ...base, type: "s3", s3: backend.s3 }
      : { ...base, type: "webdav", webdav: backend.webdav });
  }
  return portable;
}

/** @internal Exported for focused projection tests. */
export function buildConfigPackage(
  runtime: RuntimeConfig,
  backends: StorageBackendRecord[],
  applicationVersion: string,
  exportedAt = new Date()
): ConfigPackage {
  return parseConfigPackage({
    format: configPackageFormat,
    format_version: configPackageFormatVersion,
    application_version: applicationVersion,
    exported_at: exportedAt.toISOString(),
    config: portableConfig(runtime),
    storage_backends: portableBackends(backends)
  });
}

/** @internal Exported for focused schema tests. */
export function parseConfigPackage(value: unknown): ConfigPackage {
  const configPackage = configPackageSchema.parse(value);
  if (
    Buffer.byteLength(JSON.stringify(configPackage), "utf8") >
    configPackageMaxBytes
  ) {
    throw new ApiError(
      413,
      "config_package_too_large",
      "配置包内容不能超过 1 MiB"
    );
  }
  return configPackage;
}

/** @internal Exported for focused preview tests. */
export function previewParsedConfigPackage(value: unknown, existingSlugs: Set<string>) {
  const pkg = parseConfigPackage(value);
  return {
    format: pkg.format,
    format_version: pkg.format_version,
    application_version: pkg.application_version,
    exported_at: pkg.exported_at,
    config_groups: Object.keys(pkg.config).length,
    storage_backends: pkg.storage_backends.map((backend) => ({
      slug: backend.slug,
      display_name: backend.display_name,
      type: backend.type,
      enabled: backend.enabled,
      is_default: backend.is_default
    })),
    conflicts: pkg.storage_backends
      .filter((backend) => existingSlugs.has(backend.slug))
      .map((backend) => backend.slug),
    existing_slugs: [...existingSlugs]
  };
}

const slugMappingsSchema = z.record(z.string(), packageSlug);

/** @internal Exported for focused conflict-resolution tests. */
export function resolveImportedStorageBackends(
  value: unknown,
  existingSlugs: Set<string>,
  slugMappings: Record<string, string>
): ConfigPackageStorageBackend[] {
  const pkg = parseConfigPackage(value);
  const mappings = slugMappingsSchema.parse(slugMappings);
  const importedSlugs = new Set(pkg.storage_backends.map((backend) => backend.slug));
  const conflicts = new Set(
    pkg.storage_backends.filter((backend) => existingSlugs.has(backend.slug)).map((backend) => backend.slug)
  );

  for (const sourceSlug of Object.keys(mappings)) {
    if (!importedSlugs.has(sourceSlug) || !conflicts.has(sourceSlug)) {
      throw new ApiError(400, "config_slug_mapping_unexpected", `无需重命名的 slug: ${sourceSlug}`);
    }
  }

  const targets = new Set<string>();
  return pkg.storage_backends.map((backend) => {
    const conflicting = conflicts.has(backend.slug);
    const targetSlug = conflicting ? mappings[backend.slug] : backend.slug;
    if (!targetSlug) {
      throw new ApiError(
        409,
        "config_storage_slug_conflict",
        `存储后端 slug 冲突，请重命名: ${backend.slug}`,
        { conflicts: [...conflicts] }
      );
    }
    if (existingSlugs.has(targetSlug)) {
      throw new ApiError(409, "config_storage_slug_conflict", `存储后端 slug 已存在: ${targetSlug}`);
    }
    if (targets.has(targetSlug)) {
      throw new ApiError(400, "config_storage_slug_duplicate", `导入后的存储 slug 重复: ${targetSlug}`);
    }
    targets.add(targetSlug);
    return { ...backend, slug: targetSlug };
  });
}

export async function createConfigPackage() {
  return buildConfigPackage(
    getRuntimeConfig(),
    await listStorageBackends(),
    applicationVersion()
  );
}

export async function previewConfigPackage(value: unknown) {
  const existingSlugs = new Set((await listStorageBackends()).map((backend) => backend.slug));
  return previewParsedConfigPackage(value, existingSlugs);
}

export async function importConfigPackage(value: unknown, slugMappings: Record<string, string>) {
  return withRuntimeConfigWriteLease(() => withAdvisoryLock(
    advancedConfigWriteLockKey,
    async (signal, lockClient) => {
      signal.throwIfAborted();
      const pkg = parseConfigPackage(value);
      const existingSlugs = new Set((await listStorageBackends()).map((backend) => backend.slug));
      signal.throwIfAborted();
      const resolved = resolveImportedStorageBackends(pkg, existingSlugs, slugMappings);
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
            throw new AggregateError([error, restoreError], "导入失败，且无法恢复原运行时配置");
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
