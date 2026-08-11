import { readdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { selectorSafelist } from "./selector-safelist.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const webSourceRoot = resolve(workspaceRoot, "packages/web/src");
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".html"]);

async function filesUnder(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(path);
    }
  }
  await walk(root);
  return files;
}

function stripCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

function selectorsFromCss(source) {
  const selectors = new Set();
  const clean = stripCssComments(source);
  let segmentStart = 0;
  for (let index = 0; index < clean.length; index += 1) {
    const current = clean[index];
    if (current === ";" || current === "}") {
      segmentStart = index + 1;
      continue;
    }
    if (current !== "{") continue;
    const prelude = clean.slice(segmentStart, index).trim();
    segmentStart = index + 1;
    if (!prelude || prelude.startsWith("@")) continue;
    for (const match of prelude.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z\d-]*)/g)) {
      selectors.add(match[1]);
    }
  }
  return selectors;
}

function tokenAppears(source, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^_a-zA-Z\\d-])${escaped}(?=$|[^_a-zA-Z\\d-])`).test(source);
}

function safelisted(selector) {
  return selectorSafelist.exact.has(selector);
}

const files = await filesUnder(webSourceRoot);
const cssFiles = files.filter((file) => extname(file).toLowerCase() === ".css");
const sourceFiles = files.filter((file) => sourceExtensions.has(extname(file).toLowerCase()));
const sourceText = (await Promise.all(sourceFiles.map((file) => readFile(file, "utf8"))))
  .map((source) => source.replace(/^\s*import\s+["'][^"']+\.css["'];?\s*$/gm, ""))
  .join("\n");

const selectors = new Set();
for (const file of cssFiles) {
  for (const selector of selectorsFromCss(await readFile(file, "utf8"))) {
    selectors.add(selector);
  }
}

const unused = [...selectors]
  .filter((selector) => !tokenAppears(sourceText, selector) && !safelisted(selector));
const staleExactSafelist = [...selectorSafelist.exact]
  .filter((selector) => !selectors.has(selector));
if (unused.length > 0 || staleExactSafelist.length > 0) {
  throw new Error(
    "selector-inventory: unused selectors or stale safelist entries:\n"
    + JSON.stringify({ unused, staleExactSafelist }, null, 2)
  );
}

console.log(
  `selector-inventory: ${selectors.size} classes across ${cssFiles.length} stylesheets; `
  + `${selectorSafelist.exact.size} exact safelist entries`
);
