import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appConfig } from "../shared/src/app-config.ts";

function webSourcePath(id: string | null) {
  if (!id) return null;
  const normalized = id.replaceAll("\\", "/");
  const marker = "/packages/web/";
  const markerIndex = normalized.lastIndexOf(marker);
  return markerIndex < 0
    ? null
    : normalized.slice(markerIndex + marker.length);
}

type ChunkingContext = {
  getModuleInfo(id: string): {
    dynamicImporters: string[];
    importers: string[];
    isEntry: boolean;
  } | null;
};

function entryRootIds(moduleId: string, context: ChunkingContext) {
  const roots = new Set<string>();
  const visited = new Set<string>();
  const pending = [moduleId];
  while (pending.length) {
    const id = pending.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    const info = context.getModuleInfo(id);
    if (!info) continue;
    if (info.isEntry || info.dynamicImporters.length > 0) {
      roots.add(id.replaceAll("\\", "/"));
    }
    if (!info.isEntry) pending.push(...info.importers);
  }
  return [...roots].sort();
}

function semanticOwnerLabel(root: string) {
  const sourcePath = webSourcePath(root) ?? root.replaceAll("\\", "/");
  if (sourcePath.endsWith("index.html")) return "app";
  const baseName = sourcePath.split("/").at(-1)
    ?.replace(/\.[^.]+$/, "")
    ?? "asset";
  let label = baseName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-(?:page|capability)$/i, "")
    .replace(/^(?:web|assets?)-|-(?:js|css|chunks?|modules?)$/gi, "")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  if (sourcePath.startsWith("src/pages/admin/")) {
    label = label
      .split("-")
      .filter((token) => token !== "admin")
      .join("-")
      .replace(/-settings$/, "");
  }
  return label || "asset";
}

function semanticOwnerCategory(root: string) {
  const sourcePath = webSourcePath(root) ?? root.replaceAll("\\", "/");
  if (sourcePath.endsWith("index.html")) return "app";
  const segments = sourcePath.split("/");
  if (segments[0] === "src" && segments.length > 2) {
    if (["pages", "components", "lib"].includes(segments[1]!)) {
      return segments[2]!
        .replace(/[^A-Za-z0-9]+/g, "-")
        .toLowerCase();
    }
  }
  return semanticOwnerLabel(root);
}

const chunkResponsibilityAliases: Readonly<Record<string, string>> = {
  "route-authenticated-shell-gallery-image": "async-ui",
  "route-authenticated-shell-image": "workspace-ui",
  "route-gallery-home": "public-ui",
  "route-gallery-image": "image-ui",
  "route-gallery": "image-view",
  "route-image": "image-actions",
  "route-login": "password-input",
  "capability-account-user": "password",
  "capability-admin": "workspace-header",
  "capability-check-check-maintenance-overview": "cache-status",
  "capability-check-maintenance-storage": "storage-move-api",
  "capability-image-editor-import-source-dialog-uploader": "upload-utils",
  "capability-image-editor-uploader": "image-fields",
  "capability-settings-storage": "number-input",
  "capability-storage-vocabulary": "reorder",
  "capability-user-vocabulary": "slug-chip"
};

const semanticChunkNameAssignments = new Map<
  string,
  Map<string, string>
>();

function rootSetChunkName(prefix: string, roots: string[]) {
  const normalizedRoots = [...new Set(
    roots.map((root) => root.replaceAll("\\", "/"))
  )].sort();
  const exactLabels = [...new Set(
    normalizedRoots.map(semanticOwnerLabel)
  )].sort();
  const ownerLabels = exactLabels.length <= 3
    ? exactLabels
    : [...new Set(normalizedRoots.map(semanticOwnerCategory))].sort();
  const generatedName = `${prefix}-${ownerLabels.join("-") || "shared"}`;
  const baseName = chunkResponsibilityAliases[generatedName] ?? generatedName;
  const rootKey = normalizedRoots.join("\n");
  let assignments = semanticChunkNameAssignments.get(baseName);
  if (!assignments) {
    assignments = new Map();
    semanticChunkNameAssignments.set(baseName, assignments);
  }
  const existing = assignments.get(rootKey);
  if (existing) return existing;
  const assignedNames = new Set(assignments.values());
  let name = baseName;
  if (assignedNames.has(name)) {
    name = `${baseName}-${createHash("sha256")
      .update(rootKey)
      .digest("hex")
      .slice(0, 6)}`;
  }
  assignments.set(rootKey, name);
  return name;
}

function sharedChunkName(moduleId: string, context: ChunkingContext) {
  const roots = entryRootIds(moduleId, context);
  const home = roots.some((id) => /\/src\/pages\/home\//.test(id));
  const gallery = roots.some((id) => /\/src\/pages\/gallery\//.test(id));
  const hasNonPublicRoot = roots.some((id) => (
    !/\/src\/pages\/(?:home|gallery)\//.test(id)
  ));
  if (
    roots.some((id) => id.endsWith("/index.html"))
    || (home && gallery && hasNonPublicRoot)
  ) {
    return "app-foundation";
  }
  const initialRouteRoots = roots.filter((id) => (
    /\/src\/pages\/(?:home|gallery)\//.test(id)
    || /\/src\/pages\/admin\/(?:AdminShell|AdminLogin|LoginChallenge|AuthenticatedAdminShell|ImageAdmin)\.tsx$/.test(id)
  ));
  return initialRouteRoots.length > 0
    ? rootSetChunkName("route", initialRouteRoots)
    : rootSetChunkName("capability", roots);
}

const conciseAssetNames: Readonly<Record<string, string>> = {
  index: "app",
  AccountSettings: "account",
  AdminLogin: "login",
  AdminShell: "access-shell",
  AdvancedConfigPage: "config",
  AuthenticatedAdminShell: "workspace-shell",
  CheckMaintenanceCapability: "maintenance",
  CheckPage: "check",
  GalleryPage: "gallery",
  HomePage: "home",
  ImageAdmin: "images",
  ImageAdminDetails: "image-details",
  ImageStorageMigrationDialog: "image-move",
  ImportSourceDialog: "import-source",
  LoginChallenge: "login-challenge",
  LogPage: "logs",
  Overview: "overview",
  ReadyImageCachePanel: "cache-panel",
  SettingsPage: "settings",
  StorageBackendMigrationDialog: "storage-move",
  StorageSettings: "storage",
  Uploader: "upload",
  UserAdmin: "users",
  VocabularyAdmin: "vocabulary",
  "image-editor-capability": "image-editor"
};

function conciseAssetName(name: string) {
  return conciseAssetNames[name] ?? name;
}

function javascriptAssetPattern(name: string) {
  return `assets/${conciseAssetName(name)}-[hash].js`;
}

function staticAssetPattern(names: string[]) {
  const originalName = names[0] ?? "asset";
  const extensionIndex = originalName.lastIndexOf(".");
  const extension = extensionIndex >= 0
    ? originalName.slice(extensionIndex)
    : "";
  const baseName = extensionIndex >= 0
    ? originalName.slice(0, extensionIndex)
    : originalName;
  return `assets/${conciseAssetName(baseName)}-[hash]${extension}`;
}

const storageMoveModuleSuffixes = [
  "/src/lib/api/storage-backend-migration.ts",
  "/src/pages/admin/storage/StorageBackendMigrationDialog.tsx"
];

function isStorageMoveModule(id: string) {
  const normalized = id.replaceAll("\\", "/");
  return storageMoveModuleSuffixes.some((suffix) => (
    normalized.endsWith(suffix)
  ));
}

function webBuildReport(): Plugin {
  return {
    name: "imageshow-web-build-report",
    generateBundle(_options, bundle) {
      const collectedChunks = Object.values(bundle).flatMap((output) => {
        if (output.type !== "chunk") return [];
        const metadata = output as typeof output & {
          viteMetadata?: { importedCss?: Set<string> };
        };
        const moduleIds = Object.keys(output.modules);
        const modules = moduleIds
          .map(webSourcePath)
          .filter((path): path is string => path !== null);
        const moduleRoots = Object.fromEntries(moduleIds.flatMap((id) => {
          const path = webSourcePath(id);
          if (!path) return [];
          const roots = entryRootIds(id, this)
            .map(webSourcePath)
            .filter((root): root is string => root !== null);
          return [[path, roots]];
        }));
        return [{
          file: output.fileName,
          name: output.name,
          facade: webSourcePath(output.facadeModuleId),
          isEntry: output.isEntry,
          isDynamicEntry: output.isDynamicEntry,
          imports: output.imports,
          dynamicImports: output.dynamicImports,
          css: [...(metadata.viteMetadata?.importedCss ?? [])],
          emitted: output.code.length > 0,
          modules,
          moduleRoots
        }];
      });
      const dynamicImporters = new Map<string, string[]>();
      for (const chunk of collectedChunks) {
        for (const target of chunk.dynamicImports) {
          const importers = dynamicImporters.get(target) ?? [];
          importers.push(chunk.file);
          dynamicImporters.set(target, importers);
        }
      }
      const chunks = collectedChunks.map((chunk) => ({
        ...chunk,
        dynamicImporters: [...new Set(
          dynamicImporters.get(chunk.file) ?? []
        )].sort()
      }));
      const styles = [...new Set(chunks.flatMap((chunk) => chunk.css))]
        .sort()
        .map((file) => ({
          file,
          owners: chunks
            .filter((chunk) => chunk.css.includes(file))
            .map((chunk) => ({ file: chunk.file, facade: chunk.facade }))
        }));
      this.emitFile({
        type: "asset",
        fileName: ".vite/web-build-report.json",
        source: JSON.stringify({ chunks, styles }, null, 2)
      });
    }
  };
}

function resolveProxyTarget() {
  const configPath = fileURLToPath(new URL("../../data/config.json", import.meta.url));
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf8")) as { site?: { domain?: string } };
      const domain = config.site?.domain;
      if (domain) return `http://${domain.replace(/:\d+$/, "")}:${appConfig.applicationPort}`;
    } catch {
    }
  }
  if (process.env.SITE_DOMAIN) {
    return `http://${process.env.SITE_DOMAIN.replace(/:\d+$/, "")}:${appConfig.applicationPort}`;
  }
  return `http://localhost:${appConfig.applicationPort}`;
}

const target = resolveProxyTarget();

export default defineConfig({
  plugins: [react(), webBuildReport()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 文件名只表达简短职责；内容哈希独立负责缓存失效。这里不按字符数
        // 截断名称，新增职责通过语义别名自然保持简洁。
        entryFileNames: ({ name }) => javascriptAssetPattern(name),
        chunkFileNames: ({ name }) => javascriptAssetPattern(name),
        assetFileNames: ({ names }) => staticAssetPattern(names),

        codeSplitting: {
          // 页面与能力按实际入口根集合拆分；小块只在实测证明与目标页面必然
          // 同行且完整线路字节下降时显式合并，不把体积阈值当成产物门禁。
          groups: [
            {
              name: "query-vendor",
              test: /[\\/]node_modules[\\/]@tanstack[\\/]/,
              priority: 5
            },
            {
              name: "react-vendor",
              test: /[\\/]node_modules[\\/](?:react-router|react-dom|react|scheduler)[\\/]/,
              priority: 4
            },
            {
              name: "storage-move",
              test: isStorageMoveModule,
              priority: 3,
              minShareCount: 2,
              includeDependenciesRecursively: false
            },
            {
              name: sharedChunkName,
              test: (id) => !id.endsWith(".css") && (
                (
                  /[\\/]packages[\\/]web[\\/]src[\\/]/.test(id)
                  && !/[\\/]packages[\\/]web[\\/]src[\\/]pages[\\/]/.test(id)
                )
                || /[\\/]packages[\\/]shared[\\/]dist[\\/]browser(?:[\\/]|\.js$)/.test(id)
              ),
              priority: 1,
              minShareCount: 2,
              includeDependenciesRecursively: false
            }
          ]
        }
      }
    }
  },
  worker: {
    rollupOptions: {
      output: {
        entryFileNames: ({ name }) => javascriptAssetPattern(name),
        chunkFileNames: ({ name }) => javascriptAssetPattern(name),
        assetFileNames: ({ names }) => staticAssetPattern(names)
      }
    }
  },
  server: {
    proxy: {
      "/api": target,
      "/random": target
    }
  }
});
