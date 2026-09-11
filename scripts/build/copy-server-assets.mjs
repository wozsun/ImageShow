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

// 构建时预压缩：为可压缩资源就地生成 .gz 与 .br（Node 内置 zlib，无新依赖），运行时由
// serveStatic({ precompressed }) 按 Accept-Encoding 协商发送（br > gzip）。br 取最高质量 11、
// gzip 取 9——一次性构建成本换运行时零开销与最优体积。
async function precompressDir(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      await precompressDir(full);
      continue;
    }
    if (!staticAssetIsCompressible(entry.name)) continue;
    const buffer = await readFile(full);
    const compressed = await compressStaticAsset(entry.name, buffer);
    await Promise.all([
      compressed.brotli
        ? writeFile(`${full}.br`, compressed.brotli)
        : null,
      compressed.gzip ? writeFile(`${full}.gz`, compressed.gzip) : null
    ]);
  }
}

await mkdir(serverDist, { recursive: true });
const databaseAssets = ["schema.sql", "schema-additions.sql"];
await Promise.all(databaseAssets.map(async (asset) => {
  await rm(resolve(serverDist, asset), { force: true });
  await cp(resolve(serverPackage, asset), resolve(serverDist, asset));
}));
await rm(serverPublic, { recursive: true, force: true });
await cp(webDist, serverPublic, {
  recursive: true,
  filter(source) {
    const path = relative(webDist, source).replaceAll("\\", "/");
    return path !== ".vite" && !path.startsWith(".vite/");
  }
});
if (existsSync(resolve(serverPublic, ".vite"))) {
  throw new Error("assemble-server: build-only Web metadata reached public assets");
}

// 最后一步：对最终汇集的 SPA 静态目录做预压缩。图标以内联 JS 资源交付。
await precompressDir(serverPublic);

console.log(
  "assemble-server: database SQL assets -> dist, web -> dist/public; "
  + `precompressed br${staticAssetCompression.brotliQuality}/`
  + `gzip${staticAssetCompression.gzipLevel}; smaller-body-only`
);
