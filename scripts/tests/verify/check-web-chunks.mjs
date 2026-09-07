import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  compressStaticAsset,
  staticAssetCompression
} from "../../build/static-asset-compression.mjs";

// Small bodies follow the same actual-savings rule as built assets.
{
  const compressible = Buffer.from("const value='same';".repeat(8));
  assert.ok(compressible.length < 256);
  const compressed = await compressStaticAsset("tiny.js", compressible);
  assert.ok(compressed.brotli);
  assert.ok(compressed.gzip);
  assert.ok(compressed.brotliBytes < compressed.rawBytes);
  assert.ok(compressed.gzipBytes < compressed.rawBytes);

  const tiny = Buffer.from("x");
  const unchanged = await compressStaticAsset("tiny.js", tiny);
  assert.equal(unchanged.brotli, null);
  assert.equal(unchanged.gzip, null);
  assert.equal(unchanged.effectiveBytes, tiny.length);
}

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const webDist = resolve(workspaceRoot, "packages/web/dist");
const report = JSON.parse(await readFile(
  resolve(webDist, ".vite/web-build-report.json"),
  "utf8"
));

if (!Array.isArray(report.chunks) || !Array.isArray(report.styles)) {
  throw new Error("check-web-chunks: invalid build report");
}

const chunks = report.chunks;
const chunkByFile = new Map(chunks.map((chunk) => [chunk.file, chunk]));
if (chunkByFile.size !== chunks.length) {
  throw new Error("check-web-chunks: duplicate JavaScript output name");
}

for (const chunk of chunks) {
  if (
    !Array.isArray(chunk.modules)
    || !chunk.moduleRoots
    || chunk.modules.some((module) => !Array.isArray(chunk.moduleRoots[module]))
    || !Array.isArray(chunk.dynamicImporters)
    || typeof chunk.isEntry !== "boolean"
    || typeof chunk.isDynamicEntry !== "boolean"
  ) {
    throw new Error(`check-web-chunks: invalid module roots for ${chunk.file}`);
  }
  for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) {
    if (!chunkByFile.has(dependency)) {
      throw new Error(
        `check-web-chunks: ${chunk.file} references missing chunk ${dependency}`
      );
    }
  }
  for (const importer of chunk.dynamicImporters) {
    if (!chunkByFile.get(importer)?.dynamicImports.includes(chunk.file)) {
      throw new Error(
        `check-web-chunks: ${chunk.file} has invalid dynamic importer ${importer}`
      );
    }
  }
  for (const file of [...(chunk.emitted ? [chunk.file] : []), ...chunk.css]) {
    await stat(resolve(webDist, file));
    if (!/-[A-Za-z0-9_-]{6,}\.(?:css|js)$/.test(file)) {
      throw new Error(
        `check-web-chunks: generated asset lacks a content hash: ${file}`
      );
    }
    if (/^assets\/(?:shared|style)-/.test(file)) {
      throw new Error(
        `check-web-chunks: generated asset lacks a semantic owner: ${file}`
      );
    }
  }
}

const styleByFile = new Map(report.styles.map((style) => [style.file, style]));
if (styleByFile.size !== report.styles.length) {
  throw new Error("check-web-chunks: duplicate CSS output name");
}
for (const style of report.styles) {
  await stat(resolve(webDist, style.file));
  if (
    !Array.isArray(style.owners)
    || style.owners.length === 0
    || style.owners.some((owner) => (
      !chunkByFile.get(owner.file)?.css.includes(style.file)
    ))
  ) {
    throw new Error(
      `check-web-chunks: invalid CSS owners for ${style.file}`
    );
  }
}

function chunkForFacade(facade) {
  const matches = chunks.filter((chunk) => chunk.facade === facade);
  if (matches.length !== 1) {
    throw new Error(
      `check-web-chunks: expected one output for ${facade}, found ${matches.length}`
    );
  }
  return matches[0];
}

function staticClosure(startFiles) {
  const visited = new Set();
  const pending = [...startFiles];
  while (pending.length) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    pending.push(...chunkByFile.get(file).imports);
  }
  return visited;
}

function modulesIn(files) {
  return new Set(
    [...files].flatMap((file) => chunkByFile.get(file).modules)
  );
}

function staticAssets(startFiles) {
  const js = staticClosure(startFiles);
  return new Set([
    ...[...js].filter((file) => chunkByFile.get(file).emitted),
    ...[...js].flatMap((file) => chunkByFile.get(file).css)
  ]);
}

function initialAssets(entry, route) {
  return staticAssets([entry.file, route.file]);
}

function incrementalAssets(target, loadedAssets) {
  return new Set(
    [...staticAssets([target.file])].filter((file) => !loadedAssets.has(file))
  );
}

const compressionByFile = new Map();
const sourceByFile = new Map();
async function assetSource(file) {
  let pending = sourceByFile.get(file);
  if (!pending) {
    pending = readFile(resolve(webDist, file));
    sourceByFile.set(file, pending);
  }
  return pending;
}
async function assetCompression(file) {
  let pending = compressionByFile.get(file);
  if (!pending) {
    pending = assetSource(file)
      .then((source) => compressStaticAsset(file, source));
    compressionByFile.set(file, pending);
  }
  return pending;
}

function assertModulesExcluded(files, label, forbidden) {
  const violations = [...modulesIn(files)].filter((module) => (
    forbidden.some((pattern) => typeof pattern === "string"
      ? pattern === module
      : pattern.test(module))
  ));
  if (violations.length) {
    throw new Error(
      `check-web-chunks: ${label} includes deferred implementation: ${JSON.stringify(violations)}`
    );
  }
}

function isApplicationFoundation(roots) {
  const hasHome = roots.some((root) => (
    /^src\/pages\/home\//.test(root)
  ));
  const hasGallery = roots.some((root) => (
    /^src\/pages\/gallery\//.test(root)
  ));
  const hasShow = roots.some((root) => (
    /^src\/pages\/show\//.test(root)
  ));
  const hasOtherRoot = roots.some((root) => (
    !/^src\/pages\/(?:home|show|gallery)\//.test(root)
  ));
  return (
    Number(hasHome) + Number(hasShow) + Number(hasGallery) >= 2
    && hasOtherRoot
  );
}

function assertInitialModuleRoots(files, label, allowedFacades) {
  const allowed = new Set(["index.html", ...allowedFacades]);
  const violations = [];
  for (const file of files) {
    const chunk = chunkByFile.get(file);
    for (const module of chunk.modules) {
      if (!module.startsWith("src/")) continue;
      const roots = chunk.moduleRoots[module];
      if (
        roots.some((root) => allowed.has(root))
        || isApplicationFoundation(roots)
      ) continue;
      violations.push({ module, roots });
    }
  }
  if (violations.length) {
    throw new Error(
      `check-web-chunks: ${label} includes modules owned only by deferred roots: `
      + JSON.stringify(violations)
    );
  }
}

function assertDynamicTarget(source, target, label) {
  if (!source.dynamicImports.includes(target.file)) {
    throw new Error(
      `check-web-chunks: ${label} is not a direct lazy output`
    );
  }
}

function assertDeferredReachable(source, target, label) {
  const initial = staticClosure([source.file]);
  if (initial.has(target.file)) {
    throw new Error(`check-web-chunks: ${label} is loaded eagerly`);
  }
  const pending = [{ file: source.file, crossedLazyBoundary: false }];
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    const key = `${current.file}:${current.crossedLazyBoundary}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (current.file === target.file && current.crossedLazyBoundary) return;
    const chunk = chunkByFile.get(current.file);
    pending.push(...chunk.imports.map((file) => ({
      file,
      crossedLazyBoundary: current.crossedLazyBoundary
    })));
    pending.push(...chunk.dynamicImports.map((file) => ({
      file,
      crossedLazyBoundary: true
    })));
  }
  throw new Error(`check-web-chunks: ${label} is not reachable lazily`);
}

const entry = chunkForFacade("index.html");
const home = chunkForFacade("src/pages/home/HomePage.tsx");
const show = chunkForFacade("src/pages/show/ShowRoutePage.tsx");
const gallery = chunkForFacade("src/pages/gallery/GalleryPage.tsx");
const adminShell = chunkForFacade("src/pages/admin/shell/AdminShell.tsx");
const adminLogin = chunkForFacade("src/pages/admin/account/AdminLogin.tsx");
const loginChallenge = chunkForFacade("src/pages/admin/account/LoginChallenge.tsx");
const authenticatedShell = chunkForFacade(
  "src/pages/admin/shell/AuthenticatedAdminShell.tsx"
);
const imageAdmin = chunkForFacade("src/pages/admin/images/ImageAdmin.tsx");
const overview = chunkForFacade("src/pages/admin/Overview.tsx");
const vocabularyAdmin = chunkForFacade(
  "src/pages/admin/VocabularyAdmin.tsx"
);
const accountSettings = chunkForFacade(
  "src/pages/admin/account/AccountSettings.tsx"
);
const settingsPage = chunkForFacade("src/pages/admin/SettingsPage.tsx");
const advancedConfigPage = chunkForFacade(
  "src/pages/admin/advanced-config/AdvancedConfigPage.tsx"
);
const storageSettings = chunkForFacade(
  "src/pages/admin/storage/StorageSettings.tsx"
);
const userAdmin = chunkForFacade("src/pages/admin/UserAdmin.tsx");
const checkPage = chunkForFacade("src/pages/admin/check/CheckPage.tsx");
const checkMaintenance = chunkForFacade(
  "src/pages/admin/check/CheckMaintenanceCapability.tsx"
);
const logPage = chunkForFacade("src/pages/admin/LogPage.tsx");
const ingestion = chunkForFacade("src/pages/admin/ingestion/Ingestion.tsx");
const importSource = chunkForFacade(
  "src/pages/admin/ingestion/import/ImportSourceDialog.tsx"
);
const imageEditor = chunkForFacade(
  "src/components/image/editor/image-editor-capability.ts"
);
const imageDetails = chunkForFacade(
  "src/components/image/ImageAdminDetails.tsx"
);

for (const route of [home, show, gallery, adminShell]) {
  assertDynamicTarget(entry, route, route.facade);
}
assertDynamicTarget(adminShell, adminLogin, "administrator login");
assertDynamicTarget(adminShell, authenticatedShell, "authenticated admin shell");
assertDynamicTarget(adminLogin, loginChallenge, "optional login challenge");

const homeAssets = initialAssets(entry, home);
const showAssets = initialAssets(entry, show);
const galleryAssets = initialAssets(entry, gallery);
const homeInitialChunks = staticClosure([entry.file, home.file]);
const showInitialChunks = staticClosure([entry.file, show.file]);
const galleryInitialChunks = staticClosure([entry.file, gallery.file]);
const publicInitialChunks = staticClosure([
  entry.file,
  home.file,
  show.file,
  gallery.file
]);
assertModulesExcluded(publicInitialChunks, "public initial routes", [
  /^src\/pages\/admin\//,
  /^src\/components\/image\/ImageAdminDetails\.tsx$/,
  /^src\/components\/image\/editor\//,
  /^src\/styles\/admin\//,
  /^src\/styles\/admin-core\.css$/
]);
assertInitialModuleRoots(
  homeInitialChunks,
  "Home initial route",
  [home.facade]
);
assertInitialModuleRoots(
  showInitialChunks,
  "Show initial route",
  [show.facade]
);
assertInitialModuleRoots(
  galleryInitialChunks,
  "Gallery initial route",
  [gallery.facade]
);

const publicCss = new Set(
  [...homeAssets, ...showAssets, ...galleryAssets].filter((file) => file.endsWith(".css"))
);
for (const file of publicCss) {
  const source = await readFile(resolve(webDist, file), "utf8");
  if (
    /--admin-(?:color|shadow)-/.test(source)
    || /(?:\.admin(?:\b|[-_])|\[data-admin|\.login(?:\b|[-_]))/.test(source)
  ) {
    throw new Error(
      `check-web-chunks: public initial CSS includes administrator-only styles: ${file}`
    );
  }
}

const imageAdminAssets = staticAssets([
  entry.file,
  adminShell.file,
  authenticatedShell.file,
  imageAdmin.file
]);
const mergeArrivalScenarios = {
  home: homeAssets,
  show: showAssets,
  gallery: galleryAssets,
  publicDetail: galleryAssets,
  adminLogin: staticAssets([entry.file, adminShell.file, adminLogin.file]),
  imageAdmin: imageAdminAssets,
  imageEditor: incrementalAssets(imageEditor, imageAdminAssets),
  ingestion: incrementalAssets(ingestion, imageAdminAssets)
};

const mergeCandidateMaxRawBytes = 8 * 1024;
const mergeCandidateMaxEffectiveBytes = 4 * 1024;
function isMergeCandidate(compressed) {
  return compressed.rawBytes < mergeCandidateMaxRawBytes
    || compressed.effectiveBytes < mergeCandidateMaxEffectiveBytes;
}

function chunkRoots(chunk) {
  return [...new Set(
    Object.values(chunk.moduleRoots).flat()
  )].sort();
}

const assetDirectoryFiles = await readdir(resolve(webDist, "assets"));
const emittedJavascriptFiles = assetDirectoryFiles
  .filter((file) => file.endsWith(".js"))
  .map((file) => `assets/${file}`)
  .sort();
const reportedJavascriptFiles = new Set(
  chunks.filter((chunk) => chunk.emitted).map((chunk) => chunk.file)
);
const auxiliaryJavascriptFiles = emittedJavascriptFiles.filter((file) => (
  !reportedJavascriptFiles.has(file)
));
const javascriptAssets = [];
for (const chunk of chunks) {
  if (!chunk.emitted) continue;
  const compressed = await assetCompression(chunk.file);
  javascriptAssets.push({
    file: chunk.file,
    kind: chunk.isEntry
      ? "entry"
      : (chunk.isDynamicEntry ? "dynamic-entry" : "shared"),
    owner: chunk.name,
    facade: chunk.facade,
    isEntry: chunk.isEntry,
    isDynamicEntry: chunk.isDynamicEntry,
    roots: chunkRoots(chunk),
    dynamicImporters: chunk.dynamicImporters,
    rawBytes: compressed.rawBytes,
    gzipBytes: compressed.gzipBytes,
    brotliBytes: compressed.brotliBytes,
    effectiveBytes: compressed.effectiveBytes
  });
}
for (const file of auxiliaryJavascriptFiles) {
  const compressed = await assetCompression(file);
  javascriptAssets.push({
    file,
    kind: "auxiliary",
    rawBytes: compressed.rawBytes,
    gzipBytes: compressed.gzipBytes,
    brotliBytes: compressed.brotliBytes,
    effectiveBytes: compressed.effectiveBytes
  });
}
const mergeCandidateChunks = javascriptAssets.filter(isMergeCandidate);
const mergeCandidateChunkCounts = {
  under512: mergeCandidateChunks.filter((chunk) => (
    chunk.rawBytes < 512
  )).length,
  under1KiB: mergeCandidateChunks.filter((chunk) => (
    chunk.rawBytes < 1024
  )).length,
  under2KiB: mergeCandidateChunks.filter((chunk) => (
    chunk.rawBytes < 2 * 1024
  )).length,
  under4KiB: mergeCandidateChunks.filter((chunk) => (
    chunk.rawBytes < 4 * 1024
  )).length,
  under8KiB: mergeCandidateChunks.filter((chunk) => (
    chunk.rawBytes < 8 * 1024
  )).length,
  effectiveUnder4KiB: mergeCandidateChunks.filter((chunk) => (
    chunk.effectiveBytes < 4 * 1024
  )).length,
  candidates: mergeCandidateChunks.length
};

const styleAssets = [];
for (const style of report.styles) {
  const compressed = await assetCompression(style.file);
  styleAssets.push({
    file: style.file,
    owners: style.owners.map((owner) => ({
      file: owner.file,
      facade: owner.facade
    })),
    rawBytes: compressed.rawBytes,
    gzipBytes: compressed.gzipBytes,
    brotliBytes: compressed.brotliBytes,
    effectiveBytes: compressed.effectiveBytes
  });
}
const smallStyleChunks = styleAssets.filter(isMergeCandidate);
const smallStyleCounts = {
  under512: smallStyleChunks.filter((style) => (
    style.rawBytes < 512
  )).length,
  under1KiB: smallStyleChunks.filter((style) => (
    style.rawBytes < 1024
  )).length,
  under2KiB: smallStyleChunks.filter((style) => (
    style.rawBytes < 2 * 1024
  )).length,
  under4KiB: smallStyleChunks.filter((style) => (
    style.rawBytes < 4 * 1024
  )).length,
  under8KiB: smallStyleChunks.filter((style) => (
    style.rawBytes < 8 * 1024
  )).length,
  effectiveUnder4KiB: smallStyleChunks.filter((style) => (
    style.effectiveBytes < 4 * 1024
  )).length,
  candidates: smallStyleChunks.length
};

const imageRoleScenarioRoutes = {
  overview,
  images: imageAdmin,
  vocabulary: vocabularyAdmin,
  account: accountSettings,
  check: checkPage
};
const superRoleScenarioRoutes = {
  ...imageRoleScenarioRoutes,
  site: settingsPage,
  advancedConfig: advancedConfigPage,
  storage: storageSettings,
  users: userAdmin,
  logs: logPage
};
function routeScenarioAssets(routes) {
  return Object.fromEntries(
    Object.entries(routes).map(([name, route]) => [name, staticAssets([
        entry.file,
        adminShell.file,
        authenticatedShell.file,
        route.file
      ])])
  );
}
const roleRouteAssets = {
  image: routeScenarioAssets(imageRoleScenarioRoutes),
  super: routeScenarioAssets(superRoleScenarioRoutes)
};

for (const chunk of mergeCandidateChunks) {
  chunk.arrivals = [
    ...(chunk.arrivals ?? []),
    ...Object.entries(mergeArrivalScenarios).flatMap(([name, files]) => (
      files.has(chunk.file) ? [`scenario:${name}`] : []
    )),
    ...Object.entries(roleRouteAssets).flatMap(([role, routes]) => (
      Object.entries(routes).flatMap(([name, files]) => (
        files.has(chunk.file) ? [`${role}:${name}`] : []
      ))
    ))
  ];
}
for (const style of smallStyleChunks) {
  style.arrivals = [
    ...Object.entries(mergeArrivalScenarios).flatMap(([name, files]) => (
      files.has(style.file) ? [`scenario:${name}`] : []
    )),
    ...Object.entries(roleRouteAssets).flatMap(([role, routes]) => (
      Object.entries(routes).flatMap(([name, files]) => (
        files.has(style.file) ? [`${role}:${name}`] : []
      ))
    ))
  ];
}

function repeatedOwnershipGroups(items, signature) {
  const groups = new Map();
  for (const item of items) {
    const key = signature(item);
    if (!key) continue;
    const files = groups.get(key) ?? [];
    files.push(item.file);
    groups.set(key, files);
  }
  return [...groups.values()]
    .filter((files) => files.length > 1)
    .map((files) => files.sort());
}

const identicalJavascriptRootGroups = repeatedOwnershipGroups(
  javascriptAssets.filter((asset) => asset.kind !== "auxiliary"),
  (asset) => asset.roots.length > 0 ? JSON.stringify(asset.roots) : ""
);
const identicalStyleOwnerGroups = repeatedOwnershipGroups(
  styleAssets,
  (style) => JSON.stringify(style.owners
    .map((owner) => `${owner.file}:${owner.facade ?? ""}`)
    .sort())
);

const emittedAssets = new Set([
  ...emittedJavascriptFiles,
  ...report.styles.map((style) => style.file)
]);
for (const file of auxiliaryJavascriptFiles) {
  await stat(resolve(webDist, file));
  if (!/-[A-Za-z0-9_-]{6,}\.js$/.test(file)) {
    throw new Error(
      `check-web-chunks: auxiliary asset lacks a content hash: ${file}`
    );
  }
}
const contentOwners = new Map();
for (const file of emittedAssets) {
  const digest = createHash("sha256").update(await assetSource(file)).digest("hex");
  const owners = contentOwners.get(digest) ?? [];
  owners.push(file);
  contentOwners.set(digest, owners);
}
const duplicateAssets = [...contentOwners.values()].filter((files) => (
  files.length > 1
));
if (duplicateAssets.length) {
  throw new Error(
    "check-web-chunks: duplicate emitted asset contents: "
    + JSON.stringify(duplicateAssets)
  );
}

const loginInitialChunks = staticClosure([
  entry.file,
  adminShell.file,
  adminLogin.file
]);
const loginEagerTargets = [
  authenticatedShell.file,
  loginChallenge.file,
  ...authenticatedShell.dynamicImports
].filter((file) => loginInitialChunks.has(file));
if (loginEagerTargets.length) {
  throw new Error(
    "check-web-chunks: unauthenticated admin entry loads authenticated or optional routes: "
    + JSON.stringify(loginEagerTargets)
  );
}
assertInitialModuleRoots(
  loginInitialChunks,
  "unauthenticated administrator entry",
  [adminShell.facade, adminLogin.facade]
);
assertModulesExcluded(
  loginInitialChunks,
  "unauthenticated administrator entry",
  [
    /^src\/pages\/admin\/shell\/AuthenticatedAdminShell\.tsx$/,
    /^src\/pages\/admin\/shell\/(?:AdminBrand|AdminNavGroup|AdminNavigation|admin-route-modules|useAdminRoutePreloadIntent)\.(?:ts|tsx)$/,
    /^src\/styles\/admin-core\.css$/,
    /^src\/styles\/admin\/(?:layout|controls|responsive)\.css$/
  ]
);

const authenticatedInitial = staticClosure([authenticatedShell.file]);
assertInitialModuleRoots(
  authenticatedInitial,
  "authenticated administrator shell",
  [authenticatedShell.facade]
);
const routeChunks = authenticatedShell.dynamicImports.map((file) => (
  chunkByFile.get(file)
));
if (
  routeChunks.length === 0
  || routeChunks.some((chunk) => (
    !chunk.facade?.startsWith("src/pages/admin/")
    || authenticatedInitial.has(chunk.file)
  ))
) {
  throw new Error(
    "check-web-chunks: authenticated permission routes are not independent lazy outputs"
  );
}
assertDynamicTarget(authenticatedShell, imageAdmin, "image administrator route");
assertInitialModuleRoots(
  staticClosure([authenticatedShell.file, imageAdmin.file]),
  "image administrator initial route",
  [authenticatedShell.facade, imageAdmin.facade]
);

const imageRoleRoutes = [
  overview,
  imageAdmin,
  vocabularyAdmin,
  accountSettings,
  checkPage
];
const superRoleRoutes = [
  settingsPage,
  advancedConfigPage,
  storageSettings,
  userAdmin,
  logPage
];
for (const route of [...imageRoleRoutes, ...superRoleRoutes]) {
  assertDynamicTarget(
    authenticatedShell,
    route,
    `administrator route ${route.facade}`
  );
}

const checkMaintenanceOnlyModules = [
  checkMaintenance.facade,
  /^src\/styles\/admin\/check-maintenance\.css$/,
  /^src\/pages\/admin\/storage\/StorageBackendMigrationDialog\.tsx$/,
  /^src\/lib\/api\/storage-backend-image-migration\.ts$/
];
const superOnlyModules = [
  settingsPage.facade,
  userAdmin.facade,
  logPage.facade,
  /^src\/pages\/admin\/(?:advanced-config|storage)\//,
  ...checkMaintenanceOnlyModules,
  /^src\/styles\/admin\/(?:advanced-config|settings|storage|logs)\.css$/
];
const imageRoleFacades = [
  adminShell.facade,
  authenticatedShell.facade,
  ...imageRoleRoutes.map((route) => route.facade)
];
for (const route of imageRoleRoutes) {
  const routeClosure = staticClosure([
    entry.file,
    adminShell.file,
    authenticatedShell.file,
    route.file
  ]);
  assertInitialModuleRoots(
    routeClosure,
    `image administrator route ${route.facade}`,
    imageRoleFacades
  );
  assertModulesExcluded(
    routeClosure,
    `image administrator route ${route.facade}`,
    superOnlyModules
  );
}
const allAdminRoutes = [...imageRoleRoutes, ...superRoleRoutes];
for (const route of allAdminRoutes) {
  const routeClosure = staticClosure([
    entry.file,
    adminShell.file,
    authenticatedShell.file,
    route.file
  ]);
  const foreignRouteEntries = allAdminRoutes
    .filter((candidate) => candidate !== route)
    .filter((candidate) => routeClosure.has(candidate.file))
    .map((candidate) => candidate.facade);
  if (foreignRouteEntries.length) {
    throw new Error(
      `check-web-chunks: ${route.facade} eagerly loads other route entries: `
      + JSON.stringify(foreignRouteEntries)
    );
  }
}

const checkReadOnlyClosure = staticClosure([checkPage.file]);
assertDynamicTarget(
  checkPage,
  checkMaintenance,
  "super administrator Check maintenance capability"
);
assertModulesExcluded(
  checkReadOnlyClosure,
  "image administrator Check route",
  checkMaintenanceOnlyModules
);
for (const [target, label] of [
  [ingestion, "ingestion workflow"],
  [importSource, "import source workflow"],
  [imageEditor, "image editor"],
  [imageDetails, "image details"]
]) {
  assertDeferredReachable(imageAdmin, target, label);
}
assertDeferredReachable(gallery, imageDetails, "public image details");
assertDeferredReachable(gallery, imageEditor, "public image editor");
assertDeferredReachable(show, imageDetails, "Show public image details");
assertDeferredReachable(show, imageEditor, "Show public image editor");

const analysis = {
  compression: {
    brotliQuality: staticAssetCompression.brotliQuality,
    gzipLevel: staticAssetCompression.gzipLevel,
    selection: "compressed-body-smaller-than-raw",
    mergeCandidateDiscovery: {
      rawBytesUnder: mergeCandidateMaxRawBytes,
      effectiveBytesUnder: mergeCandidateMaxEffectiveBytes
    }
  },
  output: {
    javascript: emittedJavascriptFiles.length,
    auxiliaryJavascript: auxiliaryJavascriptFiles.length,
    sharedJavascript: chunks.filter((chunk) => (
      chunk.emitted && !chunk.isEntry && !chunk.isDynamicEntry
    )).length,
    styles: report.styles.length,
    longestAssetName: [...emittedAssets]
      .map((file) => file.slice(file.lastIndexOf("/") + 1))
      .sort((left, right) => right.length - left.length)[0] ?? ""
  },
  auxiliaryJavascript: javascriptAssets.filter((asset) => (
    asset.kind === "auxiliary"
  )),
  identicalJavascriptRootGroups,
  identicalStyleOwnerGroups,
  mergeCandidateChunkCounts,
  mergeCandidateChunks: mergeCandidateChunks.sort((left, right) => (
    left.effectiveBytes - right.effectiveBytes
    || left.file.localeCompare(right.file)
  )),
  smallStyleCounts,
  smallStyleChunks: smallStyleChunks.sort((left, right) => (
    left.effectiveBytes - right.effectiveBytes
    || left.file.localeCompare(right.file)
  ))
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(analysis, null, 2));
} else {
  console.log(
    "check-web-chunks: semantic assets and real build graph preserve public, login, permission and capability lazy boundaries; "
    + `merge-candidate JS raw <512/1KiB/2KiB/4KiB/8KiB = `
    + `${mergeCandidateChunkCounts.under512}/${mergeCandidateChunkCounts.under1KiB}/`
    + `${mergeCandidateChunkCounts.under2KiB}/${mergeCandidateChunkCounts.under4KiB}/`
    + `${mergeCandidateChunkCounts.under8KiB}, effective <4KiB / union = `
    + `${mergeCandidateChunkCounts.effectiveUnder4KiB}/${mergeCandidateChunkCounts.candidates}; CSS = `
    + `${smallStyleCounts.under512}/${smallStyleCounts.under1KiB}/`
    + `${smallStyleCounts.under2KiB}/${smallStyleCounts.under4KiB}/`
    + `${smallStyleCounts.under8KiB}, effective <4KiB / union = `
    + `${smallStyleCounts.effectiveUnder4KiB}/${smallStyleCounts.candidates}; compression br `
    + `${staticAssetCompression.brotliQuality}, gzip `
    + `${staticAssetCompression.gzipLevel}, smaller body only; auxiliary JavaScript `
    + `${auxiliaryJavascriptFiles.length}`
  );
}
