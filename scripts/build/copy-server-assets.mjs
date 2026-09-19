import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  compressStaticAsset,
  staticAssetCompression,
  staticAssetIsCompressible
} from "./static-asset-compression.mjs";

const repo = resolve(import.meta.dirname, "..", "..");
const serverPackage = resolve(repo, "packages", "server");
const serverDist = resolve(serverPackage, "dist");
const webDist = resolve(repo, "packages", "web", "dist");
const serverPublic = resolve(serverDist, "public");

for (const [label, input] of [
  ["server compilation", serverDist],
  ["web build", webDist]
]) {
  if (!existsSync(input)) {
    throw new Error(`assemble-server: missing ${label} input at ${relative(repo, input)}`);
  }
}

const compressedAssets = [];

// One source file at a time bounds high-quality compressors' concurrent memory.
// Only final public assets are compressed; the root SPA template is rendered dynamically.
async function precompressDir(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await precompressDir(full);
      continue;
    }
    const file = relative(serverPublic, full).replaceAll("\\", "/");
    if (file === "index.html" || !staticAssetIsCompressible(entry.name)) continue;
    const buffer = await readFile(full);
    const compressed = await compressStaticAsset(entry.name, buffer);
    await Promise.all([
      compressed.brotli
        ? writeFile(`${full}.br`, compressed.brotli)
        : rm(`${full}.br`, { force: true }),
      compressed.zstd
        ? writeFile(`${full}.zst`, compressed.zstd)
        : rm(`${full}.zst`, { force: true }),
      compressed.gzip
        ? writeFile(`${full}.gz`, compressed.gzip)
        : rm(`${full}.gz`, { force: true })
    ]);
    const { brotli, zstd, gzip, ...sizes } = compressed;
    compressedAssets.push({ file, ...sizes });
  }
}

await mkdir(serverDist, { recursive: true });
await cp(resolve(serverPackage, "schema.sql"), resolve(serverDist, "schema.sql"));
await rm(serverPublic, { recursive: true, force: true });
await cp(webDist, serverPublic, {
  recursive: true,
  filter(source) {
    const path = relative(webDist, source).replaceAll("\\", "/");
    return path !== ".vite" && !path.startsWith(".vite/")
      && !/^index\.html\.(?:br|zst|gz)$/.test(path);
  }
});
if (existsSync(resolve(serverPublic, ".vite"))) {
  throw new Error("assemble-server: build-only Web metadata reached public assets");
}

// 最后一步：对最终汇集的 SPA 静态目录做预压缩。图标以内联 JS 资源交付。
await precompressDir(serverPublic);

// Build-only metadata describes the buffers actually written above. Consumers
// can join it with the Vite graph without recompressing every JS/Worker/CSS file.
await mkdir(resolve(webDist, ".vite"), { recursive: true });
await writeFile(resolve(webDist, ".vite/static-compression-report.json"), JSON.stringify({
  schemaVersion: 1,
  policy: {
    brotliQuality: staticAssetCompression.brotliQuality,
    zstdLevel: staticAssetCompression.zstdLevel,
    zstdWindowLog: staticAssetCompression.zstdWindowLog,
    gzipLevel: staticAssetCompression.gzipLevel,
    fileConcurrency: 1,
    selection: "smaller-body-only",
    defaultEncodingOrder: ["br", "zstd", "gzip", "identity"]
  },
  assets: compressedAssets.sort((left, right) => left.file.localeCompare(right.file))
}, null, 2) + "\n");

console.log(
  "assemble-server: schema.sql -> dist, web -> dist/public; "
  + `precompressed br${staticAssetCompression.brotliQuality}/`
  + `zstd${staticAssetCompression.zstdLevel}/gzip${staticAssetCompression.gzipLevel}; `
  + "smaller-body-only; root SPA template rendered dynamically"
);
