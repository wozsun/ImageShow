import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const repo = resolve(pkg, "..", "..");
const outFile = resolve(pkg, "src", "components", "icon", "icons.generated.ts");

const iconNames = [
  "add-line",
  "arrow-down-s-line",
  "arrow-go-back-line",
  "arrow-left-right-line",
  "check-line",
  "checkbox-circle-line",
  "close-line",
  "dashboard-line",
  "database-2-line",
  "delete-bin-6-line",
  "delete-bin-7-line",
  "download-cloud-2-line",
  "drag-move-2-fill",
  "external-link-line",
  "eye-line",
  "eye-off-line",
  "file-copy-line",
  "file-damage-line",
  "filter-3-line",
  "fingerprint-line",
  "flask-line",
  "group-line",
  "hard-drive-2-line",
  "home-4-line",
  "image-line",
  "information-line",
  "key-2-line",
  "logout-box-r-line",
  "menu-line",
  "palette-line",
  "pencil-line",
  "price-tag-3-line",
  "quill-pen-line",
  "refresh-line",
  "save-3-line",
  "scales-3-line",
  "settings-3-line",
  "shuffle-line",
  "star-fill",
  "star-line",
  "upload-cloud-2-line",
  "user-add-line"
];

const remixDir = [
  resolve(repo, "node_modules", "remixicon"),
  resolve(pkg, "node_modules", "remixicon")
].find(existsSync);
if (!remixDir) throw new Error("remixicon is not installed — run `npm install` first");

async function indexSvgsByName(root) {
  const index = new Map();
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".svg")) index.set(entry.name.replace(/\.svg$/, ""), full);
    }
  }
  await walk(root);
  return index;
}

const svgByName = await indexSvgsByName(resolve(remixDir, "icons"));

const entries = [];
for (const name of [...iconNames].sort()) {
  const file = svgByName.get(name);
  if (!file) throw new Error(`Missing Remix Icon SVG: ${name}`);
  const svg = await readFile(file, "utf8");

  // 当前图标组件只内联单个 path。
  const drawables = [...svg.matchAll(/<(path|circle|rect|g|polygon|line|ellipse|polyline)\b/g)];
  const pathData = svg.match(/<path\b[^>]*\bd="([^"]+)"/);
  if (drawables.length !== 1 || !pathData) {
    throw new Error(`Icon "${name}" is not a single <path> (found ${drawables.length} drawable element(s)); the inline path-map can't represent it`);
  }
  entries.push([name, pathData[1]]);
}

const body = entries.map(([name, d]) => `  ${JSON.stringify(name)}: ${JSON.stringify(d)}`).join(",\n");
const out = `export const ICONS = {
${body}
} as const;

export type IconName = keyof typeof ICONS;
`;

await writeFile(outFile, out);
console.log(`generate-icons: wrote ${entries.length} icons to ${outFile.replace(repo, ".")}`);
