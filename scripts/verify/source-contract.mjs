import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { appConfig } from "../../packages/shared/src/app-config.ts";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const sourceRoots = [
  "packages/shared/src",
  "packages/server/src",
  "packages/web/src"
].map((path) => resolve(workspaceRoot, path));
const codeExtensions = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx"]);

function displayPath(path) {
  return relative(workspaceRoot, path).replaceAll("\\", "/");
}

async function sourceFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (codeExtensions.has(extname(entry.name))) files.push(path);
    }
  }
  await walk(root);
  return files;
}

const files = (await Promise.all(sourceRoots.map(sourceFiles))).flat();
const fileSet = new Set(files);
const importPattern = /(?:\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s*)?|\bimport\s*\(\s*)["']([^"']+)["']/g;
const workspaceEntries = new Map([
  ["@imageshow/shared", resolve(workspaceRoot, "packages/shared/src/app-config.ts")],
  ["@imageshow/shared/browser", resolve(workspaceRoot, "packages/shared/src/browser.ts")]
]);

function workspaceName(path) {
  const displayed = displayPath(path);
  const match = /^packages\/(shared|server|web)\/src\//.exec(displayed);
  return match?.[1] ?? null;
}

function resolveImport(importer, specifier) {
  if (workspaceEntries.has(specifier)) return workspaceEntries.get(specifier);
  if (!specifier.startsWith(".")) return null;
  const requested = resolve(importer, "..", specifier);
  const extension = extname(requested);
  const candidates = extension
    ? [
        requested,
        ...(extension === ".js"
          ? [requested.slice(0, -3) + ".ts", requested.slice(0, -3) + ".tsx"]
          : [])
      ]
    : [
        ...[".ts", ".tsx", ".mts", ".mjs", ".js"].map((suffix) => requested + suffix),
        ...[".ts", ".tsx", ".mts", ".mjs", ".js"].map((suffix) => resolve(requested, `index${suffix}`))
      ];
  return candidates.find((candidate) => fileSet.has(candidate)) ?? null;
}

const graph = new Map();
const reversePageDependencies = new Set();
const reverseInternalWebDependencies = new Set();
const invalidServerDependencies = new Set();
const authSessionQueryOwners = new Set();
const authExpiredListenerOwners = new Set();
const directRouteJsonReaders = new Set();
const invalidWorkspaceDependencies = [];
const allowedWorkspaceDependencies = {
  shared: new Set(),
  server: new Set(["shared"]),
  web: new Set(["shared"])
};
const pageCompositionRoots = new Set([
  "packages/web/src/AppRoutes.tsx"
]);
const allowedWebLayerDependencies = {
  components: new Set(["components", "hooks", "lib"]),
  hooks: new Set(["hooks", "lib"]),
  lib: new Set(["lib"]),
  pages: new Set(["pages", "components", "hooks", "lib"])
};
const allowedCoreDependencies = new Set(["core", "config", "types"]);

function webLayer(path) {
  return /^packages\/web\/src\/(pages|components|hooks|lib)(?:\/|$)/.exec(path)?.[1]
    ?? null;
}

function serverLayer(path) {
  return /^packages\/server\/src\/([^/]+)\//.exec(path)?.[1] ?? null;
}

for (const file of files) {
  const source = await readFile(file, "utf8");
  const dependencies = new Set();
  const sourcePath = displayPath(file);
  if (/queryKey:\s*queryKeys\.me\b/.test(source)) {
    authSessionQueryOwners.add(sourcePath);
  }
  if (/\.addEventListener\(\s*authExpiredEvent\b/.test(source)) {
    authExpiredListenerOwners.add(sourcePath);
  }
  if (
    sourcePath.startsWith("packages/server/src/routes/")
    && /\.req\.json\s*\(/.test(source)
  ) {
    directRouteJsonReaders.add(sourcePath);
  }
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1];
    const target = resolveImport(file, specifier);
    const sourceWorkspace = workspaceName(file);
    const targetWorkspace = target
      ? workspaceName(target)
      : /^@imageshow\/(shared|server|web)(?:\/|$)/.exec(specifier)?.[1] ?? null;
    if (
      sourceWorkspace
      && targetWorkspace
      && sourceWorkspace !== targetWorkspace
      && !allowedWorkspaceDependencies[sourceWorkspace].has(targetWorkspace)
    ) {
      invalidWorkspaceDependencies.push(
        `${displayPath(file)} -> ${specifier}`
      );
    }
    if (!target) continue;
    dependencies.add(target);
    const targetPath = displayPath(target);
    if (
      sourcePath.startsWith("packages/web/src/")
      && !sourcePath.startsWith("packages/web/src/pages/")
      && !pageCompositionRoots.has(sourcePath)
      && targetPath.startsWith("packages/web/src/pages/")
    ) {
      reversePageDependencies.add(`${sourcePath} -> ${targetPath}`);
    }
    const sourceWebLayer = webLayer(sourcePath);
    const targetWebLayer = webLayer(targetPath);
    if (
      sourceWebLayer
      && targetWebLayer
      && targetWebLayer !== "pages"
      && !allowedWebLayerDependencies[sourceWebLayer].has(targetWebLayer)
    ) {
      reverseInternalWebDependencies.add(`${sourcePath} -> ${targetPath}`);
    }
    const sourceServerLayer = serverLayer(sourcePath);
    const targetServerLayer = serverLayer(targetPath);
    if (
      sourceServerLayer === "core"
      && targetServerLayer
      && !allowedCoreDependencies.has(targetServerLayer)
    ) {
      invalidServerDependencies.add(`${sourcePath} -> ${targetPath}`);
    }
    if (
      sourceServerLayer
      && sourceServerLayer !== "routes"
      && targetServerLayer === "routes"
    ) {
      invalidServerDependencies.add(`${sourcePath} -> ${targetPath}`);
    }
  }
  graph.set(file, dependencies);
}

if (invalidWorkspaceDependencies.length > 0) {
  throw new Error(
    "source-contract: workspace dependency direction changed: "
    + JSON.stringify(invalidWorkspaceDependencies)
  );
}

if (directRouteJsonReaders.size > 0) {
  throw new Error(
    "source-contract: write routes must use readJsonBody: "
    + JSON.stringify([...directRouteJsonReaders])
  );
}

const authSessionOwner = "packages/web/src/hooks/useAuthSession.tsx";
if (
  authSessionQueryOwners.size !== 1
  || !authSessionQueryOwners.has(authSessionOwner)
  || authExpiredListenerOwners.size !== 1
  || !authExpiredListenerOwners.has(authSessionOwner)
) {
  throw new Error(
    "source-contract: auth session ownership changed: "
    + JSON.stringify({
      authSessionQueryOwners: [...authSessionQueryOwners],
      authExpiredListenerOwners: [...authExpiredListenerOwners]
    })
  );
}

const allowedReversePageDependencies = new Set();
const unexpectedReverseDependencies = [...reversePageDependencies].filter(
  (edge) => !allowedReversePageDependencies.has(edge)
);
const staleReverseAllowlist = [...allowedReversePageDependencies].filter(
  (edge) => !reversePageDependencies.has(edge)
);
const allowedReverseInternalWebDependencies = new Set();
const unexpectedInternalWebDependencies = [...reverseInternalWebDependencies]
  .filter((edge) => !allowedReverseInternalWebDependencies.has(edge));
const staleInternalWebAllowlist = [...allowedReverseInternalWebDependencies]
  .filter((edge) => !reverseInternalWebDependencies.has(edge));
if (
  unexpectedReverseDependencies.length
  || staleReverseAllowlist.length
  || unexpectedInternalWebDependencies.length
  || staleInternalWebAllowlist.length
  || invalidServerDependencies.size > 0
) {
  throw new Error(
    "source-contract: internal dependency direction changed: "
    + JSON.stringify({
      unexpectedReverseDependencies,
      staleReverseAllowlist,
      unexpectedInternalWebDependencies,
      staleInternalWebAllowlist,
      invalidServerDependencies: [...invalidServerDependencies]
    })
  );
}

let nextIndex = 0;
const indexes = new Map();
const lowLinks = new Map();
const stack = [];
const onStack = new Set();
const components = [];
function visit(file) {
  indexes.set(file, nextIndex);
  lowLinks.set(file, nextIndex);
  nextIndex += 1;
  stack.push(file);
  onStack.add(file);
  for (const dependency of graph.get(file) ?? []) {
    if (!indexes.has(dependency)) {
      visit(dependency);
      lowLinks.set(file, Math.min(lowLinks.get(file), lowLinks.get(dependency)));
    } else if (onStack.has(dependency)) {
      lowLinks.set(file, Math.min(lowLinks.get(file), indexes.get(dependency)));
    }
  }
  if (lowLinks.get(file) !== indexes.get(file)) return;
  const component = [];
  while (stack.length) {
    const member = stack.pop();
    onStack.delete(member);
    component.push(member);
    if (member === file) break;
  }
  if (component.length > 1 || (graph.get(file) ?? new Set()).has(file)) {
    components.push(component.map(displayPath).sort().join(" | "));
  }
}
for (const file of files) if (!indexes.has(file)) visit(file);

const allowedCycles = new Set();
const unexpectedCycles = components.filter((cycle) => !allowedCycles.has(cycle));
const staleCycleAllowlist = [...allowedCycles].filter(
  (cycle) => !components.includes(cycle)
);
if (unexpectedCycles.length || staleCycleAllowlist.length) {
  throw new Error(
    "source-contract: dependency cycles changed: "
    + JSON.stringify({ unexpectedCycles, staleCycleAllowlist })
  );
}

function stripJsonComments(source) {
  let result = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      result += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = "";
      continue;
    }
    if (current === '"') {
      quote = current;
      result += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    result += current;
  }
  return result;
}

function objectKeyPaths(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...objectKeyPaths(nested, path)];
  });
}

const example = JSON.parse(stripJsonComments(
  await readFile(resolve(workspaceRoot, "config.example.jsonc"), "utf8")
));
const defaultKeys = new Set(objectKeyPaths(appConfig.runtimeDefaults));
const exampleKeys = new Set(objectKeyPaths(example));
const missingExampleKeys = [...defaultKeys].filter((key) => !exampleKeys.has(key));
const unknownExampleKeys = [...exampleKeys].filter((key) => !defaultKeys.has(key));
if (missingExampleKeys.length || unknownExampleKeys.length) {
  throw new Error(
    "source-contract: config.example.jsonc keys differ from runtime defaults: "
    + JSON.stringify({ missingExampleKeys, unknownExampleKeys })
  );
}

console.log(
  `source-contract: ${files.length} modules, ${components.length} dependency cycles, `
  + `${defaultKeys.size} runtime config keys`
);
