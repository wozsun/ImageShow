import { z } from "zod";
import { appConfig } from "@imageshow/shared";
import {
  type AdvancedConfigPreviewDto,
  slugMaxLength,
  slugPattern,
  type RuntimeConfig
} from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import {
  s3SettingsSchema,
  type StorageBackendRecord
} from "../storage/backends/config.ts";
import {
  portableRuntimeConfigSchema,
  type PortableRuntimeConfig
} from "./runtime-config.ts";

const configPackageFormat = "imageshow-config" as const;
const configPackageMaxBackends = appConfig.ingestion.configPackageMaxBackends;
const configPackageMaxBytes = appConfig.ingestion.configPackageMaxBytes;

const packageSlug = z.string().trim().toLowerCase().min(1).max(slugMaxLength)
  .regex(slugPattern)
  .refine((slug) => slug !== "local", "local is not importable");
const packageDisplayName = z.string().trim().max(64);
const packageBackendBase = {
  slug: packageSlug,
  display_name: packageDisplayName,
  enabled: z.boolean(),
  is_default: z.boolean()
};
const packageStorageBackendSchema = z.strictObject({
  ...packageBackendBase,
  s3: s3SettingsSchema
});

const configPackageSchema = z.strictObject({
  format: z.literal(configPackageFormat),
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

type ConfigPackage = z.infer<typeof configPackageSchema>;
type ConfigPackageStorageBackend = ConfigPackage["storage_backends"][number];

function portableConfig(runtime: RuntimeConfig): PortableRuntimeConfig {
  const { domain: _domain, ...portableSite } = runtime.site;
  return portableRuntimeConfigSchema.parse({ ...runtime, site: portableSite });
}

function portableBackends(
  backends: StorageBackendRecord[]
): ConfigPackageStorageBackend[] {
  const portable: ConfigPackageStorageBackend[] = [];
  for (const backend of backends) {
    if (backend.type === "local") continue;
    const base = {
      slug: backend.slug,
      display_name: backend.display_name,
      enabled: backend.enabled,
      is_default: backend.is_default
    };
    portable.push({ ...base, s3: backend.s3 });
  }
  return portable;
}

export function buildConfigPackage(
  runtime: RuntimeConfig,
  backends: StorageBackendRecord[],
  applicationVersion: string,
  exportedAt = new Date()
): ConfigPackage {
  return parseConfigPackage({
    format: configPackageFormat,
    application_version: applicationVersion,
    exported_at: exportedAt.toISOString(),
    config: portableConfig(runtime),
    storage_backends: portableBackends(backends)
  });
}

export function parseConfigPackage(value: unknown): ConfigPackage {
  const configPackage = configPackageSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(configPackage), "utf8") > configPackageMaxBytes) {
    throw new ApiError(
      413,
      "config_package_too_large",
      "配置包内容不能超过 1 MiB"
    );
  }
  return configPackage;
}

export function projectConfigPackagePreview(
  pkg: ConfigPackage,
  existingSlugs: Set<string>
): AdvancedConfigPreviewDto {
  return {
    format: pkg.format,
    application_version: pkg.application_version,
    exported_at: pkg.exported_at,
    config_groups: Object.keys(pkg.config).length,
    storage_backends: pkg.storage_backends.map((backend) => ({
      slug: backend.slug,
      display_name: backend.display_name,
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

export function resolveImportedStorageBackends(
  pkg: ConfigPackage,
  existingSlugs: Set<string>,
  inputMappings: unknown
): ConfigPackageStorageBackend[] {
  const mappings = slugMappingsSchema.parse(inputMappings);
  const importedSlugs = new Set(pkg.storage_backends.map((backend) => backend.slug));
  const conflicts = new Set(
    pkg.storage_backends
      .filter((backend) => existingSlugs.has(backend.slug))
      .map((backend) => backend.slug)
  );

  for (const sourceSlug of Object.keys(mappings)) {
    if (!importedSlugs.has(sourceSlug) || !conflicts.has(sourceSlug)) {
      throw new ApiError(
        400,
        "config_slug_mapping_unexpected",
        `无需重命名的 slug: ${sourceSlug}`
      );
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
      throw new ApiError(
        409,
        "config_storage_slug_conflict",
        `存储后端 slug 已存在: ${targetSlug}`
      );
    }
    if (targets.has(targetSlug)) {
      throw new ApiError(
        400,
        "config_storage_slug_duplicate",
        `导入后的存储 slug 重复: ${targetSlug}`
      );
    }
    targets.add(targetSlug);
    return { ...backend, slug: targetSlug };
  });
}
