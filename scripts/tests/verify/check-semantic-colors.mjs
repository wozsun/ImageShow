import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");
const webRoot = path.join(workspaceRoot, "packages/web");
const sourceRoot = path.join(webRoot, "src");
const publicSemanticFile = path.join(
  sourceRoot,
  "styles/semantic-colors.css"
);
const indexFile = path.join(webRoot, "index.html");
const sourceExtensions = new Set([".css", ".html", ".svg", ".ts", ".tsx"]);
const rawColorPattern =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|device-cmyk)\s*\([^)]*\)|\bcolor\s*\(\s*(?:from\b|(?:srgb(?:-linear)?|display-p3(?:-linear)?|a98-rgb|prophoto-rgb|rec2020|xyz(?:-d50|-d65)?)\b|--[\w-]+)[^)]*\)/gi;
const cssNamedColors = [
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige",
  "bisque", "black", "blanchedalmond", "blue", "blueviolet", "brown",
  "burlywood", "cadetblue", "chartreuse", "chocolate", "coral",
  "cornflowerblue", "cornsilk", "crimson", "cyan", "darkblue",
  "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey",
  "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid",
  "darkred", "darksalmon", "darkseagreen", "darkslateblue",
  "darkslategray", "darkslategrey", "darkturquoise", "darkviolet",
  "deeppink", "deepskyblue", "dimgray", "dimgrey", "dodgerblue",
  "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro",
  "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow",
  "grey", "honeydew", "hotpink", "indianred", "indigo", "ivory",
  "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon",
  "lightblue", "lightcoral", "lightcyan", "lightgoldenrodyellow",
  "lightgray", "lightgreen", "lightgrey", "lightpink", "lightsalmon",
  "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey",
  "lightsteelblue", "lightyellow", "lime", "limegreen", "linen",
  "magenta", "maroon", "mediumaquamarine", "mediumblue",
  "mediumorchid", "mediumpurple", "mediumseagreen", "mediumslateblue",
  "mediumspringgreen", "mediumturquoise", "mediumvioletred",
  "midnightblue", "mintcream", "mistyrose", "moccasin", "navajowhite",
  "navy", "oldlace", "olive", "olivedrab", "orange", "orangered",
  "orchid", "palegoldenrod", "palegreen", "paleturquoise",
  "palevioletred", "papayawhip", "peachpuff", "peru", "pink", "plum",
  "powderblue", "purple", "rebeccapurple", "red", "rosybrown",
  "royalblue", "saddlebrown", "salmon", "sandybrown", "seagreen",
  "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray",
  "slategrey", "snow", "springgreen", "steelblue", "tan", "teal",
  "thistle", "tomato", "turquoise", "violet", "wheat", "white",
  "whitesmoke", "yellow", "yellowgreen"
];
const namedColorPattern = new RegExp(
  `(?<![-\\w])(${cssNamedColors.join("|")})(?![-\\w])`,
  "gi"
);
const semanticDefinitionPattern =
  /(--(?:bootstrap-color|public-color|public-shadow|admin-color|admin-shadow|color)-[\w-]+)\s*:/g;
const semanticReferencePattern =
  /var\((--(?:bootstrap-color|public-color|public-shadow|admin-color|admin-shadow|color)-[\w-]+)/g;
const semanticDeclarationPattern =
  /--(?:bootstrap-color|public-color|public-shadow|admin-color|admin-shadow|color)-[\w-]+\s*:\s*[^;]+;/g;
function listSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(item));
    else if (sourceExtensions.has(path.extname(entry.name))) files.push(item);
  }
  return files;
}

function displayPath(file) {
  return path.relative(workspaceRoot, file).replaceAll("\\", "/");
}

function lineNumberAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function collectMatches(file, source, pattern) {
  return [...source.matchAll(pattern)].map((match) => ({
    file,
    line: lineNumberAt(source, match.index),
    match
  }));
}

function semanticDeclarationRanges(source) {
  return [...source.matchAll(semanticDeclarationPattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length
  }));
}

function isInsideSemanticDeclaration(ranges, offset) {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}

// Check color syntax with the same matcher used by the source scan.
assert.deepEqual(
  collectMatches(
    "color-syntax-fixture",
    "new Color(styles.getPropertyValue(token).trim())",
    rawColorPattern
  ),
  []
);
assert.deepEqual(
  collectMatches("color-syntax-fixture", 'new Color("#123456")', rawColorPattern)
    .map(({ match }) => match[0]),
  ["#123456"]
);
for (const literal of [
  "color(srgb 1 0 0)", "COLOR(display-p3 1 0 0 / .5)",
  "color(from var(--source) srgb r g b)", "color(--profile .1 .2 .3)",
  "rgb(10 20 30)", "oklch(60% .2 30)"
]) {
  assert.equal(
    collectMatches("color-syntax-fixture", literal, rawColorPattern).length,
    1,
    literal
  );
}

const sourceFiles = [
  ...listSourceFiles(sourceRoot),
  indexFile
];
const sources = new Map(
  sourceFiles.map((file) => [file, fs.readFileSync(file, "utf8")])
);
const errors = [];
const publicSemanticSource = sources.get(publicSemanticFile);
const bootstrapMatch = publicSemanticSource.match(
  /--bootstrap-color-canvas\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/
);
const indexSource = sources.get(indexFile);
const themeColorMatch = indexSource.match(
  /<meta\s+name="theme-color"\s+content="(#[0-9a-fA-F]{3,8})"\s*\/>/
);
const themeColorValueOffset = themeColorMatch
  ? themeColorMatch.index + themeColorMatch[0].indexOf(themeColorMatch[1])
  : -1;

function hexRgb(value) {
  const hex = value.slice(1);
  if (hex.length !== 6) return null;
  return [0, 2, 4].map((offset) => Number.parseInt(
    hex.slice(offset, offset + 2),
    16
  ));
}

function relativeLuminance(value) {
  const rgb = hexRgb(value);
  if (!rgb) return null;
  const channels = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126
    + channels[1] * 0.7152
    + channels[2] * 0.0722;
}

function contrastRatio(first, second) {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  if (firstLuminance === null || secondLuminance === null) return null;
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

for (const [file, source] of sources) {
  if (file.endsWith("semantic-colors.css")) {
    continue;
  }
  const declarationRanges = file.endsWith(".css")
    ? semanticDeclarationRanges(source)
    : [];
  for (
    const occurrence of collectMatches(file, source, rawColorPattern)
  ) {
    if (
      file === indexFile
      && occurrence.match.index === themeColorValueOffset
    ) {
      continue;
    }
    if (isInsideSemanticDeclaration(declarationRanges, occurrence.match.index)) {
      continue;
    }
    errors.push(
      `${displayPath(file)}:${occurrence.line} contains a raw color `
      + `outside the semantic sheets or bootstrap theme-color meta: `
      + occurrence.match[0]
    );
  }
  for (const occurrence of collectMatches(file, source, namedColorPattern)) {
    if (isInsideSemanticDeclaration(declarationRanges, occurrence.match.index)) {
      continue;
    }
    errors.push(
      `${displayPath(file)}:${occurrence.line} contains named color `
      + occurrence.match[0]
    );
  }
}

if (!bootstrapMatch || !themeColorMatch) {
  errors.push("Bootstrap canvas and theme-color must both be explicit hex values");
} else if (bootstrapMatch[1].toLowerCase() !== themeColorMatch[1].toLowerCase()) {
  errors.push("Bootstrap canvas and initial theme-color do not match");
}
if (bootstrapMatch) {
  for (const token of [
    "--bootstrap-color-text",
    "--bootstrap-color-feedback-success-text",
    "--bootstrap-color-feedback-danger-text",
    "--bootstrap-color-feedback-error-text"
  ]) {
    const match = publicSemanticSource.match(
      new RegExp(`${token}\\s*:\\s*(#[0-9a-fA-F]{6})\\s*;`)
    );
    const ratio = match
      ? contrastRatio(match[1], bootstrapMatch[1])
      : null;
    if (ratio === null || ratio < 4.5) {
      errors.push(
        `${token} must be an explicit six-digit hex color with at least `
        + "4.5:1 contrast against the bootstrap canvas"
      );
    }
  }
}
const definitions = new Map();
const referenceCounts = new Map();
for (const [file, source] of sources) {
  for (const { line, match } of collectMatches(
    file,
    source,
    semanticDefinitionPattern
  )) {
    const token = match[1];
    const previous = definitions.get(token);
    if (previous && !token.startsWith("--color-")) {
      errors.push(
        `${displayPath(file)}:${line} duplicates ${token}, first defined at `
        + `${displayPath(previous[0].file)}:${previous[0].line}`
      );
    }
    definitions.set(token, [...(previous ?? []), { file, line }]);
  }
  for (const { line, match } of collectMatches(
    file,
    source,
    semanticReferencePattern
  )) {
    const token = match[1];
    referenceCounts.set(token, (referenceCounts.get(token) ?? 0) + 1);
    if (
      file.startsWith(path.join(sourceRoot, "styles/admin"))
      && token.startsWith("--public-")
    ) {
      errors.push(
        `${displayPath(file)}:${line} makes admin styles depend on ${token}`
      );
    }
    if (
      file.endsWith(".css")
      && !file.startsWith(path.join(sourceRoot, "styles/admin"))
      && token.startsWith("--admin-")
    ) {
      errors.push(
        `${displayPath(file)}:${line} makes public styles depend on ${token}`
      );
    }
  }
}

for (const [token, count] of referenceCounts) {
  if (count > 0 && !definitions.has(token)) {
    errors.push(`Semantic token ${token} is referenced but not defined`);
  }
}
for (const [token, tokenDefinitions] of definitions) {
  if (!referenceCounts.has(token)) {
    for (const definition of tokenDefinitions) {
      errors.push(
        `${displayPath(definition.file)}:${definition.line} defines unused `
        + `semantic token ${token}`
      );
    }
  }
}

if (errors.length > 0) {
  console.error("Semantic color check failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(
    `Semantic color check passed (${definitions.size} tokens, `
    + `${sourceFiles.length} source files).`
  );
}
