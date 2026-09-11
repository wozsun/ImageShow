import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { API as TypeScriptAPI } from "typescript/unstable/sync";
import {
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isImportExpression,
  isStringLiteralLikeNode
} from "typescript/unstable/ast/is";
import { appConfig } from "../../../packages/shared/src/app-config.ts";
import { runtimeConfigDefaults } from "../../../packages/server/src/config/runtime-config.ts";
import { runtimeConfigEnvironmentBindings } from "../../../packages/server/src/config/runtime-config-environment.ts";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
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
const moduleSpecifiersByFile = new Map();
const typeScriptApi = new TypeScriptAPI({ cwd: workspaceRoot });
let typeScriptSnapshot;
try {
  typeScriptSnapshot = typeScriptApi.updateSnapshot({
    openProjects: [
      resolve(workspaceRoot, "packages/shared/tsconfig.json"),
      resolve(workspaceRoot, "packages/server/tsconfig.check.json"),
      resolve(workspaceRoot, "packages/web/tsconfig.check.json")
    ]
  });
  const programs = typeScriptSnapshot.getProjects().map((project) => project.program);
  for (const file of files) {
    const sourceFile = programs
      .map((program) => program.getSourceFile(file))
      .find(Boolean);
    if (!sourceFile) {
      throw new Error(`source-contract: TypeScript did not load ${displayPath(file)}`);
    }
    const specifiers = new Set();
    function visit(node) {
      if (
        isImportDeclaration(node)
        && isStringLiteralLikeNode(node.moduleSpecifier)
      ) {
        specifiers.add(node.moduleSpecifier.text);
      } else if (
        isExportDeclaration(node)
        && node.moduleSpecifier
        && isStringLiteralLikeNode(node.moduleSpecifier)
      ) {
        specifiers.add(node.moduleSpecifier.text);
      } else if (
        isCallExpression(node)
        && isImportExpression(node.expression)
        && node.arguments.length > 0
        && isStringLiteralLikeNode(node.arguments[0])
      ) {
        specifiers.add(node.arguments[0].text);
      }
      node.forEachChild(visit);
    }
    visit(sourceFile);
    moduleSpecifiersByFile.set(file, specifiers);
  }
} finally {
  typeScriptSnapshot?.dispose();
  typeScriptApi.close();
}
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
const reverseInternalWebDependencies = new Set();
const invalidServerDependencies = new Set();
const invalidIngestionDomainDependencies = new Set();
const privateIngestionRouteDependencies = new Set();
const invalidWorkspaceDependencies = [];
const allowedWorkspaceDependencies = {
  shared: new Set(),
  server: new Set(["shared"]),
  web: new Set(["shared"])
};
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
  const dependencies = new Set();
  const sourcePath = displayPath(file);
  for (const specifier of moduleSpecifiersByFile.get(file) ?? []) {
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
    const sourceWebLayer = webLayer(sourcePath);
    const targetWebLayer = webLayer(targetPath);
    if (
      sourceWebLayer
      && targetWebLayer
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
    const ingestionDomainRoot = "packages/server/src/images/ingestion/";
    const ingestionCompositionModule =
      sourcePath === `${ingestionDomainRoot}runtime.ts`
      || sourcePath.startsWith(`${ingestionDomainRoot}workers/`);
    if (
      sourcePath.startsWith(ingestionDomainRoot)
      && !ingestionCompositionModule
      && (
        targetPath.startsWith(`${ingestionDomainRoot}workers/`)
        || targetPath === `${ingestionDomainRoot}runtime.ts`
      )
    ) {
      invalidIngestionDomainDependencies.add(`${sourcePath} -> ${targetPath}`);
    }
    if (
      sourcePath.startsWith("packages/server/src/routes/")
      && (
        targetPath.startsWith(
          "packages/server/src/images/ingestion/sessions/scripts/"
        )
        || targetPath.startsWith(
          "packages/server/src/images/ingestion/workers/"
        )
        || targetPath.startsWith(
          "packages/server/src/images/ingestion/execution/"
        )
        || targetPath.startsWith(
          "packages/server/src/images/ingestion/cleanup/"
        )
        || targetPath.startsWith(
          "packages/server/src/images/ingestion/cancel/"
        )
        || targetPath ===
          "packages/server/src/images/ingestion/queue/action.ts"
        || targetPath === "packages/server/src/images/ingestion/commit/worker.ts"
      )
    ) {
      privateIngestionRouteDependencies.add(`${sourcePath} -> ${targetPath}`);
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

if (
  reverseInternalWebDependencies.size
  || invalidServerDependencies.size
  || invalidIngestionDomainDependencies.size
  || privateIngestionRouteDependencies.size
) {
  throw new Error("source-contract: internal dependency direction changed: " + JSON.stringify({
    web: [...reverseInternalWebDependencies],
    server: [...invalidServerDependencies],
    ingestion: [...invalidIngestionDomainDependencies],
    routeInternals: [...privateIngestionRouteDependencies]
  }));
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

if (components.length) {
  throw new Error("source-contract: dependency cycles: " + JSON.stringify(components));
}

function objectLeafEntries(value, prefix = "") {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.keys(value).length === 0
  ) {
    return [[prefix, value]];
  }
  return Object.entries(value).flatMap(([key, nested]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return objectLeafEntries(nested, path);
  });
}

function assertSameSet(label, actual, expected) {
  const missing = [...expected].filter((value) => !actual.has(value));
  const unexpected = [...actual].filter((value) => !expected.has(value));
  if (missing.length || unexpected.length) {
    throw new Error(`${label}: ${JSON.stringify({ missing, unexpected })}`);
  }
}

function parseDotEnvExample(source) {
  const entries = new Map();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) {
      throw new Error(`source-contract: invalid .env.example line ${index + 1}: ${line}`);
    }
    if (entries.has(match[1])) {
      throw new Error(`source-contract: duplicate .env.example variable ${match[1]}`);
    }
    entries.set(match[1], match[2]);
  }
  return entries;
}

function decodeDotEnvValue(raw) {
  if (raw.startsWith('"')) return JSON.parse(raw);
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'")) throw new Error(`unterminated single-quoted value ${raw}`);
    return raw.slice(1, -1);
  }
  return raw;
}

function parseRuntimeExampleValue(binding, raw) {
  const decoded = decodeDotEnvValue(raw);
  if (binding.valueKind === "string") return decoded;
  if (binding.valueKind === "number") return Number(decoded);
  if (binding.valueKind === "boolean") {
    if (decoded === "true") return true;
    if (decoded === "false") return false;
    throw new Error(`${binding.environmentVariable} example must use true or false`);
  }
  return JSON.parse(decoded);
}

function objectRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`source-contract: ${label} must be a mapping`);
  }
  return value;
}

function composeService(compose, name) {
  const services = objectRecord(compose.services, "Compose services");
  const service = services[name];
  if (!service) throw new Error(`source-contract: missing Compose service ${name}`);
  return objectRecord(service, `Compose service ${name}`);
}

function composeEnvironment(service) {
  const environment = service.environment;
  if (environment === undefined || environment === null) return new Map();
  if (!Array.isArray(environment)) {
    return new Map(Object.entries(objectRecord(
      environment,
      "Compose service environment"
    )).map(([key, value]) => [key, value === null ? null : String(value)]));
  }
  const entries = new Map();
  for (const item of environment) {
    if (typeof item !== "string") {
      throw new Error("source-contract: Compose environment list entries must be strings");
    }
    const separator = item.indexOf("=");
    const key = separator === -1 ? item : item.slice(0, separator);
    const value = separator === -1 ? null : item.slice(separator + 1);
    if (entries.has(key)) {
      throw new Error(`source-contract: duplicate Compose environment key ${key}`);
    }
    entries.set(key, value);
  }
  return entries;
}

function composePortBinding(service, expected) {
  return (service.ports ?? []).some((binding) => {
    if (typeof binding === "string") {
      const match = /^(.*):(\d+):(\d+)(?:\/tcp)?$/.exec(binding);
      return match
        && match[1] === expected.hostIp
        && Number(match[2]) === expected.published
        && Number(match[3]) === expected.target;
    }
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      return false;
    }
    return String(binding.host_ip ?? "") === expected.hostIp
      && Number(binding.published) === expected.published
      && Number(binding.target) === expected.target
      && (binding.protocol ?? "tcp") === "tcp";
  });
}

function composeVolumeMount(service, expected) {
  return (service.volumes ?? []).some((mount) => {
    if (typeof mount === "string") {
      const parts = mount.split(":");
      if (parts.length < 2 || parts.length > 3) return false;
      const [source, target, rawOptions = ""] = parts;
      const options = new Set(rawOptions.split(",").filter(Boolean));
      const type = source.startsWith(".") || source.startsWith("/")
        ? "bind"
        : "volume";
      return source === expected.source
        && target === expected.target
        && type === expected.type
        && !options.has("ro");
    }
    if (!mount || typeof mount !== "object" || Array.isArray(mount)) {
      return false;
    }
    return mount.source === expected.source
      && mount.target === expected.target
      && mount.type === expected.type
      && (mount.read_only === undefined || mount.read_only === false);
  });
}

const composeVolumeContractFixtures = [
  [
    { volumes: ["redis_data:/data"] },
    { source: "redis_data", target: "/data", type: "volume" },
    true
  ],
  [
    { volumes: ["./data:/app/data:rw"] },
    { source: "./data", target: "/app/data", type: "bind" },
    true
  ],
  [
    { volumes: ["redis_data:/data:ro"] },
    { source: "redis_data", target: "/data", type: "volume" },
    false
  ],
  [
    { volumes: [{
      type: "bind", source: "redis_data", target: "/data"
    }] },
    { source: "redis_data", target: "/data", type: "volume" },
    false
  ],
  [
    { volumes: [{
      type: "volume", source: "redis_data", target: "/data", read_only: true
    }] },
    { source: "redis_data", target: "/data", type: "volume" },
    false
  ],
  [
    { volumes: [{
      type: "volume", source: "redis_data", target: "/data", read_only: false
    }] },
    { source: "redis_data", target: "/data", type: "volume" },
    true
  ]
];
for (const [service, expected, accepted] of composeVolumeContractFixtures) {
  assert.equal(
    composeVolumeMount(service, expected),
    accepted,
    `source-contract: Compose volume parser fixture drifted: ${JSON.stringify({
      service,
      expected
    })}`
  );
}

const runtimeDefaultEntries = new Map(objectLeafEntries(appConfig.runtimeDefaults));
const runtimeDefaultPaths = new Set(runtimeDefaultEntries.keys());
const runtimeDefaultPathOrder = [...runtimeDefaultEntries.keys()];
assert.deepEqual(
  runtimeConfigDefaults(),
  appConfig.runtimeDefaults,
  "source-contract: configured defaults must parse to the same current structure"
);
const bindingPaths = runtimeConfigEnvironmentBindings.map(({ path }) => path);
const bindingVariables = runtimeConfigEnvironmentBindings.map(
  ({ environmentVariable }) => environmentVariable
);
if (new Set(bindingPaths).size !== bindingPaths.length) {
  throw new Error("source-contract: duplicate RuntimeConfig environment binding path");
}
if (new Set(bindingVariables).size !== bindingVariables.length) {
  throw new Error("source-contract: duplicate RuntimeConfig environment variable");
}
assertSameSet(
  "source-contract: RuntimeConfig environment paths differ from current defaults",
  new Set(bindingPaths),
  runtimeDefaultPaths
);
for (const binding of runtimeConfigEnvironmentBindings) {
  const derivedVariable = binding.path.replaceAll(".", "_").toUpperCase();
  if (binding.environmentVariable !== derivedVariable) {
    throw new Error(
      `source-contract: ${binding.path} must map to ${derivedVariable}, got ${binding.environmentVariable}`
    );
  }
}

const environmentExampleSource = await readFile(
  resolve(workspaceRoot, ".env.example"),
  "utf8"
);
const environmentExample = parseDotEnvExample(environmentExampleSource);
const deploymentEnvironmentVariables = [
  "DATABASE_NAME",
  "DATABASE_USER",
  "DATABASE_PASSWORD",
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "DATABASE_HOST",
  "DATABASE_PORT",
  "REDIS_HOST",
  "REDIS_PORT",
  "REDIS_DB",
  "REDIS_PASSWORD",
  "TZ"
];
assertSameSet(
  "source-contract: .env.example differs from deployment plus RuntimeConfig catalog",
  new Set(environmentExample.keys()),
  new Set([...deploymentEnvironmentVariables, ...bindingVariables])
);
const defaultComposeEnvironment = new Map([
  ["DATABASE_NAME", "imageshow"],
  ["DATABASE_USER", "imageshow"],
  ["DATABASE_PASSWORD", ""],
  ["ADMIN_USERNAME", "admin"],
  ["ADMIN_PASSWORD", ""]
]);
for (const [variable, expected] of defaultComposeEnvironment) {
  const actual = environmentExample.get(variable);
  if (actual !== expected) {
    throw new Error(
      `source-contract: .env.example ${variable} default drifted: `
      + JSON.stringify({ expected, actual })
    );
  }
}
for (const binding of runtimeConfigEnvironmentBindings) {
  const actual = parseRuntimeExampleValue(
    binding,
    environmentExample.get(binding.environmentVariable)
  );
  const expected = runtimeDefaultEntries.get(binding.path);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `source-contract: .env.example ${binding.environmentVariable} default differs from ${binding.path}: `
      + JSON.stringify({ expected, actual })
    );
  }
}

const configurationGuide = await readFile(
  resolve(workspaceRoot, "docs/CONFIG.md"),
  "utf8"
);
const documentationEntries = new Map();
for (const section of configurationGuide.split(/(?=^#{1,4} )/m)) {
  const path = /^#### (\w+(?:\.\w+)+)\r?$/m.exec(section)?.[1];
  if (!path) continue;
  if (documentationEntries.has(path)) {
    throw new Error(`source-contract: duplicate configuration documentation section ${path}`);
  }
  const environmentVariable = /^- 环境变量：`([A-Z][A-Z0-9_]*)`\r?$/m.exec(section)?.[1];
  const defaultLiteral = /^- 类型、默认值与范围：.*默认 `([^`]*)`/m.exec(section)?.[1];
  const composeInjection = /^- Compose：(默认注入|显式映射)\r?$/m.exec(section)?.[1];
  const injection = composeInjection === "默认注入"
    ? "default"
    : composeInjection === "显式映射"
      ? "explicit"
      : null;
  documentationEntries.set(path, { defaultLiteral, environmentVariable, injection });
}
assertSameSet(
  "source-contract: configuration documentation paths differ from RuntimeConfig",
  new Set(documentationEntries.keys()),
  runtimeDefaultPaths
);
const composeSource = await readFile(resolve(workspaceRoot, "compose.yaml"), "utf8");
let compose;
try {
  compose = objectRecord(parseYaml(composeSource), "Compose document");
} catch (error) {
  throw new Error("source-contract: compose.yaml is not valid YAML", {
    cause: error
  });
}
const imageShowService = composeService(compose, "imageshow");
const imageShowEnvironment = composeEnvironment(imageShowService);
const defaultComposeRuntimeSeeds = new Set(imageShowEnvironment.keys());
const runtimeBindingByPath = new Map(
  runtimeConfigEnvironmentBindings.map((binding) => [binding.path, binding])
);
for (const path of runtimeDefaultPathOrder) {
  const documented = documentationEntries.get(path);
  let documentedDefault;
  try {
    documentedDefault = JSON.parse(documented.defaultLiteral);
  } catch (error) {
    throw new Error(
      `source-contract: documented default for ${path} is not JSON: ${documented.defaultLiteral}`,
      { cause: error }
    );
  }
  const expectedDefault = runtimeDefaultEntries.get(path);
  if (JSON.stringify(documentedDefault) !== JSON.stringify(expectedDefault)) {
    throw new Error(
      `source-contract: documented default for ${path} drifted: `
      + JSON.stringify({ expected: expectedDefault, actual: documentedDefault })
    );
  }
  const binding = runtimeBindingByPath.get(path);
  if (!binding) {
    throw new Error(
      `source-contract: ${path} is missing a RuntimeConfig environment binding`
    );
  }
  if (documented.environmentVariable !== binding.environmentVariable) {
    throw new Error(
      `source-contract: documented environment variable for ${path} is `
      + `${documented.environmentVariable}, expected ${binding.environmentVariable}`
    );
  }
  const expectedInjection = defaultComposeRuntimeSeeds.has(binding.environmentVariable)
    ? "default"
    : "explicit";
  if (documented.injection !== expectedInjection) {
    throw new Error(
      `source-contract: documented Compose injection for ${binding.environmentVariable} is `
      + `${documented.injection}, expected ${expectedInjection}`
    );
  }
}

const composeInterpolationVariables = new Set(
  [...composeSource.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)[^}]*\}/g)]
    .map((match) => match[1])
);
const missingInterpolationExamples = [...composeInterpolationVariables]
  .filter((variable) => !environmentExample.has(variable));
if (missingInterpolationExamples.length) {
  throw new Error(
    "source-contract: Compose interpolation variables missing from .env.example: "
    + JSON.stringify(missingInterpolationExamples)
  );
}
const expectedImageShowEnvironment = [
  "DATABASE_NAME",
  "DATABASE_USER",
  "DATABASE_PASSWORD",
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "SITE_DOMAIN"
];
assertSameSet(
  "source-contract: ImageShow default Compose environment whitelist drifted",
  new Set(imageShowEnvironment.keys()),
  new Set(expectedImageShowEnvironment)
);
const postgresqlService = composeService(compose, "postgresql");
const postgresqlEnvironment = composeEnvironment(postgresqlService);
assertSameSet(
  "source-contract: PostgreSQL default Compose environment whitelist drifted",
  new Set(postgresqlEnvironment.keys()),
  new Set(["POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"])
);
for (const [applicationKey, postgresqlKey, variable, defaultValue] of [
  ["DATABASE_NAME", "POSTGRES_DB", "DATABASE_NAME", "imageshow"],
  ["DATABASE_USER", "POSTGRES_USER", "DATABASE_USER", "imageshow"]
]) {
  const interpolation = "${" + variable + ":-" + defaultValue + "}";
  if (imageShowEnvironment.get(applicationKey) !== interpolation) {
    throw new Error(`source-contract: ImageShow ${applicationKey} must use ${interpolation}`);
  }
  if (postgresqlEnvironment.get(postgresqlKey) !== interpolation) {
    throw new Error(`source-contract: PostgreSQL ${postgresqlKey} must use ${interpolation}`);
  }
}
const requiredDatabasePassword = "${DATABASE_PASSWORD:?}";
if (imageShowEnvironment.get("DATABASE_PASSWORD") !== requiredDatabasePassword) {
  throw new Error("source-contract: ImageShow database password must be required without a default");
}
if (postgresqlEnvironment.get("POSTGRES_PASSWORD") !== requiredDatabasePassword) {
  throw new Error("source-contract: PostgreSQL password must share the required database password");
}
if (imageShowEnvironment.get("ADMIN_USERNAME") !== "${ADMIN_USERNAME:-admin}") {
  throw new Error("source-contract: default Compose administrator username drifted");
}
if (imageShowEnvironment.get("ADMIN_PASSWORD") !== "${ADMIN_PASSWORD:?}") {
  throw new Error("source-contract: administrator password must be required without a default");
}
const securityOptions = new Set((imageShowService.security_opt ?? []).map(String));
if (!securityOptions.has("no-new-privileges:true")) {
  throw new Error("source-contract: ImageShow default Compose privilege hardening drifted");
}
const redisService = composeService(compose, "redis");
if (composeEnvironment(redisService).size !== 0) {
  throw new Error("source-contract: Redis default Compose environment must be empty");
}
if (!composeVolumeMount(redisService, {
  source: "./redis",
  target: "/data",
  type: "bind"
})) {
  throw new Error("source-contract: default Compose Redis must retain its data bind mount");
}
if (!composeVolumeMount(
  postgresqlService,
  {
    source: "./postgres",
    target: "/var/lib/postgresql",
    type: "bind"
  }
)) {
  throw new Error("source-contract: default Compose PostgreSQL must retain its data bind mount");
}
if (!composeVolumeMount(imageShowService, {
  source: "./data",
  target: "/app/data",
  type: "bind"
})) {
  throw new Error("source-contract: default Compose ImageShow must retain its data bind mount");
}
if (!composePortBinding(imageShowService, {
  hostIp: "127.0.0.1",
  published: 5518,
  target: 5518
})) {
  throw new Error("source-contract: default Compose port mapping must stay fixed at 127.0.0.1:5518:5518");
}

console.log(
  `source-contract: ${files.length} modules, ${components.length} dependency cycles, `
  + `${runtimeDefaultPaths.size} runtime config leaves`
);
