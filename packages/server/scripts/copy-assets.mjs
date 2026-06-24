import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const repo = resolve(pkg, "..", "..");
const serverDist = resolve(pkg, "dist");
const remixIconNames = [
  "arrow-go-back-line",
  "arrow-left-right-line",
  "checkbox-circle-line",
  "check-line",
  "close-line",
  "cloud-line",
  "dashboard-line",
  "database-2-line",
  "delete-bin-6-line",
  "delete-bin-7-line",
  "external-link-line",
  "eye-line",
  "file-copy-line",
  "file-damage-line",
  "fingerprint-line",
  "flask-line",
  "hard-drive-2-line",
  "home-4-line",
  "image-line",
  "information-line",
  "logout-box-r-line",
  "menu-line",
  "pencil-line",
  "refresh-line",
  "save-3-line",
  "settings-3-line",
  "shuffle-line",
  "upload-cloud-2-line"
];

async function findSvgFiles(root) {
  const files = new Map();
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".svg")) {
        files.set(entry.name.replace(/\.svg$/, ""), fullPath);
      }
    }
  }
  await walk(root);
  return files;
}

function importPath(fromFile, targetFile) {
  const path = relative(dirname(fromFile), targetFile).split(sep).join("/");
  return path.startsWith(".") ? path : `./${path}`;
}

async function rewriteWorkspaceImports(root) {
  const sharedEntry = resolve(repo, "packages", "shared", "dist", "app-config.js");

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".js")) {
        const source = await readFile(fullPath, "utf8");
        const rewritten = source.replace(/(["'])@imageshow\/shared\1/g, (_match, quote) => `${quote}${importPath(fullPath, sharedEntry)}${quote}`);
        if (rewritten !== source) await writeFile(fullPath, rewritten);
      }
    }
  }

  await walk(root);
}

await mkdir(serverDist, { recursive: true });
await rewriteWorkspaceImports(serverDist);
await rm(resolve(serverDist, "migrations"), { recursive: true, force: true });
await rm(resolve(serverDist, "public"), { recursive: true, force: true });
await cp(resolve(pkg, "migrations"), resolve(serverDist, "migrations"), { recursive: true });
const webDist = resolve(repo, "packages", "web", "dist");
if (existsSync(webDist)) {
  await cp(webDist, resolve(serverDist, "public"), { recursive: true });
}
const remixIcon = resolve(repo, "node_modules", "remixicon");
if (existsSync(remixIcon)) {
  const icons = await findSvgFiles(resolve(remixIcon, "icons"));
  const targetDir = resolve(serverDist, "public", "assets", "remixicon", "v4.9.1");
  await mkdir(targetDir, { recursive: true });
  for (const name of remixIconNames) {
    const source = icons.get(name);
    if (!source) throw new Error(`Missing Remix Icon SVG: ${name}`);
    await copyFile(source, resolve(targetDir, `${name}.svg`));
  }
}
