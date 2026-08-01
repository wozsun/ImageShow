import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const webDist = resolve(workspaceRoot, "packages/web/dist");
const assetRoot = resolve(webDist, "assets");
const assetNames = await readdir(assetRoot);
const assetNameSet = new Set(assetNames);

function singleAsset(prefix) {
  const matches = assetNames.filter((name) => (
    name.startsWith(`${prefix}-`) && name.endsWith(".js")
  ));
  if (matches.length !== 1) {
    throw new Error(
      `check-web-chunks: expected one ${prefix} JavaScript asset, found ${matches.length}`
    );
  }
  return matches[0];
}

const adminFoundationAsset = singleAsset("admin-foundation");
const sourceCache = new Map();

async function assetSource(assetName) {
  const cached = sourceCache.get(assetName);
  if (cached !== undefined) return cached;
  const source = await readFile(resolve(assetRoot, assetName), "utf8");
  sourceCache.set(assetName, source);
  return source;
}

function staticJavaScriptDependencies(source) {
  const dependencies = new Set();
  const patterns = [
    /\bfrom\s*["']\.\/([^"']+\.js)["']/g,
    /(?:^|;)\s*import\s*["']\.\/([^"']+\.js)["']/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) dependencies.add(match[1]);
  }
  return [...dependencies];
}

async function assertAdminFoundationUnreachable(entryAsset, label) {
  const pending = [{ assetName: entryAsset, chain: [entryAsset] }];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (!current || visited.has(current.assetName)) continue;
    visited.add(current.assetName);
    for (const dependency of staticJavaScriptDependencies(
      await assetSource(current.assetName)
    )) {
      if (!assetNameSet.has(dependency)) {
        throw new Error(
          `check-web-chunks: ${current.assetName} imports missing asset ${dependency}`
        );
      }
      const chain = [...current.chain, dependency];
      if (dependency === adminFoundationAsset) {
        throw new Error(
          `check-web-chunks: ${label} reaches admin-foundation through ${chain.join(" -> ")}`
        );
      }
      pending.push({ assetName: dependency, chain });
    }
  }
}

const indexHtml = await readFile(resolve(webDist, "index.html"), "utf8");
if (/modulepreload[^>]+admin-foundation-/.test(indexHtml)) {
  throw new Error("check-web-chunks: public HTML preloads admin-foundation");
}

await Promise.all([
  assertAdminFoundationUnreachable(singleAsset("index"), "public entry"),
  assertAdminFoundationUnreachable(singleAsset("HomePage"), "HomePage"),
  assertAdminFoundationUnreachable(singleAsset("GalleryPage"), "GalleryPage")
]);

const tinyJavaScriptAssets = [];
for (const assetName of assetNames.filter((name) => name.endsWith(".js"))) {
  const size = (await stat(resolve(assetRoot, assetName))).size;
  if (size < 1024) tinyJavaScriptAssets.push({ assetName, size });
}
if (tinyJavaScriptAssets.length > 1) {
  throw new Error(
    `check-web-chunks: review multiple JavaScript assets below 1 KiB: ${JSON.stringify(tinyJavaScriptAssets)}`
  );
}
const [runtimeAsset] = tinyJavaScriptAssets;
if (runtimeAsset) {
  const runtimeSource = await readFile(
    resolve(assetRoot, runtimeAsset.assetName),
    "utf8"
  );
  if (
    !runtimeSource.includes("Object.create")
    || !runtimeSource.includes("export{")
    || /from["']\.\//.test(runtimeSource)
  ) {
    throw new Error(
      `check-web-chunks: review unexpected sub-kilobyte application chunk ${runtimeAsset.assetName}`
    );
  }
}

console.log(
  runtimeAsset
    ? `check-web-chunks: public routes exclude admin-foundation; only ${runtimeAsset.assetName} (${runtimeAsset.size} B) is below 1 KiB`
    : "check-web-chunks: public routes exclude admin-foundation; no JavaScript asset is below 1 KiB"
);
