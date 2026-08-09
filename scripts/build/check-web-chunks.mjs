import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createWebBuildInspector } from "./web-build-inspector.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const webDist = resolve(workspaceRoot, "packages/web/dist");
const assetRoot = resolve(webDist, "assets");
const {
  assetNames,
  assetNameSet,
  cssAssetNames,
  javaScriptAssetNames,
  assetSource,
  assertAssetsExcludeMarkers,
  assertCssPreloadsUsePrefixes,
  assertStaticDependencyUnreachable,
  cssPreloadDependencies,
  dynamicImportIndex,
  dynamicPreloadDependencies,
  findStaticReachableDynamicImporter,
  requireCssAssets: requireSharedCssAsset,
  singleCssAsset,
  singleJavaScriptAsset: singleAsset
} = await createWebBuildInspector(assetRoot);

const overlongJavaScriptAssets = javaScriptAssetNames.filter(
  (name) => name.length > 64
);
if (overlongJavaScriptAssets.length > 0) {
  throw new Error(
    `check-web-chunks: JavaScript asset names exceed 64 characters: ${JSON.stringify(overlongJavaScriptAssets)}`
  );
}
const verboseSharedCssAssets = cssAssetNames.filter((name) => (
  name.startsWith("route-pages~") || name.includes("~")
));
if (verboseSharedCssAssets.length > 0) {
  throw new Error(
    `check-web-chunks: shared CSS names expose route sets: ${JSON.stringify(verboseSharedCssAssets)}`
  );
}
const overlongCssAssets = cssAssetNames.filter((name) => name.length > 64);
if (overlongCssAssets.length > 0) {
  throw new Error(
    `check-web-chunks: CSS asset names exceed 64 characters: ${JSON.stringify(overlongCssAssets)}`
  );
}
const requiredEntryCssAssetPrefixes = [
  "app-core",
  "home",
  "gallery",
  "admin-core",
  "images",
  "upload",
  "login",
  "login-challenge",
  "overview",
  "check",
  "entities",
  "site-settings",
  "advanced-config",
  "storage",
  "log"
];
const requiredSharedCssAssetPrefixes = [
  "public-common",
  "image-management",
  "image-detail",
  "image-workflow",
  "admin-theme"
];
const optionalCssAssetPrefixes = [
  "account",
  "image-edit",
  "image-editor",
  "image-admin-common",
  "super-admin"
];
const classifiedCssAssetPrefixes = [
  ...requiredEntryCssAssetPrefixes,
  ...requiredSharedCssAssetPrefixes,
  ...optionalCssAssetPrefixes,
  "admin-common",
  "shared",
  "common"
];
const classifiedCssPrefixAlternatives = classifiedCssAssetPrefixes.join("|");
const classifiedCssAssetPattern = new RegExp(
  `^(?:${classifiedCssPrefixAlternatives})-[A-Za-z0-9_-]{6}\\.css$`
);
const classifiedCssPrefixPattern = new RegExp(
  `^(?:${classifiedCssPrefixAlternatives})-`
);
const classifiedRouteCssAssets = cssAssetNames.filter((name) => (
  classifiedCssAssetPattern.test(name)
));
const malformedClassifiedRouteCssAssets = cssAssetNames.filter((name) => (
  classifiedCssPrefixPattern.test(name)
  && !classifiedRouteCssAssets.includes(name)
));
if (malformedClassifiedRouteCssAssets.length > 0) {
  throw new Error(
    `check-web-chunks: classified route CSS assets lack a six-character content hash: ${JSON.stringify(malformedClassifiedRouteCssAssets)}`
  );
}
const unclassifiedCssAssets = cssAssetNames.filter((name) => (
  !classifiedCssAssetPattern.test(name)
));
if (unclassifiedCssAssets.length > 0) {
  throw new Error(
    `check-web-chunks: CSS assets lack a classified semantic name: ${JSON.stringify(unclassifiedCssAssets)}`
  );
}

for (const prefix of requiredEntryCssAssetPrefixes) {
  singleCssAsset(prefix);
}
for (const prefix of requiredSharedCssAssetPrefixes) {
  requireSharedCssAsset(prefix);
}

const requiredJavaScriptAssetPrefixes = [
  "app",
  "home",
  "gallery",
  "admin",
  "admin-app",
  "login",
  "login-challenge",
  "overview",
  "images",
  "image-management",
  "image-editor",
  "upload",
  "link-import",
  "storage-migration",
  "account",
  "entities",
  "site-settings",
  "advanced-config",
  "storage",
  "users",
  "check",
  "log",
  "pbkdf2",
  "app-foundation",
  "admin-auth-shared",
  "admin-foundation",
  "query-vendor",
  "react-vendor"
];
for (const prefix of requiredJavaScriptAssetPrefixes) {
  singleAsset(prefix);
}

const appFoundationAsset = singleAsset("app-foundation");
const adminFoundationAsset = singleAsset("admin-foundation");
const adminAuthSharedAsset = singleAsset("admin-auth-shared");

async function generatedIconEntries(fileName) {
  const source = await readFile(resolve(
    workspaceRoot,
    "packages/web/src/components/icon",
    fileName
  ), "utf8");
  return [...source.matchAll(/^  ("[^"]+"): ("[^"]+"),?$/gm)].map(
    (match) => ({
      name: JSON.parse(match[1]),
      path: JSON.parse(match[2])
    })
  );
}

async function assertIconPathOwnership(entries, expectedAsset, label) {
  const javaScriptAssets = assetNames.filter((name) => name.endsWith(".js"));
  const unexpected = [];
  for (const { name, path } of entries) {
    const owners = [];
    for (const assetName of javaScriptAssets) {
      if ((await assetSource(assetName)).includes(path)) owners.push(assetName);
    }
    if (owners.length !== 1 || owners[0] !== expectedAsset) {
      unexpected.push({ name, owners });
    }
  }
  if (unexpected.length > 0) {
    throw new Error(
      `check-web-chunks: ${label} icon paths must exist only in ${expectedAsset}: `
      + JSON.stringify(unexpected)
    );
  }
}

function assertPreloadsExcludeAssets(preloads, deferredAssets, label) {
  const eagerAssets = deferredAssets.filter((assetName) => (
    preloads.includes(assetName)
  ));
  if (eagerAssets.length > 0) {
    throw new Error(
      `check-web-chunks: ${label} preloads deferred capabilities: `
      + JSON.stringify(eagerAssets)
    );
  }
}

const commonIconEntries = await generatedIconEntries("icons.generated.ts");
const adminIconEntries = await generatedIconEntries("admin-icons.generated.ts");
const generatedIconNames = [
  ...commonIconEntries.map((entry) => entry.name),
  ...adminIconEntries.map((entry) => entry.name)
];
const generatedIconPaths = [
  ...commonIconEntries.map((entry) => entry.path),
  ...adminIconEntries.map((entry) => entry.path)
];
if (
  commonIconEntries.length !== 16
  || adminIconEntries.length !== 34
  || new Set(generatedIconNames).size !== 50
  || new Set(generatedIconPaths).size !== 50
) {
  throw new Error(
    "check-web-chunks: generated icon tables must contain 16 common and 34 admin icons without duplicate names or paths"
  );
}
await Promise.all([
  assertIconPathOwnership(
    commonIconEntries,
    appFoundationAsset,
    "common"
  ),
  assertIconPathOwnership(
    adminIconEntries,
    adminFoundationAsset,
    "admin"
  )
]);

const indexHtml = await readFile(resolve(webDist, "index.html"), "utf8");
const htmlInitialAssetNames = [...indexHtml.matchAll(
  /\b(?:href|src)=["']\/assets\/([^"']+\.(?:css|js))["']/g
)].map((match) => match[1]);
for (const assetName of htmlInitialAssetNames) {
  if (!assetNameSet.has(assetName)) {
    throw new Error(
      `check-web-chunks: public HTML references missing asset ${assetName}`
    );
  }
}
const appCoreCssAsset = singleCssAsset("app-core");
const htmlCssAssets = [...indexHtml.matchAll(
  /\bhref=["']\/assets\/([^"']+\.css)["']/g
)].map((match) => match[1]);
if (
  htmlCssAssets.length !== 1
  || htmlCssAssets[0] !== appCoreCssAsset
) {
  throw new Error(
    `check-web-chunks: public HTML must load only ${appCoreCssAsset}, found ${JSON.stringify(htmlCssAssets)}`
  );
}
if (/modulepreload[^>]+admin-foundation-/.test(indexHtml)) {
  throw new Error("check-web-chunks: public HTML preloads admin-foundation");
}

const indexAsset = singleAsset("app");
const homeAsset = singleAsset("home");
const galleryAsset = singleAsset("gallery");
const adminShellAsset = singleAsset("admin");
const authenticatedAdminShellAsset = singleAsset("admin-app");
const adminLoginAsset = singleAsset("login");
const loginChallengeAsset = singleAsset("login-challenge");
const pbkdf2WorkerAsset = singleAsset("pbkdf2");
const overviewAsset = singleAsset("overview");
const imageAdminAsset = singleAsset("images");
const imageAdminDetailsAsset = singleAsset("image-management");
const imageEditorCapabilityAsset = singleAsset("image-editor");
const uploaderAsset = singleAsset("upload");
const linkUrlDialogAsset = singleAsset("link-import");
const publicEntrySource = await assetSource(indexAsset);
function publicRouteInitialAssetSet(entryAsset) {
  return new Set([
    ...htmlInitialAssetNames,
    entryAsset,
    ...dynamicPreloadDependencies(publicEntrySource, entryAsset)
  ]);
}
const homeInitialAssetCount = publicRouteInitialAssetSet(homeAsset).size;
const galleryInitialAssetCount = publicRouteInitialAssetSet(galleryAsset).size;
if (homeInitialAssetCount > 10 || galleryInitialAssetCount > 16) {
  throw new Error(
    "check-web-chunks: public route initial asset request budget exceeded: "
    + `Home ${homeInitialAssetCount}/10, Gallery ${galleryInitialAssetCount}/16`
  );
}
const homeInitialCssAssets = assertCssPreloadsUsePrefixes(
  publicEntrySource,
  homeAsset,
  "HomePage",
  ["home", "public-common"],
  ["home", "public-common"]
);
const galleryInitialCssAssets = assertCssPreloadsUsePrefixes(
  publicEntrySource,
  galleryAsset,
  "GalleryPage",
  ["gallery", "public-common", "image-detail"],
  ["gallery", "public-common", "image-detail"]
);

await assertAssetsExcludeMarkers(
  [appCoreCssAsset, ...homeInitialCssAssets, ...galleryInitialCssAssets],
  "CSS",
  "public initial route",
  [
    {
      pattern: /--admin-(?:color|shadow)-/,
      description: "an admin semantic token"
    },
    {
      pattern: /(?:\.admin(?:\b|[-_])|\[data-admin|\.login(?:\b|[-_]))/,
      description: "an admin or login selector"
    }
  ]
);

await Promise.all([
  assertStaticDependencyUnreachable(
    indexAsset,
    adminFoundationAsset,
    "public entry"
  ),
  assertStaticDependencyUnreachable(
    homeAsset,
    adminFoundationAsset,
    "HomePage"
  ),
  assertStaticDependencyUnreachable(
    galleryAsset,
    adminFoundationAsset,
    "GalleryPage"
  )
]);

const galleryAdminDetailsImporter = await findStaticReachableDynamicImporter(
  galleryAsset,
  imageAdminDetailsAsset,
  "GalleryPage"
);
const publicAdminDetailCss = cssPreloadDependencies(
  galleryAdminDetailsImporter.source,
  imageAdminDetailsAsset
);
const publicAdminDetailPreloads = dynamicPreloadDependencies(
  galleryAdminDetailsImporter.source,
  imageAdminDetailsAsset
);
assertPreloadsExcludeAssets(
  publicAdminDetailPreloads,
  [adminFoundationAsset, imageEditorCapabilityAsset],
  "authenticated public image management details"
);
await assertAssetsExcludeMarkers(
  [
    imageAdminDetailsAsset,
    ...publicAdminDetailPreloads.filter((assetName) => assetName.endsWith(".js"))
  ],
  "JavaScript",
  "authenticated public image management details",
  [{
    pattern: /(?:batch-edit-modal|image-preview-modal)/,
    description: "the deferred image metadata editor"
  }]
);
const expectedPublicAdminDetailCss = singleCssAsset("image-management");
if (
  publicAdminDetailCss.length !== 1
  || publicAdminDetailCss[0] !== expectedPublicAdminDetailCss
) {
  throw new Error(
    "check-web-chunks: authenticated public image detail must add only "
    + `${expectedPublicAdminDetailCss}, found ${JSON.stringify(publicAdminDetailCss)}`
  );
}

const adminShellSource = await assetSource(adminShellAsset);
const adminLoginSource = await assetSource(adminLoginAsset);
const adminLoginPreloads = dynamicPreloadDependencies(
  adminShellSource,
  adminLoginAsset
);
const adminLoginInitialCss = cssPreloadDependencies(
  adminShellSource,
  adminLoginAsset
);
const loginChallengePreloads = dynamicPreloadDependencies(
  adminLoginSource,
  loginChallengeAsset
);
const loginChallengeCss = cssPreloadDependencies(
  adminLoginSource,
  loginChallengeAsset
);
const authenticatedAdminShellPreloads = dynamicPreloadDependencies(
  adminShellSource,
  authenticatedAdminShellAsset
);
await Promise.all([
  assertStaticDependencyUnreachable(
    adminShellAsset,
    adminFoundationAsset,
    "unauthenticated AdminShell"
  ),
  assertStaticDependencyUnreachable(
    adminLoginAsset,
    adminFoundationAsset,
    "AdminLogin"
  )
]);
assertPreloadsExcludeAssets(
  adminLoginPreloads,
  [
    adminFoundationAsset,
    imageAdminAsset,
    imageAdminDetailsAsset,
    imageEditorCapabilityAsset,
    uploaderAsset,
    loginChallengeAsset,
    pbkdf2WorkerAsset,
    singleCssAsset("login-challenge")
  ],
  "AdminLogin"
);
if (!adminLoginPreloads.includes(adminAuthSharedAsset)) {
  throw new Error(
    `check-web-chunks: AdminLogin must reuse ${adminAuthSharedAsset}`
  );
}
if (dynamicImportIndex(adminLoginSource, loginChallengeAsset) < 0) {
  throw new Error(
    `check-web-chunks: AdminLogin must conditionally import ${loginChallengeAsset}`
  );
}
const loginChallengeCssAsset = singleCssAsset("login-challenge");
if (
  loginChallengeCss.length !== 1
  || loginChallengeCss[0] !== loginChallengeCssAsset
) {
  throw new Error(
    "check-web-chunks: ALTCHA must load only its dedicated CSS with the challenge, found "
    + JSON.stringify(loginChallengeCss)
  );
}
assertPreloadsExcludeAssets(
  loginChallengePreloads,
  [
    adminFoundationAsset,
    imageAdminAsset,
    imageAdminDetailsAsset,
    uploaderAsset,
    pbkdf2WorkerAsset
  ],
  "ALTCHA challenge module"
);
const loginChallengeSource = await assetSource(loginChallengeAsset);
if (
  !loginChallengeSource.includes(pbkdf2WorkerAsset)
  || !/\/auth\/challenge/.test(loginChallengeSource)
) {
  throw new Error(
    `check-web-chunks: ${loginChallengeAsset} must own the ALTCHA endpoint and worker`
  );
}
if (
  dynamicImportIndex(adminShellSource, adminFoundationAsset) < 0
  || !authenticatedAdminShellPreloads.includes(adminFoundationAsset)
) {
  throw new Error(
    "check-web-chunks: successful login and authenticated shell must reuse "
    + adminFoundationAsset
  );
}
await assertAssetsExcludeMarkers(
  [
    adminShellAsset,
    adminLoginAsset,
    ...adminLoginPreloads.filter((assetName) => assetName.endsWith(".js"))
  ],
  "JavaScript",
  "unauthenticated admin entry",
  [
    {
      pattern: /(?:batch-snapshot|image-detail-modal|batch-edit-modal)/,
      description: "a deferred image management capability"
    },
    {
      pattern: /\/api\/admin\/images(?:[?'"]|\/|$)/,
      description: "an authenticated image API request"
    },
    {
      pattern: /(?:altcha-widget|PBKDF2\/SHA-256|\/auth\/challenge)/,
      description: "the optional ALTCHA implementation"
    }
  ]
);
await assertAssetsExcludeMarkers(
  adminLoginInitialCss,
  "CSS",
  "ALTCHA-disabled login entry",
  [{
    pattern: /(?:--altcha-|--admin-color-altcha-|\.altcha(?:\b|-)|login-altcha|login-challenge-retry)/,
    description: "an optional ALTCHA style"
  }]
);
assertCssPreloadsUsePrefixes(
  adminShellSource,
  adminLoginAsset,
  "AdminLogin",
  ["login", "admin-theme"],
  ["login", "admin-theme"]
);
assertCssPreloadsUsePrefixes(
  adminShellSource,
  authenticatedAdminShellAsset,
  "authenticated admin shell",
  ["admin-core", "admin-theme"],
  ["admin-core", "admin-theme"]
);

const authenticatedAdminShellSource = await assetSource(
  authenticatedAdminShellAsset
);
if (dynamicImportIndex(authenticatedAdminShellSource, imageAdminDetailsAsset) >= 0) {
  throw new Error(
    "check-web-chunks: authenticated admin shell must not preload image admin details"
  );
}
const imageAdminInitialPreloads = dynamicPreloadDependencies(
  authenticatedAdminShellSource,
  imageAdminAsset
);
const imageAdminDeferredAssets = [
  imageAdminDetailsAsset,
  imageEditorCapabilityAsset,
  uploaderAsset,
  linkUrlDialogAsset,
  singleCssAsset("image-management"),
  singleCssAsset("image-workflow"),
  singleCssAsset("upload")
];
assertPreloadsExcludeAssets(
  imageAdminInitialPreloads,
  imageAdminDeferredAssets,
  "ImageAdmin initial route"
);
await assertAssetsExcludeMarkers(
  [
    imageAdminAsset,
    ...imageAdminInitialPreloads.filter((assetName) => assetName.endsWith(".js"))
  ],
  "JavaScript",
  "ImageAdmin initial route",
  [
    {
      pattern: /image-detail-modal/,
      description: "the deferred image detail dialog"
    },
    {
      pattern: /batch-edit-modal/,
      description: "the deferred image metadata editor"
    }
  ]
);
const imageAdminCssAssets = assertCssPreloadsUsePrefixes(
  authenticatedAdminShellSource,
  imageAdminAsset,
  "ImageAdmin",
  ["images", "admin-theme"],
  ["images"]
);

await assertAssetsExcludeMarkers(
  [
    appCoreCssAsset,
    singleCssAsset("admin-core"),
    singleCssAsset("admin-theme"),
    singleCssAsset("image-management"),
    ...imageAdminCssAssets
  ],
  "CSS",
  "ImageAdmin",
  [
    {
      pattern: /--admin-(?:color|shadow)-(?:focus-code|code-|config-summary|log-|storage-)/,
      description: "a super-admin-only semantic token"
    },
    {
      pattern: /\.(?:advanced-config|config-package|log-|settings-|storage-)/,
      description: "a super-admin-only page selector"
    },
    {
      pattern: /\.image-detail-modal/,
      description: "the deferred image detail dialog"
    },
    {
      pattern: /\.(?:batch-edit-modal|image-preview-modal)/,
      description: "the deferred image metadata editor"
    }
  ]
);

const imageAdminUploaderImporter = await findStaticReachableDynamicImporter(
  imageAdminAsset,
  uploaderAsset,
  "ImageAdmin"
);
assertCssPreloadsUsePrefixes(
  imageAdminUploaderImporter.source,
  uploaderAsset,
  "Uploader capability",
  ["upload", "image-workflow", "image-detail"],
  ["upload", "image-workflow", "image-detail"]
);

const imageAdminEditorImporter = await findStaticReachableDynamicImporter(
  imageAdminAsset,
  imageEditorCapabilityAsset,
  "ImageAdmin"
);
assertCssPreloadsUsePrefixes(
  imageAdminEditorImporter.source,
  imageEditorCapabilityAsset,
  "image editor capability",
  ["image-editor", "image-workflow", "admin-theme"],
  ["image-editor", "image-workflow", "admin-theme"]
);

const overviewInitialPreloads = dynamicPreloadDependencies(
  authenticatedAdminShellSource,
  overviewAsset
);
assertPreloadsExcludeAssets(
  overviewInitialPreloads,
  [
    imageAdminDetailsAsset,
    imageEditorCapabilityAsset,
    expectedPublicAdminDetailCss
  ],
  "Overview initial route"
);
await assertAssetsExcludeMarkers(
  [
    overviewAsset,
    ...overviewInitialPreloads.filter((assetName) => assetName.endsWith(".js"))
  ],
  "JavaScript",
  "Overview initial route",
  [
    {
      pattern: /image-detail-modal/,
      description: "the deferred image detail dialog"
    },
    {
      pattern: /batch-edit-modal/,
      description: "the deferred image metadata editor"
    }
  ]
);
await assertAssetsExcludeMarkers(
  overviewInitialPreloads.filter((assetName) => assetName.endsWith(".css")),
  "CSS",
  "Overview initial route",
  [
    {
      pattern: /\.image-detail-modal/,
      description: "the deferred image detail dialog"
    },
    {
      pattern: /\.(?:batch-edit-modal|image-preview-modal)/,
      description: "the deferred image metadata editor"
    }
  ]
);

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
    ? `check-web-chunks: public routes and AdminLogin exclude admin-foundation; Home ${homeInitialAssetCount} and Gallery ${galleryInitialAssetCount} initial assets stay within budget; ${commonIconEntries.length} common and ${adminIconEntries.length} admin icon paths have single foundation owners; ${classifiedRouteCssAssets.length} route CSS assets use classified short names; only ${runtimeAsset.assetName} (${runtimeAsset.size} B) is below 1 KiB`
    : `check-web-chunks: public routes and AdminLogin exclude admin-foundation; Home ${homeInitialAssetCount} and Gallery ${galleryInitialAssetCount} initial assets stay within budget; ${commonIconEntries.length} common and ${adminIconEntries.length} admin icon paths have single foundation owners; ${classifiedRouteCssAssets.length} route CSS assets use classified short names; no JavaScript asset is below 1 KiB`
);
