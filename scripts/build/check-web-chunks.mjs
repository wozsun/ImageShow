import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const webDist = resolve(workspaceRoot, "packages/web/dist");
const report = JSON.parse(await readFile(
  resolve(webDist, ".vite/web-build-report.json"),
  "utf8"
));

if (report.version !== 2 || !Array.isArray(report.chunks)) {
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
  for (const file of [...(chunk.emitted ? [chunk.file] : []), ...chunk.css]) {
    await stat(resolve(webDist, file));
    if (!/-[A-Za-z0-9_-]{6,}\.(?:css|js)$/.test(file)) {
      throw new Error(
        `check-web-chunks: generated asset lacks a content hash: ${file}`
      );
    }
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

function initialAssets(entry, route) {
  const js = staticClosure([entry.file, route.file]);
  return new Set([
    ...[...js].filter((file) => chunkByFile.get(file).emitted),
    ...[...js].flatMap((file) => chunkByFile.get(file).css)
  ]);
}

async function assetBytes(files) {
  let total = 0;
  for (const file of files) total += (await stat(resolve(webDist, file))).size;
  return total;
}

function assertModulesExcluded(files, label, forbidden) {
  const violations = [...modulesIn(files)].filter((module) => (
    forbidden.some((pattern) => pattern.test(module))
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
  const hasOtherRoot = roots.some((root) => (
    !/^src\/pages\/(?:home|gallery)\//.test(root)
  ));
  return hasHome && hasGallery && hasOtherRoot;
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
const gallery = chunkForFacade("src/pages/gallery/GalleryPage.tsx");
const adminShell = chunkForFacade("src/pages/admin/AdminShell.tsx");
const adminLogin = chunkForFacade("src/pages/admin/AdminLogin.tsx");
const loginChallenge = chunkForFacade("src/pages/admin/LoginChallenge.tsx");
const authenticatedShell = chunkForFacade(
  "src/pages/admin/AuthenticatedAdminShell.tsx"
);
const imageAdmin = chunkForFacade("src/pages/admin/ImageAdmin.tsx");
const uploader = chunkForFacade("src/pages/admin/uploader/Uploader.tsx");
const importSource = chunkForFacade(
  "src/pages/admin/uploader/link-import/ImportSourceDialog.tsx"
);
const imageEditor = chunkForFacade(
  "src/components/image/editor/image-editor-capability.ts"
);
const imageDetails = chunkForFacade(
  "src/components/image/ImageAdminDetails.tsx"
);

for (const route of [home, gallery, adminShell]) {
  assertDynamicTarget(entry, route, route.facade);
}
assertDynamicTarget(adminShell, adminLogin, "administrator login");
assertDynamicTarget(adminShell, authenticatedShell, "authenticated admin shell");
assertDynamicTarget(adminLogin, loginChallenge, "optional login challenge");

const homeAssets = initialAssets(entry, home);
const galleryAssets = initialAssets(entry, gallery);
const homeInitialChunks = staticClosure([entry.file, home.file]);
const galleryInitialChunks = staticClosure([entry.file, gallery.file]);
const publicInitialChunks = staticClosure([
  entry.file,
  home.file,
  gallery.file
]);
assertModulesExcluded(publicInitialChunks, "public initial routes", [
  /^src\/pages\/admin\//
]);
assertInitialModuleRoots(
  homeInitialChunks,
  "Home initial route",
  [home.facade]
);
assertInitialModuleRoots(
  galleryInitialChunks,
  "Gallery initial route",
  [gallery.facade]
);

const publicCss = new Set(
  [...homeAssets, ...galleryAssets].filter((file) => file.endsWith(".css"))
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

const publicBudgets = {
  home: { requests: 10, bytes: 450 * 1024 },
  gallery: { requests: 16, bytes: 550 * 1024 }
};
const publicResults = {
  home: { requests: homeAssets.size, bytes: await assetBytes(homeAssets) },
  gallery: {
    requests: galleryAssets.size,
    bytes: await assetBytes(galleryAssets)
  }
};
for (const route of Object.keys(publicBudgets)) {
  const budget = publicBudgets[route];
  const result = publicResults[route];
  if (result.requests > budget.requests || result.bytes > budget.bytes) {
    throw new Error(
      `check-web-chunks: ${route} initial budget exceeded: `
      + `${result.requests}/${budget.requests} requests, `
      + `${result.bytes}/${budget.bytes} bytes`
    );
  }
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
  staticClosure([imageAdmin.file]),
  "image administrator initial route",
  [imageAdmin.facade]
);

for (const [target, label] of [
  [uploader, "upload workflow"],
  [importSource, "link import workflow"],
  [imageEditor, "image editor"],
  [imageDetails, "image details"]
]) {
  assertDeferredReachable(imageAdmin, target, label);
}
assertDeferredReachable(gallery, imageDetails, "public image details");
assertDeferredReachable(gallery, imageEditor, "public image editor");

console.log(
  "check-web-chunks: real build graph and module roots preserve public, login, permission and capability lazy boundaries; "
  + `Home ${publicResults.home.requests} requests/${publicResults.home.bytes} bytes, `
  + `Gallery ${publicResults.gallery.requests} requests/${publicResults.gallery.bytes} bytes`
);
