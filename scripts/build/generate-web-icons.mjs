import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..", "..");
const webPackage = resolve(repo, "packages", "web");
const iconDirectory = resolve(webPackage, "src", "components", "icon");
const checkOnly = process.argv.slice(2).includes("--check");
const unknownArguments = process.argv.slice(2).filter((argument) => (
  argument !== "--check"
));
if (unknownArguments.length > 0) {
  throw new Error(`Unknown generate-icons arguments: ${unknownArguments.join(", ")}`);
}

const iconGroups = [
  {
    label: "common",
    outFile: resolve(iconDirectory, "icons.generated.ts"),
    exportName: "ICONS",
    typeName: "IconName",
    names: [
      "arrow-down-s-line",
      "arrow-up-line",
      "check-line",
      "close-line",
      "external-link-line",
      "eye-line",
      "eye-off-line",
      "file-copy-line",
      "file-damage-line",
      "filter-3-line",
      "home-4-line",
      "image-line",
      "menu-line",
      "pencil-line",
      "refresh-line",
      "settings-3-line"
    ]
  },
  {
    label: "admin",
    outFile: resolve(iconDirectory, "admin-icons.generated.ts"),
    exportName: "ADMIN_ICONS",
    typeName: "AdminOnlyIconName",
    names: [
      "add-line",
      "arrow-go-back-line",
      "arrow-left-right-line",
      "checkbox-circle-line",
      "computer-line",
      "dashboard-line",
      "database-2-line",
      "delete-bin-2-line",
      "delete-bin-6-line",
      "delete-bin-7-line",
      "download-cloud-2-line",
      "drag-move-2-fill",
      "file-list-line",
      "flask-line",
      "group-line",
      "hard-drive-2-line",
      "history-line",
      "information-line",
      "key-2-line",
      "link",
      "image-download-line",
      "logout-box-r-line",
      "moon-line",
      "palette-line",
      "price-tag-3-line",
      "quill-pen-line",
      "save-3-line",
      "shuffle-line",
      "star-fill",
      "star-line",
      "sun-line",
      "upload-cloud-2-line",
      "user-add-line",
      "weibo-line"
    ]
  }
];

const iconNames = iconGroups.flatMap((group) => group.names);
if (new Set(iconNames).size !== iconNames.length) {
  throw new Error("Icon groups contain duplicate names");
}

const remixDir = [
  resolve(repo, "node_modules", "remixicon"),
  resolve(webPackage, "node_modules", "remixicon")
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

const entryByName = new Map();
const nameByPath = new Map();
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
  const path = pathData[1];
  const duplicateName = nameByPath.get(path);
  if (duplicateName) {
    throw new Error(`Icons "${duplicateName}" and "${name}" use the same path`);
  }
  nameByPath.set(path, name);
  entryByName.set(name, path);
}

function generatedSource(group) {
  const body = [...group.names]
    .sort()
    .map((name) => `  ${JSON.stringify(name)}: ${JSON.stringify(entryByName.get(name))}`)
    .join(",\n");
  return `export const ${group.exportName} = {
${body}
} as const;

export type ${group.typeName} = keyof typeof ${group.exportName};
`;
}

if (checkOnly) {
  const stale = [];
  for (const group of iconGroups) {
    const current = await readFile(group.outFile, "utf8").catch(() => "");
    if (current !== generatedSource(group)) stale.push(group.outFile);
  }
  if (stale.length > 0) {
    throw new Error(
      "Generated icon sources are stale; run `npm run icons:generate`: "
      + stale.map((file) => file.replace(`${repo}\\`, "")).join(", ")
    );
  }
  console.log(
    `generate-icons: verified ${iconGroups.map((group) => `${group.names.length} ${group.label}`).join(" and ")} icons`
  );
} else {
  await Promise.all(iconGroups.map((group) => (
    writeFile(group.outFile, generatedSource(group))
  )));
  console.log(
    `generate-icons: wrote ${iconGroups.map((group) => `${group.names.length} ${group.label}`).join(" and ")} icons without duplicate paths`
  );
}
