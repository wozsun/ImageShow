import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { brotliDecompress, gunzip, zstdDecompress } from "node:zlib";
import { staticAssetCompression } from "../../build/static-asset-compression.mjs";
import { verifyStaticCompression } from "./static-compression-contract.mjs";

await verifyStaticCompression();

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const webDist = resolve(workspaceRoot, "packages/web/dist");
const serverDist = resolve(workspaceRoot, "packages/server/dist");
const serverPublic = resolve(serverDist, "public");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const compressionReport = await readJson(resolve(webDist, ".vite/static-compression-report.json"));
const report = await readJson(resolve(webDist, ".vite/web-build-report.json"));
const documentPreloads = await readJson(resolve(serverDist, "document-preloads.json"));

assert.equal(compressionReport.schemaVersion, 1);
assert.deepEqual(compressionReport.policy, {
  brotliQuality: staticAssetCompression.brotliQuality,
  zstdLevel: staticAssetCompression.zstdLevel,
  zstdWindowLog: staticAssetCompression.zstdWindowLog,
  gzipLevel: staticAssetCompression.gzipLevel,
  fileConcurrency: 1,
  selection: "smaller-body-only",
  defaultEncodingOrder: ["br", "zstd", "gzip", "identity"]
});

// Every precompressed sidecar is smaller than its body, decodes to it, and
// matches the sizes the assembly step recorded.
const decoders = [
  ["br", ".br", "brotliBytes", promisify(brotliDecompress)],
  ["zstd", ".zst", "zstdBytes", promisify(zstdDecompress)],
  ["gzip", ".gz", "gzipBytes", promisify(gunzip)]
];
for (const row of compressionReport.assets) {
  const source = await readFile(resolve(webDist, row.file));
  assert.deepEqual(await readFile(resolve(serverPublic, row.file)), source, `assembled body: ${row.file}`);
  const sizes = { rawBytes: source.length };
  let defaultEncoding = "identity";
  let defaultBytes = source.length;
  for (const [encoding, suffix, field, decode] of decoders) {
    let body = null;
    try {
      body = await readFile(resolve(serverPublic, row.file + suffix));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    sizes[field] = body?.length ?? source.length;
    if (!body) continue;
    assert.ok(body.length < source.length, `sidecar must save bytes: ${row.file}${suffix}`);
    assert.deepEqual(await decode(body), source, `roundtrip: ${row.file}${suffix}`);
    if (defaultEncoding === "identity") {
      defaultEncoding = encoding;
      defaultBytes = body.length;
    }
  }
  sizes.effectiveBytes = Math.min(...Object.values(sizes));
  assert.deepEqual(row, { file: row.file, ...sizes, defaultEncoding, defaultBytes }, `metadata: ${row.file}`);
}

// The build report describes the files that were written.
const chunks = report.chunks;
const chunkByFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
assert.equal(chunkByFile.size, chunks.length, "duplicate JavaScript output name");
for (const chunk of chunks) {
  for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
    assert.ok(chunkByFile.has(dependency), `${chunk.file} references missing chunk ${dependency}`);
  }
  for (const file of [...(chunk.emitted ? [chunk.file] : []), ...chunk.css]) {
    await stat(resolve(webDist, file));
    assert.match(file, /-[A-Za-z0-9_-]{6,}\.(?:css|js)$/, `asset lacks a content hash: ${file}`);
  }
}

// Chunks import each other one way only: in a cycle one chunk's code can run
// before a binding it reads from the other is initialized.
const importOrder = new Map();
const visitImports = (file, path) => {
  if (importOrder.get(file) === "done") return;
  assert.notEqual(importOrder.get(file), "visiting", `chunk import cycle: ${[...path, file].join(" -> ")}`);
  importOrder.set(file, "visiting");
  for (const dependency of chunkByFile.get(file).imports) visitImports(dependency, [...path, file]);
  importOrder.set(file, "done");
};
for (const chunk of chunks) visitImports(chunk.file, []);

// No two emitted assets carry the same content.
const assetFiles = (await readdir(resolve(webDist, "assets")))
  .filter((file) => /\.(?:js|css)$/.test(file))
  .map((file) => `assets/${file}`);
const contentOwners = new Map();
for (const file of assetFiles) {
  const digest = createHash("sha256").update(await readFile(resolve(webDist, file))).digest("hex");
  contentOwners.set(digest, [...(contentOwners.get(digest) ?? []), file]);
}
const duplicates = [...contentOwners.values()].filter((files) => files.length > 1);
assert.deepEqual(duplicates, [], "duplicate emitted asset contents");

const entry = chunks.find((chunk) => chunk.isEntry);
function rootChunk(root) {
  const matches = chunks.filter((chunk) => chunk.rootModules.includes(root));
  assert.equal(matches.length, 1, `expected one chunk holding ${root}, found ${matches.length}`);
  return matches[0];
}
function staticClosure(roots) {
  const files = new Set();
  const pending = [entry.file, ...roots.map((root) => rootChunk(root).file)];
  while (pending.length) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);
    pending.push(...chunkByFile.get(file).imports);
  }
  return files;
}
function assertExcluded(roots, label, forbidden) {
  const modules = [...staticClosure(roots)].flatMap((file) => chunkByFile.get(file).modules);
  const violations = modules.filter((module) => forbidden.some((pattern) => pattern.test(module)));
  assert.deepEqual(violations, [], `${label} loads code of a more privileged layer`);
}

// Permission layers: visitors' pages, the administrator sign-in, image
// administrators and super administrators each load nothing of the next.
const admin = "src/pages/admin/";
const pages = {
  home: "src/pages/home/HomePage.tsx",
  gallery: "src/pages/gallery/GalleryPage.tsx",
  show: "src/pages/show/ShowPage.tsx",
  embed: "src/components/layout/EmbeddedPageLayout.tsx"
};
const adminShell = `${admin}shell/AdminShell.tsx`;
const workspaceShell = `${admin}shell/AuthenticatedAdminShell.tsx`;
const administratorCode = [
  /^src\/pages\/admin\//,
  /^src\/components\/image\/ImageAdminDetails\.tsx$/,
  /^src\/components\/image\/editor\//,
  /^src\/styles\/admin\//,
  /^src\/styles\/admin-core\.css$/
];
// The layers are ordered: what a layer may not load, no less privileged one may.
const superAdministratorCode = [
  /^src\/pages\/admin\/(?:settings|storage|users|logs)\//,
  /^src\/pages\/admin\/check\/CheckMaintenanceCapability\.tsx$/,
  /^src\/lib\/api\/storage-backend-image-migration\.ts$/,
  /^src\/components\/image\/editor\/ImageStorageMigrationDialog\.tsx$/,
  /^src\/styles\/admin\/(?:settings|storage|logs|check-maintenance)\.css$/
];
for (const [name, page] of Object.entries(pages)) {
  assertExcluded([page], `public ${name} page`, [...administratorCode, ...superAdministratorCode]);
}
const publicStyles = new Set([...staticClosure(Object.values(pages))]
  .flatMap((file) => chunkByFile.get(file).css));
for (const file of publicStyles) {
  const source = await readFile(resolve(webDist, file), "utf8");
  assert.doesNotMatch(
    source,
    /--admin-(?:color|shadow)-|\.admin(?:\b|[-_])|\[data-admin|\.login(?:\b|[-_])/,
    `public styles include administrator styles: ${file}`
  );
}

// The sign-in loads no workspace module: of the administrator pages only the
// outer shell and the sign-in files, its challenge included, may join it.
assertExcluded([adminShell, `${admin}account/AdminLogin.tsx`, `${admin}account/LoginChallenge.tsx`], "administrator sign-in", [
  /^src\/pages\/admin\/(?!shell\/AdminShell\.tsx$|account\/(?:AdminLogin|LoginChallenge|admin-login-session|useLoginVisualViewport)\.tsx?$)/,
  /^src\/components\/image\/ImageAdminDetails\.tsx$/,
  /^src\/components\/image\/editor\//,
  /^src\/styles\/admin-core\.css$/,
  ...superAdministratorCode
]);

const imageRoutes = [
  "overview/Overview.tsx",
  "images/ImageAdmin.tsx",
  "groups/GroupAdmin.tsx",
  "groups/GroupDetail.tsx",
  "vocabulary/VocabularyAdmin.tsx",
  "account/AccountSettings.tsx",
  "check/CheckPage.tsx"
].map((route) => `${admin}${route}`);
const imageCapabilities = [
  "src/components/image/ImageAdminDetails.tsx",
  "src/components/image/editor/image-editor-capability.ts",
  `${admin}ingestion/Ingestion.tsx`,
  `${admin}ingestion/import/ImportSourceDialog.tsx`,
  `${admin}images/ImageIdInputDialog.tsx`
];
for (const route of imageRoutes) {
  assertExcluded([adminShell, workspaceShell, route], `image administrator ${route}`, superAdministratorCode);
}
for (const capability of imageCapabilities) {
  assertExcluded([adminShell, workspaceShell, capability], `image administrator ${capability}`, superAdministratorCode);
  for (const page of [pages.gallery, pages.show]) {
    assertExcluded([page, capability], `${capability} on a public page`, superAdministratorCode);
  }
}

// Each document preloads exactly the files its page needs beyond the entry.
const documentPages = {
  home: [pages.home],
  gallery: [pages.gallery],
  show: [pages.show],
  embed: [pages.embed],
  admin: [adminShell]
};
assert.deepEqual(Object.keys(documentPreloads.documents).sort(), Object.keys(documentPages).sort());
const entryFiles = staticClosure([]);
const entryStyles = new Set([...entryFiles].flatMap((file) => chunkByFile.get(file).css));
for (const [name, roots] of Object.entries(documentPages)) {
  const files = [...staticClosure(roots)].filter((file) => !entryFiles.has(file));
  const { scripts, styles } = documentPreloads.documents[name];
  assert.deepEqual(
    [...scripts].sort(),
    files.filter((file) => chunkByFile.get(file).emitted).sort(),
    `${name} document scripts`
  );
  assert.deepEqual(
    [...styles].sort(),
    [...new Set(files.flatMap((file) => chunkByFile.get(file).css))]
      .filter((file) => !entryStyles.has(file))
      .sort(),
    `${name} document styles`
  );
}

console.log(
  `check-web-chunks: ${assetFiles.length} assets; public, sign-in, image and super administrator ` +
    "layers keep their code apart; document preloads match their pages"
);
