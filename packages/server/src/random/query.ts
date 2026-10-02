import { appConfig } from "@imageshow/shared";
import {
  normalizeTagExpression,
  parseTagFilter,
  TagFilterError,
  type TagExpression,
  randomMethods as randomMethodValues,
  randomImageSizes,
  type RandomImageSize,
  type RandomDefaultMethod,
  type RandomMethod
} from "@imageshow/shared/browser";
import { apiErrorResponse } from "../core/http/responses.ts";

export const randomDevices = ["pc", "mb"] as const;
export const randomBrightnesses = ["dark", "light"] as const;
const randomRequestDeviceValues = ["pc", "mb", "all", "auto"] as const;
export type RandomBrightness = (typeof randomBrightnesses)[number];
export type RandomRequestDevice = (typeof randomRequestDeviceValues)[number];

export type RandomSelectorGroup = {
  include: string[];
  exclude: string[];
};

export type ParsedRandomQuery = {
  mode: RandomMethod;
  size: RandomImageSize;
  limit: number;
  ids: string[];
  seed: string | null;
  device: RandomRequestDevice;
  brightness: RandomBrightness | null;
  theme: RandomSelectorGroup;
  tag: TagExpression;
  author: RandomSelectorGroup;
};

/** Submitted names that match no vocabulary entry and therefore no image. */
type RandomIgnoredSelectors = Record<"theme" | "tag" | "author", string[]>;

export type NormalizedRandomQuery = ParsedRandomQuery & {
  ignored: RandomIgnoredSelectors;
  signature: string;
};

export type RandomSelectorMaps = {
  theme: ReadonlyMap<string, string>;
  tag: ReadonlyMap<string, string>;
  author: ReadonlyMap<string, string>;
};

const randomRequestDevices: ReadonlySet<string> = new Set(randomRequestDeviceValues);
const randomMethods: ReadonlySet<string> = new Set(randomMethodValues);
const randomSizes: ReadonlySet<string> = new Set(randomImageSizes);
const randomAllowedQueryValues = [
  "device",
  "brightness",
  "theme",
  "tag",
  "author",
  "id",
  "seed",
  "mode",
  "size",
  "limit"
] as const;
const randomAllowedQuery = new Set<string>(randomAllowedQueryValues);
const randomSingleValueQuery = new Set([
  "device",
  "brightness",
  "seed",
  "mode",
  "size",
  "limit"
]);
const randomBrightnessSet = new Set(randomBrightnesses);
const disallowedSelectorCharacters = /[\u0000-\u001f\u007f]/u;
const fullUuidPattern = new RegExp(
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  "iu"
);
const uuidSuffixPattern = /^[0-9a-f]{12}$/iu;

export function isRandomBrightness(value: string): value is RandomBrightness {
  return randomBrightnessSet.has(value as RandomBrightness);
}

function invalidQueryParameters(query: URLSearchParams) {
  for (const key of query.keys()) {
    if (!randomAllowedQuery.has(key)) {
      return apiErrorResponse(
        { status: 400, message: "Bad Request: Invalid query parameters" },
        { invalidQuery: [key], allowedQuery: randomAllowedQueryValues }
      );
    }
  }
  for (const key of randomSingleValueQuery) {
    if (query.getAll(key).length > 1) {
      return apiErrorResponse(
        { status: 400, message: "Bad Request: Duplicate query parameter" },
        { field: key, hint: "This parameter only accepts a single value" }
      );
    }
  }
  return null;
}

function mixedSelectorsError(noun: string, include: string[], exclude: string[]) {
  if (!include.length || !exclude.length) return null;
  return apiErrorResponse(
    { status: 400, message: `Bad Request: Cannot mix include and exclude ${noun} selectors` },
    { include, exclude, hint: `Use either include ${noun}s or exclude ${noun}s, not both` }
  );
}

function parseSelectorGroup(
  query: URLSearchParams,
  field: "theme" | "author",
  noun: string
) {
  const include: string[] = [];
  const exclude: string[] = [];
  let submittedCount = 0;

  for (const rawValue of query.getAll(field)) {
    for (const rawPart of rawValue.split(",")) {
      const part = rawPart.trim();
      if (!part) continue;
      const excluded = part.startsWith("!");
      const submittedTerm = (excluded ? part.slice(1) : part).trim();
      if (!submittedTerm || disallowedSelectorCharacters.test(submittedTerm)) {
        return apiErrorResponse(
          { status: 400, message: "Bad Request: Invalid selector" },
          { field, value: part }
        );
      }
      if ([...submittedTerm].length > appConfig.randomQuery.maxSelectorCharacters) {
        return apiErrorResponse(
          { status: 400, message: "Bad Request: Selector is too long" },
          {
            field,
            maxCharacters: appConfig.randomQuery.maxSelectorCharacters
          }
        );
      }
      const term = submittedTerm.toLowerCase();
      submittedCount += 1;
      if (submittedCount > appConfig.randomQuery.maxSelectorsPerField) {
        return apiErrorResponse(
          { status: 400, message: "Bad Request: Too many selectors" },
          {
            field,
            maxSelectors: appConfig.randomQuery.maxSelectorsPerField
          }
        );
      }
      (excluded ? exclude : include).push(term);
    }
  }

  const uniqueInclude = [...new Set(include)];
  const uniqueExclude = [...new Set(exclude)];
  const mixed = mixedSelectorsError(noun, uniqueInclude, uniqueExclude);
  if (mixed) return mixed;
  return {
    selectors: { include: uniqueInclude, exclude: uniqueExclude },
    submittedCount
  };
}

type RandomSelectionFilters = Pick<
  ParsedRandomQuery,
  "seed" | "device" | "brightness" | "theme" | "tag" | "author"
>;

export function hasSelectors(group: RandomSelectorGroup) {
  return group.include.length > 0 || group.exclude.length > 0;
}

function targetedIdConflictError(filters: RandomSelectionFilters) {
  const active = {
    author: hasSelectors(filters.author),
    brightness: filters.brightness !== null,
    device: filters.device !== "auto",
    seed: filters.seed !== null,
    tag: filters.tag !== null,
    theme: hasSelectors(filters.theme)
  };
  const incompatible = Object.entries(active)
    .filter(([, isActive]) => isActive)
    .map(([field]) => field);
  if (!incompatible.length) return null;
  return apiErrorResponse(
    { status: 400, message: "Bad Request: id cannot be combined with seed or filters" },
    {
      field: "id",
      incompatible,
      hint: "id can only be combined with mode, size, limit, and device=auto"
    }
  );
}

/** Drops blank tag terms and segments; the shared parser itself keeps rejecting them. */
function compactTagFilterValues(values: readonly string[]): string[] {
  return values.flatMap((value) => {
    const raw = value.trim();
    const all = /^all:/iu.test(raw);
    const terms = (all ? raw.slice(4) : raw)
      .split(",")
      .map((term) => term.trim())
      .filter(Boolean);
    return terms.length ? [`${all ? "all:" : ""}${terms.join(",")}`] : [];
  });
}

/** Reads a positive count capped at the JSON maximum; null means the value is not a count. */
function parseLimitCount(raw: string): number | null {
  if (!/^\d+$/u.test(raw)) return null;
  const significant = raw.replace(/^0+/u, "");
  if (!significant) return null;
  const maximum = String(appConfig.randomQuery.maxJsonItems);
  if (
    significant.length > maximum.length ||
    (significant.length === maximum.length && significant > maximum)
  ) {
    return appConfig.randomQuery.maxJsonItems;
  }
  return Number(significant);
}

/**
 * Image count used by rate limiting before any other validation. A blank or
 * missing limit asks for one image; null marks a limit that is not a count.
 */
export function requestedRandomImageCount(query: URLSearchParams): number | null {
  const raw = query.get("limit")?.trim();
  return raw ? parseLimitCount(raw) : 1;
}

function parseJsonLimit(
  query: URLSearchParams,
  explicitMode: string | null
): number | Response {
  const raw = query.get("limit")?.trim();
  if (!raw) return 1;
  if (explicitMode !== "json") {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: limit requires mode=json" },
      {
        field: "limit",
        hint: "Use limit only with an explicit mode=json parameter"
      }
    );
  }
  const count = parseLimitCount(raw);
  if (count === null) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid result count" },
      { field: "limit", hint: "Use a positive integer" }
    );
  }
  return count;
}

function parseTargetedIds(query: URLSearchParams): string[] | Response {
  const ids: string[] = [];
  let submittedCount = 0;
  for (const rawValue of query.getAll("id")) {
    for (const rawPart of rawValue.split(",")) {
      const value = rawPart.trim();
      if (!value) continue;
      submittedCount += 1;
      if (submittedCount > appConfig.randomQuery.maxSelectorsPerField) {
        return apiErrorResponse(
          { status: 400, message: "Bad Request: Too many selectors" },
          {
            field: "id",
            maxSelectors: appConfig.randomQuery.maxSelectorsPerField
          }
        );
      }
      if (!fullUuidPattern.test(value) && !uuidSuffixPattern.test(value)) {
        return apiErrorResponse(
          { status: 400, message: "Bad Request: Invalid id" },
          {
            field: "id",
            value,
            hint: "Use a full UUID or its final 12 hexadecimal characters"
          }
        );
      }
      ids.push(value.toLowerCase());
    }
  }
  if (!ids.length) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid id" },
      {
        field: "id",
        hint: "Provide a full UUID or its final 12 hexadecimal characters"
      }
    );
  }
  return [...new Set(ids)].sort();
}

function parseSeed(query: URLSearchParams): string | null | Response {
  const seed = query.get("seed");
  if (seed === null) return null;
  if (
    !seed.trim() ||
    disallowedSelectorCharacters.test(seed) ||
    [...seed].length > appConfig.randomQuery.maxSeedCharacters
  ) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid seed" },
      {
        field: "seed",
        maxCharacters: appConfig.randomQuery.maxSeedCharacters,
        hint: "Use a non-blank string without control characters"
      }
    );
  }
  return seed;
}

export function parseRandomQuery(
  url: URL,
  defaultMode: RandomDefaultMethod,
  defaultSize: RandomImageSize = "medium"
): ParsedRandomQuery | Response {
  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : url.search;
  const rawBytes = Buffer.byteLength(rawQuery, "utf8");
  if (rawBytes > appConfig.randomQuery.maxRawBytes) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Query string is too large" },
      { maxBytes: appConfig.randomQuery.maxRawBytes }
    );
  }

  const query = url.searchParams;
  const queryError = invalidQueryParameters(query);
  if (queryError) return queryError;

  // Blank values of optional parameters mean "not provided"; blank seed and id stay invalid.
  const explicitMode = query.get("mode")?.trim().toLowerCase() || null;
  if (explicitMode && !randomMethods.has(explicitMode)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid mode" },
      { field: "mode" }
    );
  }
  const size = query.get("size")?.trim().toLowerCase() || defaultSize;
  if (!randomSizes.has(size)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid size" },
      { field: "size", allowedValues: randomImageSizes }
    );
  }
  const limit = parseJsonLimit(query, explicitMode);
  if (limit instanceof Response) return limit;
  const seed = parseSeed(query);
  if (seed instanceof Response) return seed;
  const brightness = query.get("brightness")?.trim().toLowerCase() || null;
  if (brightness && !isRandomBrightness(brightness)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid brightness" },
      { field: "brightness" }
    );
  }
  const device = query.get("device")?.trim().toLowerCase() || "auto";
  if (!randomRequestDevices.has(device)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid device" },
      { field: "device" }
    );
  }

  const theme = parseSelectorGroup(query, "theme", "theme");
  if (theme instanceof Response) return theme;
  let tag: ReturnType<typeof parseTagFilter>;
  try {
    tag = parseTagFilter(compactTagFilterValues(query.getAll("tag")), "mixed");
  } catch (error) {
    if (!(error instanceof TagFilterError)) throw error;
    return apiErrorResponse({ status: 400, message: error.message }, { field: "tag" });
  }
  const author = parseSelectorGroup(query, "author", "author");
  if (author instanceof Response) return author;
  const selectorCount = theme.submittedCount + tag.termCount + author.submittedCount;
  if (selectorCount > appConfig.randomQuery.maxSelectorCount) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Too many selectors" },
      { maxSelectors: appConfig.randomQuery.maxSelectorCount }
    );
  }

  const filters: RandomSelectionFilters = {
    seed,
    device: device as RandomRequestDevice,
    brightness: brightness as RandomBrightness | null,
    theme: theme.selectors,
    tag: tag.expression,
    author: author.selectors
  };
  let ids: string[] = [];
  if (query.has("id")) {
    const conflictError = targetedIdConflictError(filters);
    if (conflictError) return conflictError;
    const targetedIds = parseTargetedIds(query);
    if (targetedIds instanceof Response) return targetedIds;
    ids = targetedIds;
  }

  return {
    mode: (explicitMode ?? defaultMode) as RandomMethod,
    size: size as RandomImageSize,
    limit,
    ids,
    ...filters
  };
}

/** Keeps known names as slugs and records the rest, which match no image. */
function knownSelectorGroup(
  selectors: RandomSelectorGroup,
  map: ReadonlyMap<string, string>,
  ignored: string[]
): RandomSelectorGroup {
  const known = (terms: string[]) => {
    const slugs: string[] = [];
    for (const term of terms) {
      const slug = map.get(term);
      if (slug) slugs.push(slug);
      else ignored.push(term);
    }
    return [...new Set(slugs)].sort();
  };
  return {
    include: known(selectors.include),
    exclude: known(selectors.exclude)
  };
}

/** An all-clause naming an unknown tag cannot match, so only fully known clauses remain. */
function knownTagExpression(
  expression: TagExpression,
  map: ReadonlyMap<string, string>,
  ignored: string[]
): TagExpression {
  if (!expression) return null;
  const clauses: string[][] = [];
  for (const clause of expression.anyOf) {
    const slugs = clause.flatMap((term) => {
      const slug = map.get(term);
      return slug ? [slug] : [];
    });
    if (slugs.length === clause.length) clauses.push(slugs);
    else ignored.push(...clause.filter((term) => !map.has(term)));
  }
  return clauses.length ? normalizeTagExpression(clauses) : null;
}

export function ignoredSelectorDetails(ignored: RandomIgnoredSelectors) {
  const fields = Object.entries(ignored)
    .filter(([, terms]) => terms.length > 0)
    .map(([field, terms]) => [field, [...new Set(terms)].sort()] as const);
  return fields.length ? { ignored: Object.fromEntries(fields) } : {};
}

/**
 * Unknown names match no image: they drop out of include lists and tag
 * clauses before planning, so they never reach index keys, dedupe or seed
 * signatures. A filter left with nothing that can match returns 404 at once.
 */
export function normalizeRandomQuery(
  query: ParsedRandomQuery,
  maps: RandomSelectorMaps
): NormalizedRandomQuery | Response {
  const ignored: RandomIgnoredSelectors = { theme: [], tag: [], author: [] };
  const theme = knownSelectorGroup(query.theme, maps.theme, ignored.theme);
  const tag = knownTagExpression(query.tag, maps.tag, ignored.tag);
  const author = knownSelectorGroup(query.author, maps.author, ignored.author);
  const unmatchable =
    (query.theme.include.length > 0 && theme.include.length === 0) ||
    (query.tag !== null && tag === null) ||
    (query.author.include.length > 0 && author.include.length === 0);
  if (unmatchable) {
    return apiErrorResponse(
      { status: 404, message: "Not Found: No available images for the selected filters" },
      ignoredSelectorDetails(ignored)
    );
  }

  const normalized = {
    ...query,
    theme,
    tag,
    author,
    ignored
  };
  return {
    ...normalized,
    // Compact keys are the existing Redis dedupe-key serialization, not DTO fields.
    signature: JSON.stringify({
      "d": normalized.device === "auto" ? "" : normalized.device,
      "b": normalized.brightness ?? "",
      "t": normalized.theme,
      tag: normalized.tag,
      "a": normalized.author
    })
  };
}
