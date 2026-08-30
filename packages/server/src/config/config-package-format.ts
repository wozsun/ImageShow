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
  looseS3SettingsSchema,
  s3SettingsSchema,
  type StorageBackendRecord
} from "../storage/backends/config.ts";
import {
  parseRuntimeConfig,
  portableRuntimeConfigSchema,
  projectPortableRuntimeConfig,
  type PortableRuntimeConfig
} from "./runtime-config.ts";

const configPackageFormat = "imageshow-config" as const;
const configPackageMaxBackends = appConfig.configPackage.maxStorageBackends;
const configPackageMaxBytes = appConfig.configPackage.maxBytes;

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
const exportedStorageBackendSchema = z.strictObject({
  ...packageBackendBase,
  s3: s3SettingsSchema
});
const recognizableStorageBackendSchema = z.object({
  ...packageBackendBase,
  s3: looseS3SettingsSchema
});

const exportedConfigPackageSchema = z.strictObject({
  format: z.literal(configPackageFormat),
  application_version: z.string().trim().min(1).max(64),
  exported_at: z.iso.datetime(),
  config: portableRuntimeConfigSchema,
  storage_backends: z.array(exportedStorageBackendSchema)
    .max(configPackageMaxBackends)
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

type ExportedConfigPackage = z.infer<typeof exportedConfigPackageSchema>;
type ConfigPackageStorageBackend = z.infer<typeof recognizableStorageBackendSchema>;

type ConfigPackage = {
  format: string | null;
  application_version: string | null;
  exported_at: string | null;
  config: PortableRuntimeConfig;
  config_values: {
    recognized: number;
    defaulted: number;
    ignored: number;
  };
  storage_backends: ConfigPackageStorageBackend[];
  skipped_storage_backends: number;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializedConfigPackage(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ApiError(
      400,
      "config_package_invalid",
      "配置包必须是可解析的 JSON"
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > configPackageMaxBytes) {
    throw new ApiError(
      413,
      "config_package_too_large",
      "配置包内容不能超过 1 MiB"
    );
  }
  return serialized;
}

function portableConfig(runtime: RuntimeConfig): PortableRuntimeConfig {
  const { domain: _domain, ...portableSite } = runtime.site;
  return portableRuntimeConfigSchema.parse({ ...runtime, site: portableSite });
}

function portableBackends(
  backends: StorageBackendRecord[]
): ExportedConfigPackage["storage_backends"] {
  const portable: ExportedConfigPackage["storage_backends"] = [];
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

function recognizeStorageBackends(values: unknown[]) {
  const storageBackends: ConfigPackageStorageBackend[] = [];
  const slugs = new Set<string>();
  let hasDefault = false;
  let skipped = 0;

  for (const value of values) {
    const result = recognizableStorageBackendSchema.safeParse(value);
    if (!result.success) {
      skipped += 1;
      continue;
    }
    const backend = result.data;
    if (
      slugs.has(backend.slug)
      || (backend.is_default && (!backend.enabled || hasDefault))
    ) {
      skipped += 1;
      continue;
    }
    slugs.add(backend.slug);
    if (backend.is_default) hasDefault = true;
    storageBackends.push(backend);
  }

  return { storageBackends, skipped };
}

function sourceText(value: unknown) {
  const result = z.string().trim().min(1).max(64).safeParse(value);
  return result.success ? result.data : null;
}

function sourceExportedAt(value: unknown) {
  const result = z.iso.datetime().safeParse(value);
  return result.success ? result.data : null;
}

export function buildConfigPackage(
  runtime: RuntimeConfig,
  backends: StorageBackendRecord[],
  applicationVersion: string,
  exportedAt = new Date()
): ExportedConfigPackage {
  const pkg = exportedConfigPackageSchema.parse({
    format: configPackageFormat,
    application_version: applicationVersion,
    exported_at: exportedAt.toISOString(),
    config: portableConfig(runtime),
    storage_backends: portableBackends(backends)
  });
  serializedConfigPackage(pkg);
  return pkg;
}

export function parseConfigPackage(value: unknown): ConfigPackage {
  serializedConfigPackage(value);
  if (!isPlainRecord(value)) {
    throw new ApiError(
      400,
      "config_package_invalid",
      "配置包根节点必须是 JSON 对象"
    );
  }
  const record = value;
  const rawStorageBackends = Array.isArray(record.storage_backends)
    ? record.storage_backends
    : [];
  if (rawStorageBackends.length > configPackageMaxBackends) {
    throw new ApiError(
      400,
      "config_package_invalid",
      `配置包最多包含 ${configPackageMaxBackends} 个存储后端`
    );
  }

  const config = projectPortableRuntimeConfig(record.config);
  const storage = recognizeStorageBackends(rawStorageBackends);
  return {
    format: sourceText(record.format),
    application_version: sourceText(record.application_version),
    exported_at: sourceExportedAt(record.exported_at),
    config: config.config,
    config_values: {
      recognized: config.recognizedValues,
      defaulted: config.defaultedValues,
      ignored: config.ignoredValues
    },
    storage_backends: storage.storageBackends,
    skipped_storage_backends: storage.skipped
  };
}

export function materializeImportedRuntimeConfig(
  portable: PortableRuntimeConfig,
  targetDomain: string
): RuntimeConfig {
  return parseRuntimeConfig({
    ...portable,
    site: {
      ...portable.site,
      domain: targetDomain
    }
  });
}

export function projectConfigPackagePreview(
  pkg: ConfigPackage,
  existingSlugs: Set<string>
): AdvancedConfigPreviewDto {
  return {
    format: pkg.format,
    application_version: pkg.application_version,
    exported_at: pkg.exported_at,
    config_values: pkg.config_values,
    storage_backends: pkg.storage_backends.map((backend) => ({
      slug: backend.slug,
      display_name: backend.display_name,
      enabled: backend.enabled,
      is_default: backend.is_default
    })),
    skipped_storage_backends: pkg.skipped_storage_backends,
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
  const mappingResult = slugMappingsSchema.safeParse(inputMappings);
  if (!mappingResult.success) {
    throw new ApiError(
      400,
      "config_slug_mapping_invalid",
      "存储后端 slug 重命名无效",
      mappingResult.error.flatten()
    );
  }
  const mappings = mappingResult.data;
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
