import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appConfig } from "../shared/src/app-config.ts";
import { createChunkPlan, publishedChunkName } from "./vite-chunk-plan.ts";

function webSourcePath(id: string | null) {
  if (!id) return null;
  const normalized = id.replaceAll("\\", "/");
  const marker = "/packages/web/";
  const markerIndex = normalized.lastIndexOf(marker);
  return markerIndex < 0
    ? null
    : normalized.slice(markerIndex + marker.length);
}

function modulePath(id: string) {
  const normalized = id.replaceAll("\\", "/");
  const dependency = normalized.lastIndexOf("/node_modules/");
  if (dependency >= 0) return normalized.slice(dependency + 1);
  return webSourcePath(id);
}

const chunkPlan = createChunkPlan({
  rootName: (root) =>
    webSourcePath(root)?.endsWith("index.html")
      ? "app"
      : root.replaceAll("\\", "/").split("/").at(-1)!.replace(/\.[^.]+$/, "")
});

function javascriptAssetPattern(name: string) {
  return `assets/${publishedChunkName(name)}-[hash].js`;
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
  return `assets/${publishedChunkName(baseName)}-[hash]${extension}`;
}

function webBuildReport(): Plugin {
  return {
    name: "imageshow-web-build-report",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).flatMap((output) => {
        if (output.type !== "chunk") return [];
        const metadata = output as typeof output & {
          viteMetadata?: { importedCss?: Set<string> };
        };
        const moduleIds = Object.keys(output.modules);
        return [
          {
            file: output.fileName,
            name: output.name,
            isEntry: output.isEntry,
            imports: output.imports,
            dynamicImports: output.dynamicImports,
            css: [...(metadata.viteMetadata?.importedCss ?? [])],
            emitted: output.code.length > 0,
            modules: moduleIds
              .map(webSourcePath)
              .filter((path): path is string => path !== null),
            // Lazy roots (the entry or dynamic import targets) this chunk holds.
            rootModules: moduleIds
              .filter((id) => {
                const info = this.getModuleInfo(id);
                return Boolean(info && (info.isEntry || info.dynamicImporters.length > 0));
              })
              .map(modulePath)
              .filter((path): path is string => path !== null)
              .sort()
          }
        ];
      });
      this.emitFile({
        type: "asset",
        fileName: ".vite/web-build-report.json",
        source: JSON.stringify({ chunks }, null, 2)
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
    } catch {}
  }
  if (process.env.SITE_DOMAIN) {
    return `http://${process.env.SITE_DOMAIN.replace(/:\d+$/, "")}:${appConfig.applicationPort}`;
  }
  return `http://localhost:${appConfig.applicationPort}`;
}

const target = resolveProxyTarget();

export default defineConfig({
  // Relative imports let one immutable build run behind any configured asset URL.
  base: "./",
  plugins: [react(), ...chunkPlan.plugins, webBuildReport()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The show page carries its renderer; chunk sizes follow the plan above.
    chunkSizeWarningLimit: 1024,
    // Chunks import each other by stable names mapped to the current files in
    // the document, so a release changes only the files whose content changed.
    chunkImportMap: true,
    rolldownOptions: {
      // The chunk plan spends seconds weighing merges on purpose.
      checks: { bundlerTimings: false },
      output: {
        // 懒加载根的块用根的文件名，共用块为 common（访客也会加载）或 shared（只有管理员加载），
        // 内容哈希区分同名文件并负责缓存失效。
        entryFileNames: ({ name }) => javascriptAssetPattern(name),
        chunkFileNames: ({ name }) => javascriptAssetPattern(name),
        assetFileNames: ({ names }) => staticAssetPattern(names),

        codeSplitting: {
          groups: [
            {
              name: (id) => chunkPlan.chunkOf(id),
              debugName: "chunk-plan",
              priority: 1,
              includeDependenciesRecursively: false
            }
          ]
        }
      }
    }
  },
  worker: {
    rolldownOptions: {
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
      "/random": target,
      // Trailing slash keeps the built-in /assets/ files on the Vite dev server.
      "/asset/": target,
      "/favicon.ico": target
    }
  }
});
