import { minifySync, parseSync, type Plugin } from "vite";
import { hash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

/**
 * Who can load a lazy module, from least to most privileged. Code that only
 * privileged imports reach never joins a chunk that a less privileged page
 * loads.
 */
const accessLayers = ["public", "admin", "image", "super"] as const;
type AccessLayer = (typeof accessLayers)[number];

// A lazy import declares facts the import graph cannot show in one block
// comment marked "@chunk" right before its literal specifier, for example
// `import(/* @chunk access: super, visits: rare */ "./SettingsPage.js")`:
// - access: only that layer loads the target; an undeclared lazy module takes
//   the least privileged layer among the roots it loads after, so one that
//   only administrators' code opens is theirs;
// - visits: occasional or rare marks pages people open less often than the
//   everyday pages of their layer;
// - document: the server preloads the target in documents of that name.
// A marked comment anywhere else, or a comment in a lazy import that names a
// field without the marker, fails the build: a missed or mistyped marker must
// not silently drop a layer.
const declarationMarker = /^\s*@chunk\s+/;
// Looks marked, in any case or as a doc comment.
const markedComment = /^[\s*]*@chunk/i;
const fieldMention = /\b(?:access|visits|document)\b/i;
// One fact: a key, one ASCII colon and a value.
const declarationFact = /^\s*([\w-]+)\s*:\s*([\w-]*)\s*$/;
const declarationKeys = ["access", "visits", "document"];
// The app's scripts, which carry the declarations.
const scriptModule = /\.[cm]?[jt]sx?$/;
const literalSpecifier = /^(["'`])([^"'`$]+)\1$/;

// The headers of one more static response cost about this many bytes.
const requestOverheadBytes = 450;
// Each output file adds an entry of about this many compressed bytes to the
// import map that every page document carries.
const importMapEntryBytes = 18;
// Visitors open public pages; administrators open their everyday pages, and
// the super administrator's settings less.
const layerVisits = [100, 5, 5, 0.5] as const;
// Pages declared with visits open this often instead, whatever their layer.
const declaredVisitLevels: Readonly<Record<string, number>> = { occasional: 1, rare: 0.1 };
// However much the others gain, no root downloads more than this of code it
// does not need, about a tenth of a cold page load.
const unneededLimitBytes = 16 * 1024;
// What a view downloads depends on the browser cache. A first view downloads
// everything; administrators keep their cache, so only some of their views
// count as first views, and their cold start weighs less than visitors' pages.
const adminFirstVisitShare = 0.2;
// A view after a release downloads the scripts the release changed. Visitors'
// first views come first: keeping files across releases only decides where it
// costs them little, which still keeps large third-party chunks apart.
const releaseVisitShare = 0.02;

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));
// A module path relative to the workspace, the same on every machine.
const workspacePath = (id: string) => relative(workspaceRoot, id).replaceAll("\\", "/");
// Third-party code and the helpers the bundler injects change with dependency
// upgrades, not with releases of the app.
const dependencyModule = /[\\/]node_modules[\\/]|^\0/;
const styleModule = /\.css$/;

type ModuleGraphInfo = {
  id: string;
  code: string | null;
  importedIds: readonly string[];
  dynamicallyImportedIds: readonly string[];
  dynamicImporters: readonly string[];
  isEntry: boolean;
};

type ChunkPlanOptions = {
  rootName(root: string): string;
};

// Output files smaller than this cost more in request headers than in content.
const smallFileBytes = 1024;

/**
 * A lazy root's chunks take its name; shared chunks are "common" when
 * visitors may load them and "shared" when only administrators do. The part
 * after "~" keeps names distinct for the bundler; published file names drop
 * it and tell chunks apart by their content hash.
 */
export function publishedChunkName(name: string) {
  return name.replace(/~.*$/, "");
}

// Scripts minified like the shipped chunk, so sizes come close to the real
// ones; a style as Vite compiled it, with the sheets it imports inlined.
function shippedSource(info: ModuleGraphInfo, compiledStyle: string | undefined) {
  if (compiledStyle !== undefined) return compiledStyle;
  if (!info.code) return "";
  try {
    return minifySync(info.id, info.code).code;
  } catch {
    return info.code;
  }
}

function compressedBytes(sources: readonly string[]) {
  return brotliCompressSync(sources.join("\n"), {
    params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 }
  }).length;
}

/**
 * Places modules by the import graph alone; the directory a file lives in
 * does not matter. A root is the HTML entry or a dynamic import target, and
 * the roots of a module are those whose static closure needs it.
 * - A module joins the root among its roots that every other one is only
 *   reached through, which adds no code to any page; other modules share one
 *   unit per set of roots, its application and third-party code apart.
 * - Units then merge pairwise while that lowers what views download: first
 *   views pay bytes and a request per file for every chunk a root loads,
 *   the ones its code needs and the ones those import, weighted by how
 *   often each root is opened and administrators' views mostly cached;
 *   views after a release pay the scripts of chunks holding application
 *   code, the only ones whose files a release changes. A root's small styles
 *   may move up to its parent likewise.
 *   Merges stay within one access layer: code only ever reaches pages of its
 *   own or a more privileged layer, so visitors' code and styles may load on
 *   administrators' pages but never the reverse; no root takes on much code
 *   it does not need.
 */
export function createChunkPlan(options: ChunkPlanOptions) {
  const declaredAccess = new Map<string, AccessLayer>();
  const declaredVisits = new Map<string, number>();
  const documentRoots = new Map<string, string[]>();
  const chunkOfModule = new Map<string, string>();
  const names = new Map<string, string>();
  const declarers = new Map<string, string>();
  const compiledStyles = new Map<string, string>();

  // A fact about a lazy module has one value; declaring another one, in the
  // same file or elsewhere, fails the build, since which would win depends
  // on order. `inFile` holds the facts the file being read declared so far.
  function declare<T>(
    facts: Map<string, T>,
    fact: string,
    target: string,
    value: T,
    importer: string,
    inFile: Map<string, unknown>
  ) {
    const key = `${fact}\n${target}`;
    const declarer = declarers.get(key);
    if (
      (inFile.has(key) && inFile.get(key) !== value) ||
      (declarer !== undefined && declarer !== importer && facts.get(target) !== value)
    ) {
      throw new Error(`chunk plan: ${importer} declares ${fact} of ${target} unlike ${declarer}`);
    }
    inFile.set(key, value);
    declarers.set(key, importer);
    facts.set(target, value);
  }

  // Distinct roots or root sets can share a label; only the first keeps it bare.
  function uniqueName(key: string, label: string) {
    const existing = names.get(key);
    if (existing) return existing;
    const taken = [...names.values()].includes(label);
    // Hash workspace-relative paths, so every machine builds the same names.
    const portableKey = key
      .split("\n")
      .map((part) => isAbsolute(part) ? workspacePath(part) : part)
      .join("\n");
    const name = taken ? `${label}~${hash("sha256", portableKey, "hex").slice(0, 6)}` : label;
    names.set(key, name);
    return name;
  }

  function compute(modules: readonly ModuleGraphInfo[]) {
    chunkOfModule.clear();
    names.clear();
    const infoById = new Map(modules.map((info) => [info.id, info]));
    const roots = modules
      .filter((info) => info.isEntry || info.dynamicImporters.length > 0)
      .map((info) => info.id)
      .sort();
    const rootSet = new Set(roots);
    const entries = roots.filter((root) => infoById.get(root)!.isEntry);
    const closures = new Map<string, Set<string>>();
    for (const root of roots) {
      const closure = new Set<string>();
      const pending = [root];
      while (pending.length) {
        const id = pending.pop()!;
        if (closure.has(id)) continue;
        closure.add(id);
        pending.push(...(infoById.get(id)?.importedIds ?? []));
      }
      closures.set(root, closure);
    }

    // A root loads after any root that contains it statically or imports it
    // dynamically; its dominators are the roots loaded on every such path.
    const predecessors = new Map(roots.map((root) => [root, new Set<string>()]));
    for (const root of roots) {
      for (const id of closures.get(root)!) {
        if (id !== root && rootSet.has(id)) predecessors.get(id)!.add(root);
        for (const target of infoById.get(id)?.dynamicallyImportedIds ?? []) {
          if (target !== root && rootSet.has(target)) predecessors.get(target)!.add(root);
        }
      }
    }
    const dominators = new Map<string, Set<string>>(
      roots.map((root) => [root, entries.includes(root) ? new Set([root]) : new Set(roots)])
    );
    for (let changed = true; changed; ) {
      changed = false;
      for (const root of roots) {
        if (entries.includes(root)) continue;
        const common = [...predecessors.get(root)!]
          .map((predecessor) => dominators.get(predecessor)!)
          .reduce<Set<string> | null>((left, right) =>
            left ? new Set([...left].filter((id) => right.has(id))) : new Set(right), null);
        const next = new Set([...(common ?? []), root]);
        if (next.size !== dominators.get(root)!.size) {
          dominators.set(root, next);
          changed = true;
        }
      }
    }
    const dominates = (owner: string, root: string) => dominators.get(root)!.has(owner);
    const immediateDominator = (root: string) => {
      const strict = [...dominators.get(root)!].filter((id) => id !== root);
      return strict.find((candidate) => strict.every((other) => dominates(other, candidate)));
    };
    // A root's layer is its declared one, or the least privileged layer among
    // the roots it loads after when that is higher: code that only
    // administrators' roots reach counts as theirs on every path.
    const access = new Map(roots.map((root) => [root, entries.includes(root)
      ? accessLayers.indexOf(declaredAccess.get(root) ?? "public")
      : accessLayers.length - 1]));
    for (let changed = true; changed; ) {
      changed = false;
      for (const root of roots) {
        if (entries.includes(root)) continue;
        const reached = Math.min(...[...predecessors.get(root)!].map((predecessor) => access.get(predecessor)!));
        const next = Math.max(accessLayers.indexOf(declaredAccess.get(root) ?? "public"), reached);
        if (next !== access.get(root)) {
          access.set(root, next);
          changed = true;
        }
      }
    }
    const accessOf = (root: string) => access.get(root)!;
    // A declared layer holds only while no less privileged root contains the
    // module statically, which would load it with that root's code.
    for (const [root, layer] of declaredAccess) {
      if (!rootSet.has(root)) continue;
      const container = roots.find((other) => other !== root &&
        closures.get(other)!.has(root) && accessOf(other) < accessLayers.indexOf(layer));
      if (container) {
        throw new Error(`chunk plan: ${workspacePath(container)} statically imports ` +
          `${workspacePath(root)}, declared "${layer}"`);
      }
    }

    // Who opens a lazy root: its own layer, or the layer of the code that
    // imports it when that is more privileged, as for a public module that
    // only administrators' pages load lazily.
    const importersOf = new Map(roots.map((root) => [root, new Set<string>()]));
    for (const root of roots) {
      for (const id of closures.get(root)!) {
        for (const target of infoById.get(id)?.dynamicallyImportedIds ?? []) {
          if (rootSet.has(target)) importersOf.get(target)!.add(root);
        }
      }
    }
    const audienceLayer = (root: string) => {
      const importers = [...importersOf.get(root)!];
      return Math.max(accessOf(root), importers.length ? Math.min(...importers.map(accessOf)) : 0);
    };

    // How often each root loads, and how many of those loads are first views
    // (all of visitors', a share of administrators'): its own visits, or for
    // a root that others load through, at least the visits of those. Only
    // roots its own code opens count, such as the pages of a shell; a
    // capability that several pages open loads within their views and adds
    // none. A lazy module inside a dependency loads whenever the code that
    // imports it runs.
    const children = new Map(roots.map((root) => [root, [] as string[]]));
    for (const root of roots) {
      const parent = immediateDominator(root);
      if (parent && importersOf.get(root)!.has(parent)) children.get(parent)!.push(root);
    }
    const visitCounts = new Map<string, readonly [number, number]>();
    const visitsThrough = (root: string): readonly [number, number] => {
      const cached = visitCounts.get(root);
      if (cached) return cached;
      const own = declaredVisits.get(root) ?? layerVisits[audienceLayer(root)];
      const share = audienceLayer(root) === 0 ? 1 : adminFirstVisitShare;
      let loads = 0;
      let firstViews = 0;
      for (const child of children.get(root)!) {
        if (dependencyModule.test(child)) continue;
        const [childLoads, childFirstViews] = visitsThrough(child);
        loads += childLoads;
        firstViews += childFirstViews;
      }
      const value = entries.includes(root)
        ? [loads, firstViews] as const
        : [Math.max(own, loads), Math.max(own * share, firstViews)] as const;
      visitCounts.set(root, value);
      return value;
    };
    const visitsOf = (root: string): readonly [number, number] => {
      const parent = immediateDominator(root);
      return dependencyModule.test(root) && parent ? visitsOf(parent) : visitsThrough(root);
    };
    const loadsOf = (root: string) => visitsOf(root)[0];
    const firstVisits = (root: string) => visitsOf(root)[1];
    // Documents are downloaded on first views and after releases, each with
    // an import map entry for every output file.
    const fileEntryCost = importMapEntryBytes * entries.reduce((sum, entry) =>
      sum + firstVisits(entry) + loadsOf(entry) * releaseVisitShare, 0);

    const rootsOfModule = new Map<string, string[]>();
    for (const root of roots) {
      for (const id of closures.get(root)!) {
        const list = rootsOfModule.get(id) ?? [];
        list.push(root);
        rootsOfModule.set(id, list);
      }
    }

    const placements = new Map<string, { label: string; owner?: string; modules: string[] }>();
    for (const [id, moduleRoots] of rootsOfModule) {
      const owner = moduleRoots.find((candidate) =>
        moduleRoots.every((root) => dominates(candidate, root))
      );
      const group = owner
        ? [owner]
        : moduleRoots
          .filter((root) => !moduleRoots.some((other) => other !== root && dominates(other, root)))
          .sort();
      const key = `${owner ? "root" : "shared"}\n${group.join("\n")}`;
      const placement = placements.get(key) ?? {
        label: uniqueName(key, owner
          ? options.rootName(owner)
          : Math.min(...group.map(accessOf)) === 0 ? "common" : "shared"),
        owner,
        modules: []
      };
      placement.modules.push(id);
      placements.set(key, placement);
    }

    const sources = new Map<string, string>();
    const sourceOf = (id: string) => {
      if (!sources.has(id)) sources.set(id, shippedSource(infoById.get(id)!, compiledStyles.get(id)));
      return sources.get(id)!;
    };
    const rawBytes = (ids: readonly string[]) =>
      ids.reduce((sum, id) => sum + Buffer.byteLength(sourceOf(id)), 0);
    const importsOf = (id: string) => infoById.get(id)?.importedIds ?? [];
    // Bytes each root downloads without needing them, from merges so far.
    const unneeded = new Map(roots.map((root) => [root, 0]));

    // Application and third-party code start as separate units, each with a
    // name of its own: the placement's label, with "-vendor" (or "vendor" for
    // the entry's) on the third-party part. A merged unit keeps one of the
    // names, since the bundler joins groups that share a name.
    type Unit = {
      name: string;
      owner?: string;
      modules: string[];
      bytes: number;
      // The script file's bytes, which views after a release are charged for.
      scriptBytes: number;
      files: number;
      touchedBy: Set<string>;
    };
    const scriptsOf = (ids: readonly string[]) => ids.filter((id) => !styleModule.test(id));
    // A unit becomes a script and a style file when it holds both.
    const filesOf = (ids: readonly string[]) =>
      Number(ids.some((id) => !styleModule.test(id))) + Number(ids.some((id) => styleModule.test(id)));
    const measure = (unit: Unit) => {
      const scripts = scriptsOf(unit.modules);
      unit.bytes = compressedBytes(unit.modules.map(sourceOf));
      unit.scriptBytes = scripts.length ? compressedBytes(scripts.map(sourceOf)) : 0;
      unit.files = filesOf(unit.modules);
      unit.touchedBy = new Set(unit.modules.flatMap((id) => rootsOfModule.get(id)!));
    };
    const entryLabel = uniqueName(`root\n${entries[0]}`, options.rootName(entries[0]!));
    let units: Unit[] = [];
    for (const [key, { label, owner, modules: members }] of placements) {
      for (const [name, part] of [
        [label, members.filter((id) => !dependencyModule.test(id))],
        [
          uniqueName(`vendor\n${key}`, label === entryLabel ? "vendor" : label.replace(/(?=~|$)/, "-vendor")),
          members.filter((id) => dependencyModule.test(id))
        ]
      ] as const) {
        if (!part.length) continue;
        const unit: Unit = { name, owner, modules: part, bytes: 0, scriptBytes: 0, files: 0, touchedBy: new Set() };
        measure(unit);
        units.push(unit);
      }
    }
    const unitOfModule = new Map<string, Unit>();
    for (const unit of units) for (const id of unit.modules) unitOfModule.set(id, unit);

    // Loading a chunk loads the chunks it imports, so a root loads the units
    // its modules are in and every unit those import; once merged, a unit
    // loads for the roots of both parts along with what both import.
    const loadState = () => {
      const imports = new Map(units.map((unit) => {
        const imported = new Set<Unit>();
        for (const id of unit.modules) {
          for (const target of importsOf(id)) {
            const other = unitOfModule.get(target);
            if (other && other !== unit) imported.add(other);
          }
        }
        return [unit, imported];
      }));
      const reached = new Map<Unit, Set<Unit>>();
      const reachOf = (start: Unit) => {
        let found = reached.get(start);
        if (!found) {
          found = new Set();
          const pending = [...imports.get(start)!];
          while (pending.length) {
            const next = pending.pop()!;
            if (next === start || found.has(next)) continue;
            found.add(next);
            pending.push(...imports.get(next)!);
          }
          reached.set(start, found);
        }
        return found;
      };
      const loadedBy = new Map(units.map((unit) => [unit, new Set(unit.touchedBy)]));
      for (const unit of units) {
        for (const other of reachOf(unit)) {
          const roots = loadedBy.get(other)!;
          for (const root of unit.touchedBy) roots.add(root);
        }
      }
      return { reachOf, loadedBy };
    };
    type LoadState = ReturnType<typeof loadState>;

    // A unit is fetched by the roots that load it while none of the roots
    // loaded before them did; each fetch costs its bytes and a request per file.
    const fetchedBy = (loadedBy: ReadonlySet<string>) => new Set([...loadedBy].filter((root) =>
      [...dominators.get(root)!].every((loaded) => loaded === root || !loadedBy.has(loaded))
    ));
    const cost = (loadedBy: ReadonlySet<string>, bytes: number, files: number) => {
      let visits = 0;
      for (const root of fetchedBy(loadedBy)) visits += firstVisits(root);
      return visits * (bytes + files * requestOverheadBytes);
    };

    // Chunks import each other by stable names that the document's import map
    // maps to the current files, so a chunk's file changes only with its own
    // content. A release changes application code, which any chunk holding
    // some may contain; third-party code changes with dependency upgrades.
    const changes = (unit: Unit) =>
      unit.modules.some((id) => !dependencyModule.test(id) && !styleModule.test(id));
    const releaseCost = (loadedBy: ReadonlySet<string>, scriptBytes: number) => {
      if (!scriptBytes) return 0;
      let visits = 0;
      for (const root of fetchedBy(loadedBy)) visits += loadsOf(root) * releaseVisitShare;
      return visits * (scriptBytes + requestOverheadBytes);
    };

    // Code is only ever loaded by the least privileged layer that needs it.
    const codeLayer = (unit: Unit) => Math.min(...[...unit.touchedBy].map(accessOf));
    const mergeable = (left: Unit, right: Unit) => codeLayer(left) === codeLayer(right);

    // A root's styles that make a file smaller than a small file move to the
    // root it always loads through, of the same layer and with styles of its
    // own, when that saves more than it costs: the root saves a request, the
    // documents an import map entry, and the parent's other pages download
    // the styles.
    {
      for (const unit of [...units]) {
        const parent = unit.owner && immediateDominator(unit.owner);
        if (!unit.owner || !parent || accessOf(parent) !== accessOf(unit.owner)) continue;
        const styles = unit.modules.filter((id) => styleModule.test(id));
        const parentUnit = units.find((other) =>
          other.owner === parent && other.modules.some((id) => styleModule.test(id)));
        if (!styles.length || !parentUnit || rawBytes(styles) >= smallFileBytes) continue;
        const bytes = compressedBytes(styles.map(sourceOf));
        const saving = firstVisits(unit.owner) * requestOverheadBytes + fileEntryCost
          - (firstVisits(parent) - firstVisits(unit.owner)) * bytes;
        if (saving <= 0 || unneeded.get(parent)! + bytes > unneededLimitBytes) continue;
        unneeded.set(parent, unneeded.get(parent)! + bytes);
        unit.modules = unit.modules.filter((id) => !styles.includes(id));
        parentUnit.modules.push(...styles);
        for (const id of styles) unitOfModule.set(id, parentUnit);
        measure(parentUnit);
        if (unit.modules.length) measure(unit);
        else units = units.filter((other) => other !== unit);
      }
    }

    // What merging two units changes: the roots that load the merged unit,
    // the units it imports that more roots then load, and the bytes each root
    // newly downloads without needing them.
    const mergeEffect = (left: Unit, right: Unit, loads: LoadState) => {
      const leftLoaded = loads.loadedBy.get(left)!;
      const rightLoaded = loads.loadedBy.get(right)!;
      const loaded = new Set([...leftLoaded, ...rightLoaded]);
      const dragged: { unit: Unit; before: Set<string>; after: Set<string> }[] = [];
      for (const unit of new Set([...loads.reachOf(left), ...loads.reachOf(right)])) {
        if (unit === left || unit === right) continue;
        const before = loads.loadedBy.get(unit)!;
        if ([...loaded].every((root) => before.has(root))) continue;
        dragged.push({ unit, before, after: new Set([...before, ...loaded]) });
      }
      const unneededBytes = new Map<string, number>();
      const add = (root: string, bytes: number) =>
        unneededBytes.set(root, (unneededBytes.get(root) ?? 0) + bytes);
      const leftFetchers = fetchedBy(leftLoaded);
      const rightFetchers = fetchedBy(rightLoaded);
      for (const root of fetchedBy(loaded)) {
        add(root, (leftFetchers.has(root) ? 0 : left.bytes) + (rightFetchers.has(root) ? 0 : right.bytes));
      }
      for (const { unit, before, after } of dragged) {
        const fetchers = fetchedBy(before);
        for (const root of fetchedBy(after)) if (!fetchers.has(root)) add(root, unit.bytes);
      }
      return { loaded, dragged, unneededBytes };
    };
    type MergeEffect = ReturnType<typeof mergeEffect>;

    // Units that one reaches through a third stay apart: merged, the third
    // and the merged chunk would import each other, and a module could read
    // a binding of the other before it is initialized.
    const closesCycle = (left: Unit, right: Unit, loads: LoadState) =>
      [...loads.reachOf(left)].some((unit) => unit !== right && loads.reachOf(unit).has(right)) ||
      [...loads.reachOf(right)].some((unit) => unit !== left && loads.reachOf(unit).has(left));

    // No root may end up downloading much it does not need, whoever gains.
    const exceedsLimit = ({ unneededBytes }: MergeEffect) =>
      [...unneededBytes].some(([root, bytes]) => unneeded.get(root)! + bytes > unneededLimitBytes);
    const merge = (left: Unit, right: Unit, effect: MergeEffect) => {
      for (const [root, bytes] of effect.unneededBytes) unneeded.set(root, unneeded.get(root)! + bytes);
      // The merged chunk keeps a root's name over a shared one, else the larger's.
      const [kept, absorbed] = Boolean(left.owner) !== Boolean(right.owner)
        ? (left.owner ? [left, right] : [right, left])
        : left.bytes >= right.bytes ? [left, right] : [right, left];
      kept.modules.push(...absorbed.modules);
      for (const id of absorbed.modules) unitOfModule.set(id, kept);
      measure(kept);
      units = units.filter((unit) => unit !== absorbed);
    };

    // Merge the pair that saves the most, over first views and views after a
    // release, until no merge saves anything; the units the merged one
    // imports count for the roots they newly load with. A merged unit changes
    // with a release when either part does, so third-party code merged with
    // application code is downloaded again after every release.
    for (;;) {
      const loads = loadState();
      const loadedBy = (unit: Unit) => loads.loadedBy.get(unit)!;
      const unitCost = (unit: Unit, roots = loadedBy(unit)) => cost(roots, unit.bytes, unit.files)
        + (changes(unit) ? releaseCost(roots, unit.scriptBytes) : 0);
      let best: { left: Unit; right: Unit; effect: MergeEffect; saving: number } | null = null;
      for (let leftIndex = 0; leftIndex < units.length; leftIndex += 1) {
        const left = units[leftIndex]!;
        const leftCost = unitCost(left);
        for (let rightIndex = leftIndex + 1; rightIndex < units.length; rightIndex += 1) {
          const right = units[rightIndex]!;
          if (!mergeable(left, right) || closesCycle(left, right, loads)) continue;
          const effect = mergeEffect(left, right, loads);
          if (exceedsLimit(effect)) continue;
          const mergedChanges = changes(left) || changes(right);
          const mergedFiles = filesOf([...left.modules, ...right.modules]);
          let saving = leftCost + unitCost(right)
            + (left.files + right.files - mergedFiles) * fileEntryCost
            - cost(effect.loaded, left.bytes + right.bytes, mergedFiles)
            - (mergedChanges ? releaseCost(effect.loaded, left.scriptBytes + right.scriptBytes) : 0);
          for (const { unit, before, after } of effect.dragged) {
            saving -= unitCost(unit, after) - unitCost(unit, before);
          }
          if (saving > 0 && (!best || saving > best.saving)) best = { left, right, effect, saving };
        }
      }
      if (!best) break;
      merge(best.left, best.right, best.effect);
    }

    for (const unit of units) {
      for (const id of unit.modules) chunkOfModule.set(id, unit.name);
    }
  }

  const plugin: Plugin = {
    name: "imageshow-chunk-plan",
    apply: "build",
    enforce: "pre",
    async transform(code, id) {
      if (dependencyModule.test(id) || !scriptModule.test(id)) return null;
      const parsed = parseSync(id, code);
      // The bundler reports a file it cannot parse.
      if (parsed.errors.some((error) => error.severity === "Error")) return null;
      const at = (offset: number) => `${workspacePath(id)}:${code.slice(0, offset).split("\n").length}`;
      const declarations: { body: string; specifier: string; at: string }[] = [];
      for (const comment of parsed.comments) {
        const call = parsed.module.dynamicImports.find((entry) =>
          entry.start <= comment.start && comment.end <= entry.end);
        if (markedComment.test(comment.value)) {
          // The one block comment between "import(" and a literal specifier.
          const request = call && code.slice(call.moduleRequest.start, call.moduleRequest.end);
          const specifier = request && literalSpecifier.exec(request)?.[2];
          const placed = call && specifier && comment.type === "Block" &&
            declarationMarker.test(comment.value) &&
            /^import\s*\(\s*$/.test(code.slice(call.start, comment.start)) &&
            /^\s*$/.test(code.slice(comment.end, call.moduleRequest.start)) &&
            /^\s*,?\s*\)$/.test(code.slice(call.moduleRequest.end, call.end));
          if (!placed) throw new Error(`chunk plan: misplaced or malformed @chunk declaration at ${at(comment.start)}`);
          declarations.push({
            body: comment.value.replace(declarationMarker, ""),
            specifier,
            at: at(comment.start)
          });
        } else if (call && fieldMention.test(comment.value)) {
          throw new Error(`chunk plan: declaration without @chunk at ${at(comment.start)}`);
        }
      }
      const inFile = new Map<string, unknown>();
      for (const { body, specifier, at: place } of declarations) {
        // A malformed, repeated or unknown fact fails the build instead of
        // losing its layer.
        const pairs = body.split(",").map((fact) => {
          const parts = declarationFact.exec(fact);
          if (!parts) throw new Error(`chunk plan: malformed declaration "${fact.trim()}" at ${place}`);
          return [parts[1]!, parts[2]!] as const;
        });
        const facts = new Map(pairs);
        if (facts.size !== pairs.length) throw new Error(`chunk plan: repeated declaration at ${place}`);
        const unknown = [...facts.keys()].find((key) => !declarationKeys.includes(key));
        if (unknown !== undefined) throw new Error(`chunk plan: unknown declaration "${unknown}" at ${place}`);
        const resolved = await this.resolve(specifier, id);
        if (!resolved) throw new Error(`chunk plan: cannot resolve ${specifier} at ${place}`);
        const access = facts.get("access");
        if (access !== undefined) {
          if (!accessLayers.includes(access as AccessLayer)) {
            throw new Error(`chunk plan: unknown access "${access}" at ${place}`);
          }
          declare(declaredAccess, "access", resolved.id, access as AccessLayer, id, inFile);
        }
        const visits = facts.get("visits");
        if (visits !== undefined) {
          const level = Object.hasOwn(declaredVisitLevels, visits) ? declaredVisitLevels[visits] : undefined;
          if (level === undefined) throw new Error(`chunk plan: unknown visits "${visits}" at ${place}`);
          declare(declaredVisits, "visits", resolved.id, level, id, inFile);
        }
        const document = facts.get("document");
        if (document !== undefined) {
          if (!document) throw new Error(`chunk plan: empty document at ${place}`);
          documentRoots.set(document, [...new Set([...(documentRoots.get(document) ?? []), resolved.id])]);
        }
      }
      return null;
    },
    buildEnd(error) {
      if (error) return;
      compute(
        [...this.getModuleIds()].flatMap((id) => {
          const info = this.getModuleInfo(id);
          return info ? [info] : [];
        })
      );
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        // Per document, the files of its lazy roots that the entry does not
        // already list, for the server to preload with the document.
        const chunks = Object.values(bundle).flatMap((output) => output.type === "chunk" ? [output] : []);
        const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
        const closure = (start: string) => {
          const files = new Set<string>();
          const pending = [start];
          while (pending.length) {
            const file = pending.pop()!;
            if (files.has(file) || !byFile.has(file)) continue;
            files.add(file);
            pending.push(...byFile.get(file)!.imports);
          }
          return [...files];
        };
        const stylesOf = (files: Iterable<string>) => [...files].flatMap((file) => [
          ...((byFile.get(file) as { viteMetadata?: { importedCss?: Set<string> } })
            .viteMetadata?.importedCss ?? [])
        ]);
        const entry = chunks.find((chunk) => chunk.isEntry)!;
        const listed = new Set(closure(entry.fileName));
        const listedStyles = new Set(stylesOf(listed));
        const documents = Object.fromEntries([...documentRoots].sort().map(([name, ids]) => {
          const files = [...new Set(ids.flatMap((id) => {
            const chunk = chunks.find((candidate) => candidate.moduleIds.includes(id));
            if (!chunk) throw new Error(`chunk plan: no chunk holds document root ${id}`);
            return closure(chunk.fileName);
          }))].filter((file) => !listed.has(file));
          return [name, {
            scripts: files.filter((file) => byFile.get(file)!.code.length > 0),
            styles: [...new Set(stylesOf(files))].filter((file) => !listedStyles.has(file))
          }];
        }));
        // Vite writes the chunk import map into the HTML; the JSON copy it
        // also emits is not served.
        delete bundle["importmap.json"];
        this.emitFile({
          type: "asset",
          fileName: ".vite/document-preloads.json",
          source: JSON.stringify({ schemaVersion: 1, documents }, null, 2) + "\n"
        });
      }
    }
  };

  // Vite inlines a style's @import rules when it compiles the style and
  // empties the module before the build ends; a plugin of normal order runs
  // in between, so a sheet that gathers others counts whole.
  const stylePlugin: Plugin = {
    name: "imageshow-chunk-plan-styles",
    apply: "build",
    transform(code, id) {
      if (styleModule.test(id)) compiledStyles.set(id, code);
      return null;
    }
  };

  return {
    plugins: [plugin, stylePlugin],
    chunkOf: (id: string) => chunkOfModule.get(id) ?? null
  };
}
