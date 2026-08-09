import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../..");

async function markdownFiles() {
  const files = [resolve(workspaceRoot, "README.md")];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (extname(entry.name).toLowerCase() === ".md") files.push(path);
    }
  }
  await walk(resolve(workspaceRoot, "docs"));
  return files;
}

function displayPath(path) {
  return relative(workspaceRoot, path).replaceAll("\\", "/");
}

function localTarget(rawTarget) {
  const target = rawTarget.trim().replace(/^<|>$/g, "");
  if (
    !target
    || target.startsWith("#")
    || target.startsWith("/")
    || /^[a-z][a-z\d+.-]*:/i.test(target)
    || target.startsWith("//")
  ) return null;
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
    try {
      await stat(resolved);
    } catch {
      missing.push(`${displayPath(file)} -> ${match[1]}`);
    }
  }
}

if (missing.length > 0) {
  throw new Error(`markdown-links: missing local targets:\n${missing.join("\n")}`);
}
console.log(`markdown-links: ${checkedLinks} local links across ${files.length} files`);
