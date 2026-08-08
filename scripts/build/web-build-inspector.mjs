import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashedAssetPattern(prefix, extension) {
  return new RegExp(
    `^${escapeRegularExpression(prefix)}-[A-Za-z0-9_-]{6}\\.${extension}$`
  );
}

/**
 * Reads one Vite build and exposes the small set of graph operations used by
 * the production loading-boundary gate. The inspector understands generated
 * asset relationships; project-specific ownership rules stay in the caller.
 */
export async function createWebBuildInspector(assetRoot) {
  const assetNames = await readdir(assetRoot);
  const assetNameSet = new Set(assetNames);
  const cssAssetNames = assetNames.filter((name) => name.endsWith(".css"));
  const javaScriptAssetNames = assetNames.filter((name) => name.endsWith(".js"));
  const sourceCache = new Map();

  function singleHashedAsset(prefix, extension, candidates) {
    const pattern = hashedAssetPattern(prefix, extension);
    const matches = candidates.filter((name) => pattern.test(name));
    if (matches.length !== 1) {
      throw new Error(
        `check-web-chunks: expected one ${prefix} ${extension === "js" ? "JavaScript" : "CSS"} asset, found ${matches.length}`
      );
    }
    return matches[0];
  }

  function singleCssAsset(prefix) {
    return singleHashedAsset(prefix, "css", cssAssetNames);
  }

  function requireCssAssets(prefix) {
    const pattern = hashedAssetPattern(prefix, "css");
    const matches = cssAssetNames.filter((name) => pattern.test(name));
    if (matches.length === 0) {
      throw new Error(
        `check-web-chunks: expected at least one ${prefix} CSS asset`
      );
    }
    return matches;
  }

  function singleJavaScriptAsset(prefix) {
    return singleHashedAsset(prefix, "js", javaScriptAssetNames);
  }

  async function assetSource(assetName) {
    const cached = sourceCache.get(assetName);
    if (cached !== undefined) return cached;
    const source = await readFile(resolve(assetRoot, assetName), "utf8");
    sourceCache.set(assetName, source);
    return source;
  }

  async function assertAssetsExcludeMarkers(
    assets,
    assetType,
    label,
    forbiddenMarkers
  ) {
    for (const assetName of new Set(assets)) {
      const source = await assetSource(assetName);
      for (const { pattern, description } of forbiddenMarkers) {
        if (pattern.test(source)) {
          throw new Error(
            `check-web-chunks: ${label} ${assetType} ${assetName} contains ${description}`
          );
        }
      }
    }
  }

  function staticJavaScriptDependencies(source) {
    const dependencies = new Set();
    const patterns = [
      /\bfrom\s*["']\.\/([^"']+\.js)["']/g,
      /(?:^|;)\s*import\s*["']\.\/([^"']+\.js)["']/g
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) dependencies.add(match[1]);
    }
    return [...dependencies];
  }

  function dynamicImportIndex(source, entryAsset) {
    const importMarkers = [
      `import(\`./${entryAsset}\`)`,
      `import("./${entryAsset}")`,
      `import('./${entryAsset}')`
    ];
    return importMarkers.reduce((matchIndex, marker) => {
      const candidate = source.indexOf(marker);
      return candidate < 0 || (matchIndex >= 0 && matchIndex < candidate)
        ? matchIndex
        : candidate;
    }, -1);
  }

  function viteDependencyTable(source) {
    const marker = ".f=[";
    const markerIndex = source.indexOf(marker);
    if (markerIndex < 0) {
      throw new Error(
        "check-web-chunks: public entry lacks Vite dependency table"
      );
    }
    const start = markerIndex + marker.length - 1;
    const end = source.indexOf("]", start);
    if (end < 0) {
      throw new Error(
        "check-web-chunks: public entry has an incomplete Vite dependency table"
      );
    }
    try {
      return JSON.parse(source.slice(start, end + 1));
    } catch (error) {
      throw new Error(
        "check-web-chunks: cannot parse Vite dependency table",
        { cause: error }
      );
    }
  }

  function dynamicPreloadDependencies(source, entryAsset) {
    const importIndex = dynamicImportIndex(source, entryAsset);
    if (importIndex < 0) {
      throw new Error(
        `check-web-chunks: public entry does not dynamically import ${entryAsset}`
      );
    }
    const dependencyCall = "__vite__mapDeps([";
    const dependencyStart = source.indexOf(dependencyCall, importIndex);
    const nextImport = source.indexOf("import(", importIndex + 1);
    if (
      dependencyStart < 0
      || (nextImport >= 0 && dependencyStart > nextImport)
    ) {
      throw new Error(
        `check-web-chunks: ${entryAsset} lacks an adjacent Vite preload dependency list`
      );
    }
    const indexesStart = dependencyStart + dependencyCall.length;
    const indexesEnd = source.indexOf("])", indexesStart);
    if (indexesEnd < 0) {
      throw new Error(
        `check-web-chunks: ${entryAsset} has an incomplete Vite preload dependency list`
      );
    }
    const table = viteDependencyTable(source);
    const indexesSource = source.slice(indexesStart, indexesEnd).trim();
    const indexes = indexesSource === ""
      ? []
      : indexesSource.split(",").map((value) => Number.parseInt(value, 10));
    return indexes.map((index) => {
      const dependency = table[index];
      if (typeof dependency !== "string") {
        throw new Error(
          `check-web-chunks: ${entryAsset} references missing preload index ${index}`
        );
      }
      const assetName = dependency.replace(/^assets\//, "");
      if (!assetNameSet.has(assetName)) {
        throw new Error(
          `check-web-chunks: ${entryAsset} preloads missing asset ${assetName}`
        );
      }
      return assetName;
    });
  }

  async function findStaticReachableDynamicImporter(
    rootAsset,
    targetAsset,
    label
  ) {
    const pending = [rootAsset];
    const visited = new Set();
    while (pending.length > 0) {
      const assetName = pending.pop();
      if (!assetName || visited.has(assetName)) continue;
      visited.add(assetName);
      const source = await assetSource(assetName);
      if (dynamicImportIndex(source, targetAsset) >= 0) {
        return { assetName, source };
      }
      for (const dependency of staticJavaScriptDependencies(source)) {
        if (!assetNameSet.has(dependency)) {
          throw new Error(
            `check-web-chunks: ${assetName} imports missing asset ${dependency}`
          );
        }
        pending.push(dependency);
      }
    }
    throw new Error(
      `check-web-chunks: ${label} cannot reach the lazy import for ${targetAsset}`
    );
  }

  async function assertStaticDependencyUnreachable(
    rootAsset,
    targetAsset,
    label
  ) {
    const pending = [{ assetName: rootAsset, chain: [rootAsset] }];
    const visited = new Set();
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current || visited.has(current.assetName)) continue;
      visited.add(current.assetName);
      for (const dependency of staticJavaScriptDependencies(
        await assetSource(current.assetName)
      )) {
        if (!assetNameSet.has(dependency)) {
          throw new Error(
            `check-web-chunks: ${current.assetName} imports missing asset ${dependency}`
          );
        }
        const chain = [...current.chain, dependency];
        if (dependency === targetAsset) {
          throw new Error(
            `check-web-chunks: ${label} reaches ${targetAsset} through ${chain.join(" -> ")}`
          );
        }
        pending.push({ assetName: dependency, chain });
      }
    }
  }

  function cssPreloadDependencies(source, entryAsset) {
    return dynamicPreloadDependencies(source, entryAsset).filter(
      (name) => name.endsWith(".css")
    );
  }

  function assertCssPreloadsUsePrefixes(
    source,
    entryAsset,
    label,
    allowedPrefixes,
    requiredPrefixes
  ) {
    const cssDependencies = cssPreloadDependencies(source, entryAsset);
    const matchesPrefix = (name, prefix) => (
      hashedAssetPattern(prefix, "css").test(name)
    );
    const unexpected = cssDependencies.filter((name) => (
      !allowedPrefixes.some((prefix) => matchesPrefix(name, prefix))
    ));
    if (unexpected.length > 0) {
      throw new Error(
        `check-web-chunks: ${label} preloads CSS outside its boundary: ${JSON.stringify(unexpected)}`
      );
    }
    const missing = requiredPrefixes.filter((prefix) => (
      !cssDependencies.some((name) => matchesPrefix(name, prefix))
    ));
    if (missing.length > 0) {
      throw new Error(
        `check-web-chunks: ${label} lacks required CSS preloads: ${JSON.stringify(missing)}`
      );
    }
    return cssDependencies;
  }

  return {
    assetNames,
    assetNameSet,
    cssAssetNames,
    javaScriptAssetNames,
    assetSource,
    assertAssetsExcludeMarkers,
    assertCssPreloadsUsePrefixes,
    assertStaticDependencyUnreachable,
    cssPreloadDependencies,
    dynamicImportIndex,
    dynamicPreloadDependencies,
    findStaticReachableDynamicImporter,
    requireCssAssets,
    singleCssAsset,
    singleJavaScriptAsset
  };
}
