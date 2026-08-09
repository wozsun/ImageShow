import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const manifestPaths = [
  "package.json",
  "packages/shared/package.json",
  "packages/server/package.json",
  "packages/web/package.json"
];

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--tag" && argument !== "--branch") {
      throw new Error(`version-contract: unknown argument ${argument}`);
    }
    const value = arguments_[index + 1];
    if (!value) throw new Error(`version-contract: ${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(workspaceRoot, path), "utf8"));
}

const options = parseArguments(process.argv.slice(2));
const manifests = await Promise.all(manifestPaths.map(readJson));
const versions = manifests.map((manifest) => manifest.version);
const version = versions[0];
if (
  typeof version !== "string"
  || !/^\d+\.\d+\.\d+$/.test(version)
  || versions.some((candidate) => candidate !== version)
) {
  throw new Error(
    `version-contract: package versions differ: ${JSON.stringify(
      Object.fromEntries(manifestPaths.map((path, index) => [path, versions[index]]))
    )}`
  );
}

const lock = await readJson("package-lock.json");
const lockVersions = {
  "package-lock.json": lock.version,
  "package-lock.json#packages['']": lock.packages?.[""]?.version,
  ...Object.fromEntries(
    manifestPaths.slice(1).map((path) => {
      const workspacePath = path.slice(0, -"/package.json".length);
      return [`package-lock.json#packages['${workspacePath}']`, lock.packages?.[workspacePath]?.version];
    })
  )
};
const invalidLockVersions = Object.entries(lockVersions)
  .filter(([, candidate]) => candidate !== version);
if (invalidLockVersions.length > 0) {
  throw new Error(
    `version-contract: lockfile versions must all equal ${version}: `
    + JSON.stringify(Object.fromEntries(invalidLockVersions))
  );
}

if (options.tag) {
  const expectedTag = `v${version}`;
  if (options.tag !== expectedTag) {
    throw new Error(
      `version-contract: tag ${options.tag} does not match ${expectedTag}`
    );
  }
}

if (options.branch) {
  const currentBranch = process.env.GITHUB_REF_NAME;
  const refType = process.env.GITHUB_REF_TYPE;
  if (!currentBranch || refType !== "branch") {
    throw new Error(
      "version-contract: --branch requires a GitHub branch ref environment"
    );
  }
  if (currentBranch !== options.branch) {
    throw new Error(
      `version-contract: branch ${currentBranch} does not match ${options.branch}`
    );
  }
}

console.log(
  `version-contract: ${version}; ${manifestPaths.length} manifests and lockfile agree`
);
