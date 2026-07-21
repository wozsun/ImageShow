import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const serverPackage = resolve(repo, "packages", "server");
const serverDist = resolve(serverPackage, "dist");
const webDist = resolve(repo, "packages", "web", "dist");
const docsDist = resolve(repo, "packages", "docs", ".vitepress", "dist");

for (const [label, input] of [
  ["server compilation", serverDist],
  ["web build", webDist],
  ["documentation build", docsDist]
]) {
  if (!existsSync(input)) {
    throw new Error(`assemble-server: missing ${label} input at ${relative(repo, input)}`);
  }
}

function importPath(fromFile, targetFile) {
  const path = relative(dirname(fromFile), targetFile).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

async function rewriteWorkspaceImports(root) {
  const sharedEntry = resolve(repo, "packages", "shared", "dist", "app-config.js");

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const source = await readFile(fullPath, "utf8");
        const rewritten = source.replace(/(["'])@imageshow\/shared\1/g, (_match, quote) => `${quote}${importPath(fullPath, sharedEntry)}${quote}`);
        if (rewritten !== source) await writeFile(fullPath, rewritten);
      }
    }
  }

  await walk(root);
}

// 可预压缩的文本类资源；图片/字体等已是压缩格式，不重复压缩。
const PRECOMPRESS_RE = /\.(?:js|css|html|svg|json|xml|txt|webmanifest)$/;
// 更小的文件压缩收益甚微、还会多出两个文件，直接跳过。
const PRECOMPRESS_MIN_BYTES = 256;

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
    if (!PRECOMPRESS_RE.test(entry.name) || /\.(?:br|gz)$/.test(entry.name)) continue;
    const buffer = await readFile(full);
    if (buffer.length < PRECOMPRESS_MIN_BYTES) continue;
    const [brotli, gzipped] = await Promise.all([
      brotliAsync(buffer, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buffer.length
        }
      }),
      gzipAsync(buffer, { level: 9 })
    ]);
    // 只在确实更小时才落盘（极小或已压缩的内容压缩后可能反而更大）。
    await Promise.all([
      brotli.length < buffer.length ? writeFile(`${full}.br`, brotli) : null,
      gzipped.length < buffer.length ? writeFile(`${full}.gz`, gzipped) : null
    ]);
  }
}

await mkdir(serverDist, { recursive: true });
await rewriteWorkspaceImports(serverDist);
await rm(resolve(serverDist, "migrations"), { recursive: true, force: true });
await rm(resolve(serverDist, "public"), { recursive: true, force: true });
await rm(resolve(serverDist, "docs"), { recursive: true, force: true });
await cp(
  resolve(serverPackage, "migrations"),
  resolve(serverDist, "migrations"),
  { recursive: true }
);
await cp(webDist, resolve(serverDist, "public"), { recursive: true });
await cp(docsDist, resolve(serverDist, "docs"), { recursive: true });

// 最后一步：对最终汇集的静态目录做预压缩（public 含 SPA 资源；docs 为文档站。图标已内联进
// JS 包，不再作为 /assets/icons 静态文件单独发布）。
await precompressDir(resolve(serverDist, "public"));
const docsOut = resolve(serverDist, "docs");
if (existsSync(docsOut)) await precompressDir(docsOut);

console.log(
  "assemble-server: migrations -> dist/migrations, web -> dist/public, docs -> dist/docs"
);
