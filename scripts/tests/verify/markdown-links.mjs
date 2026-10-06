import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

async function markdownFiles() {
  const files = [
    resolve(workspaceRoot, "README.md"),
    resolve(workspaceRoot, "AGENTS.md"),
    resolve(workspaceRoot, "scripts/tests/README.md")
  ];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (extname(entry.name).toLowerCase() === ".md") files.push(path);
    }
  }
  // Only these .agents directories are tracked; see .gitignore.
  for (const directory of ["docs", ".agents/spec", ".agents/process", ".agents/reference"]) {
    await walk(resolve(workspaceRoot, directory));
  }
  return files;
}

// A link must resolve in a fresh clone, so a target has to exist on disk and
// be a file Git tracks or would track (untracked but not ignored). The index
// alone is not enough: it still lists files deleted but not yet staged, and the
// gate runs before staging.
function repositoryPaths() {
  const listing = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: workspaceRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
  );
  const paths = new Set();
  for (const file of listing.split("\0")) {
    if (!file) continue;
    paths.add(file);
    for (let directory = dirname(file); directory !== "."; directory = dirname(directory)) {
      paths.add(directory);
    }
  }
  return paths;
}

function displayPath(path) {
  return relative(workspaceRoot, path).replaceAll("\\", "/");
}

function localTarget(rawTarget) {
  const target = rawTarget.trim().replace(/^<|>$/g, "");
  if (
    !target ||
    target.startsWith("#") ||
    target.startsWith("/") ||
    /^[a-z][a-z\d+.-]*:/i.test(target)
  )
    return null;
  const withoutFragment = target.split("#", 1)[0].split("?", 1)[0];
  if (!withoutFragment) return null;
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    throw new Error(`markdown-links: invalid URL encoding in ${rawTarget}`);
  }
}

const missing = [];
let checkedLinks = 0;
const linkPattern = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;
const repository = repositoryPaths();
const files = await markdownFiles();
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(linkPattern)) {
    const target = localTarget(match[1]);
    if (!target) continue;
    checkedLinks += 1;
    const resolved = resolve(dirname(file), target);
    const relativeTarget = relative(workspaceRoot, resolved);
    if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
      missing.push(`${displayPath(file)} -> ${match[1]} (outside workspace)`);
      continue;
    }
    const exists = await stat(resolved).then(() => true, () => false);
    if (!exists) {
      missing.push(`${displayPath(file)} -> ${match[1]}`);
    } else if (!repository.has(relativeTarget.replaceAll("\\", "/"))) {
      missing.push(`${displayPath(file)} -> ${match[1]} (ignored by Git)`);
    }
  }
}

if (missing.length > 0) {
  throw new Error(`markdown-links: missing or ignored local targets:\n${missing.join("\n")}`);
}
console.log(`markdown-links: ${checkedLinks} local links across ${files.length} files`);
