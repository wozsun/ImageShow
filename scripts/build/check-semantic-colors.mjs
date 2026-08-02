import fs from "node:fs";
import path from "node:path";

const workspaceRoot = path.resolve(import.meta.dirname, "../..");
const webRoot = path.join(workspaceRoot, "packages/web");
const sourceRoot = path.join(webRoot, "src");
const publicRoot = path.join(webRoot, "public");
const publicSemanticFile = path.join(
  sourceRoot,
  "styles/semantic-colors.css"
);
const adminSemanticFile = path.join(
  sourceRoot,
  "styles/admin/semantic-colors.css"
);
const indexFile = path.join(webRoot, "index.html");
const semanticFiles = new Set([publicSemanticFile, adminSemanticFile]);
const rawColorAssetWhitelist = new Set([
  path.join(publicRoot, "assets/brand/favicon.svg")
]);
const sourceExtensions = new Set([".css", ".html", ".svg", ".ts", ".tsx"]);
const rawColorPattern =
  /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|device-cmyk)\s*\([^)]*\)/gi;
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
const retiredColorAliasPattern =
  /--(?:public-(?:space-(?:black|deep|surface|raised)|text|muted|line|blue(?:-strong|-soft)?|pink)|browser-surface(?:-dark|-light)?|home-(?:ink|muted|line|primary(?:-strong|-soft)?|accent|card)|gallery-sky-(?:left|blue)|image-detail-public-(?:surface|raised))\b/g;
const hueNamedSemanticTokenPattern =
  /-(?:black|white|red|orange|yellow|green|teal|cyan|blue|indigo|purple|violet|pink|rose|brown|gr[ae]y|slate)(?:-|$)/i;
const semanticDefinitionPattern =
  /(--(?:bootstrap-color|public-color|public-shadow|admin-color|admin-shadow|color)-[\w-]+)\s*:/g;
const semanticReferencePattern =
  /var\((--(?:bootstrap-color|public-color|public-shadow|admin-color|admin-shadow|color)-[\w-]+)/g;
const adminStatusTokenPattern =
  /^--admin-color-(success|warning|danger|pending)-(.+)$/;
const allowedAdminInteractionStatusTokens = new Set([
  "--admin-color-control-changed",
  "--admin-color-control-changed-emphasis",
  "--admin-color-control-changed-ring",
  "--admin-color-control-changed-surface"
]);
const adminStatusWords = [
  "success(?:ful)?",
  "succeeded",
  "warn(?:ing)?s?",
  "danger(?:ous)?",
  "pending",
  "errors?",
  "invalid",
  "fail(?:ed|ures?)?",
  "info(?:rmational)?",
  "new",
  "changed",
  "dirty",
  "blocked",
  "created",
  "ready",
  "done",
  "completed?",
  "finalized",
  "missing",
  "stale",
  "queued",
  "waiting",
  "processing",
  "preparing",
  "materializing",
  "uploading",
  "downloading",
  "received",
  "committing",
  "cancel(?:l?ed|l?ing)"
];
const adminStatusWordPattern = new RegExp(
  `(?:^|-)(?:${adminStatusWords.join("|")})(?:-|$)`
);
const allowedAdminStatusRoles = new Map([
  [
    "success",
    new Set([
      "text",
      "text-strong",
      "text-emphasis",
      "surface",
      "surface-soft",
      "surface-subtle",
      "surface-emphasis",
      "surface-hover",
      "border",
      "border-soft",
      "border-strong",
      "progress",
      "action",
      "action-hover"
    ])
  ],
  [
    "warning",
    new Set([
      "text",
      "text-strong",
      "text-soft",
      "action",
      "surface",
      "surface-soft",
      "surface-subtle",
      "surface-emphasis",
      "surface-strong",
      "progress",
      "border",
      "border-soft",
      "border-strong"
    ])
  ],
  [
    "danger",
    new Set([
      "text",
      "text-strong",
      "surface",
      "surface-hover",
      "progress",
      "border",
      "border-strong",
      "border-subtle",
      "action",
      "action-hover"
    ])
  ],
  [
    "pending",
    new Set([
      "text",
      "text-strong",
      "text-soft",
      "text-subtle",
      "surface",
      "surface-soft",
      "surface-subtle",
      "progress",
      "border",
      "border-soft",
      "border-subtle"
    ])
  ]
]);
const overSpecificAdminStatusTokenPattern =
  /^--admin-color-(?:query-error(?:-|$)|control-(?:invalid|new)(?:-|$)|edit-row-changed(?:-|$)|import-|upload-report(?:-|$))/;

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

export function findRawColorLiterals(source) {
  return [...source.matchAll(rawColorPattern)].map((match) => match[0]);
}

export function findNamedColorLiterals(source) {
  return [...source.matchAll(namedColorPattern)].map((match) => match[0]);
}

export function isRawColorAssetWhitelisted(file) {
  return rawColorAssetWhitelist.has(path.resolve(file));
}

export function isAllowedAdminStatusToken(token) {
  if (!token.startsWith("--admin-color-")) return true;
  if (allowedAdminInteractionStatusTokens.has(token)) return true;
  const match = token.match(adminStatusTokenPattern);
  if (!match) return !adminStatusWordPattern.test(token);
  return allowedAdminStatusRoles.get(match[1])?.has(match[2]) === true;
}

export function isOverSpecificAdminStatusToken(token) {
  return overSpecificAdminStatusTokenPattern.test(token);
}

const sourceFiles = [
  ...listSourceFiles(sourceRoot),
  ...listSourceFiles(publicRoot),
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

for (const [file, source] of sources) {
  if (semanticFiles.has(file) || rawColorAssetWhitelist.has(file)) continue;
  for (
    const occurrence of collectMatches(file, source, rawColorPattern)
  ) {
    if (
      file === indexFile
      && occurrence.match.index === themeColorValueOffset
    ) {
      continue;
    }
    errors.push(
      `${displayPath(file)}:${occurrence.line} contains a raw color `
      + `outside the semantic sheets or bootstrap theme-color meta: `
      + occurrence.match[0]
    );
  }
  for (const occurrence of collectMatches(file, source, namedColorPattern)) {
    errors.push(
      `${displayPath(file)}:${occurrence.line} contains named color `
      + occurrence.match[0]
    );
  }
  for (
    const occurrence of collectMatches(
      file,
      source,
      retiredColorAliasPattern
    )
  ) {
    errors.push(
      `${displayPath(file)}:${occurrence.line} contains retired color alias `
      + occurrence.match[0]
    );
  }
}

if (!bootstrapMatch || !themeColorMatch) {
  errors.push("Bootstrap canvas and theme-color must both be explicit hex values");
} else if (bootstrapMatch[1].toLowerCase() !== themeColorMatch[1].toLowerCase()) {
  errors.push("Bootstrap canvas and initial theme-color do not match");
}
if (
  !/<html\b[^>]*data-ui-context="bootstrap"[^>]*data-color-scheme="dark"/
    .test(indexSource)
) {
  errors.push("index.html must start in the dark bootstrap UI context");
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
    if (!semanticFiles.has(file)) {
      errors.push(
        `${displayPath(file)}:${line} defines semantic token ${token} `
        + "outside a semantic color sheet"
      );
    }
    if (hueNamedSemanticTokenPattern.test(token)) {
      errors.push(
        `${displayPath(file)}:${line} names semantic token ${token} by hue`
      );
    }
    if (!isAllowedAdminStatusToken(token)) {
      errors.push(
        `${displayPath(file)}:${line} defines noncanonical admin `
        + `status role ${token}`
      );
    }
    else if (isOverSpecificAdminStatusToken(token)) {
      errors.push(
        `${displayPath(file)}:${line} defines page- or lifecycle-specific `
        + `status token ${token}`
      );
    }
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
