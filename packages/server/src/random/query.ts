import { appConfig } from "@imageshow/shared";
import {
  normalizeTagExpression,
  parseTagFilter,
  TagFilterError,
  type TagExpression,
  randomMethods as randomMethodValues,
  randomImageSizes,
  slugMaxLength,
  slugPattern,
  randomFallbackDimensions,
  type RandomFallbackDimension,
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
  groups: string[];
  scoped: boolean;
  fallback: RandomFallbackDimension[];
  seed: string | null;
  device: RandomRequestDevice;
  brightness: RandomBrightness | null;
  theme: RandomSelectorGroup;
  tag: TagExpression;
  author: RandomSelectorGroup;
};

/** Submitted slugs that match no vocabulary entry and therefore no image. */
type RandomIgnoredSelectors = Record<"theme" | "tag" | "author" | "group", string[]>;

export type NormalizedRandomQuery = ParsedRandomQuery & {
  ignored: RandomIgnoredSelectors;
  signature: string;
  unmatchable: boolean;
};

export type RandomSelectorSlugs = {
  groups?: ReadonlySet<string>;
  theme: ReadonlySet<string>;
  tag: ReadonlySet<string>;
  author: ReadonlySet<string>;
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
  "group",
  "fallback",
  "seed",
  "mode",
  "size",
  "limit"
] as const;
const randomAllowedQuery = new Set<string>(randomAllowedQueryValues);
const randomSingleValueQuery = new Set([
  "device",
  "brightness",
  "fallback",
  "seed",
  "mode",
  "size",
  "limit"
]);
const randomBrightnessSet = new Set(randomBrightnesses);
const randomFallbackDimensionSet: ReadonlySet<string> = new Set(randomFallbackDimensions);
const disallowedSelectorCharacters = /[\u0000-\u001f\u007f]/u;
const fullUuidPattern = new RegExp(
  "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  "iu"
);
const uuidSuffixPattern = /^[0-9a-f]{12}$/iu;

export function isRandomBrightness(value: string): value is RandomBrightness {
  return randomBrightnessSet.has(value as RandomBrightness);
}

/** Fallback list items, trimmed and lowercased; blank items are dropped. */
function fallbackTerms(value: string) {
  return value.split(",").map((term) => term.trim().toLowerCase()).filter(Boolean);
}

/** Value compared when a single-value parameter is repeated; seed is used verbatim. */
function comparableSingleValue(key: string, value: string) {
  if (key === "seed") return value;
  // The written order is the relaxation order, so lists differing only in order conflict.
  if (key === "fallback") return fallbackTerms(value).join(",");
  const trimmed = value.trim();
  if (key === "limit") return trimmed.replace(/^0+(?=\d)/u, "");
  return trimmed.toLowerCase();
}

/**
 * First non-blank value of a single-value parameter. Repeats that are blank or
 * equal after normalization count once; conflicting repeats are rejected by
 * invalidQueryParameters. A parameter given only as blanks stays blank.
 */
function singleQueryValue(query: URLSearchParams, key: string): string | null {
  const values = query.getAll(key);
  return values.find((value) => value.trim()) ?? values[0] ?? null;
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
    const values = new Set(
      query.getAll(key)
        .filter((value) => value.trim())
        .map((value) => comparableSingleValue(key, value))
        .filter(Boolean)
    );
    if (values.size > 1) {
      return apiErrorResponse(
        { status: 400, message: "Bad Request: Duplicate query parameter" },
        { field: key, hint: "Repeat this parameter only with the same value" }
      );
    }
  }
  return null;
}

function parseSelectorGroup(
  query: URLSearchParams,
  field: "theme" | "author"
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
      // An empty exclusion names nothing, like an empty list item.
      if (excluded && !submittedTerm) continue;
      const term = submittedTerm.toLowerCase();
      if (!slugPattern.test(term) || term.length > slugMaxLength) {
        return apiErrorResponse(
          { status: 400, message: "Bad Request: Invalid selector" },
          { field, value: part }
        );
      }
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

  return {
    selectors: {
      include: [...new Set(include)],
      exclude: [...new Set(exclude)]
    },
    submittedCount
  };
}

export function hasSelectors(group: RandomSelectorGroup) {
  return group.include.length > 0 || group.exclude.length > 0;
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
  const raw = singleQueryValue(query, "limit")?.trim();
  return raw ? parseLimitCount(raw) : 1;
}

function parseJsonLimit(
  query: URLSearchParams,
  explicitMode: string | null
): number | Response {
  const raw = singleQueryValue(query, "limit")?.trim();
  if (!raw) return 1;
  const count = parseLimitCount(raw);
  // Every mode can return one image, so limit=1 is the same as omitting it.
  if (count === 1) return 1;
  if (explicitMode !== "json") {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: limit requires mode=json" },
      {
        field: "limit",
        hint: "Use limit only with an explicit mode=json parameter"
      }
    );
  }
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

function parseGroups(query: URLSearchParams): string[] | Response {
  const submitted = query.getAll("group").flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!submitted.length || submitted.length > appConfig.randomQuery.maxSelectorsPerField
    || submitted.some((slug) => slug.length > slugMaxLength || !slugPattern.test(slug))) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid group" },
      { field: "group", maxSelectors: appConfig.randomQuery.maxSelectorsPerField, hint: "Use group slugs" }
    );
  }
  return [...new Set(submitted)].sort();
}

function parseSeed(query: URLSearchParams): string | null | Response {
  const seed = singleQueryValue(query, "seed");
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

/**
 * The written order of one fallback list is the relaxation order. A CDN may
 * reorder whole query pairs before the origin, never the text inside a value,
 * so the order lives in a single list. A trailing all appends the dimensions
 * not yet listed in site order.
 */
function parseFallback(
  query: URLSearchParams,
  siteOrder: readonly RandomFallbackDimension[]
): RandomFallbackDimension[] | Response {
  const terms = query.getAll("fallback").map(fallbackTerms).find((list) => list.length) ?? [];
  const allIndex = terms.indexOf("all");
  if (
    terms.some((term) => term !== "all" && term !== "none" && !randomFallbackDimensionSet.has(term))
    || new Set(terms).size !== terms.length
    || (allIndex !== -1 && allIndex !== terms.length - 1)
    || (terms.includes("none") && terms.length > 1)
  ) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid fallback" },
      {
        field: "fallback",
        allowedValues: [...randomFallbackDimensions, "all", "none"],
        hint: "List each dimension once; use all only at the end and none alone"
      }
    );
  }
  const listed = terms.filter((term): term is RandomFallbackDimension => randomFallbackDimensionSet.has(term));
  return allIndex === -1
    ? listed
    : [...listed, ...siteOrder.filter((dimension) => !listed.includes(dimension))];
}

export function parseRandomQuery(
  url: URL,
  defaultMode: RandomDefaultMethod,
  defaultSize: RandomImageSize = "medium",
  fallbackOrder: readonly RandomFallbackDimension[] = appConfig.runtimeDefaults.site.random_fallback_order
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

  // Blank values of optional parameters mean "not provided"; seed, id and group stay invalid.
  const explicitMode = singleQueryValue(query, "mode")?.trim().toLowerCase() || null;
  if (explicitMode && !randomMethods.has(explicitMode)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid mode" },
      { field: "mode" }
    );
  }
  const size = singleQueryValue(query, "size")?.trim().toLowerCase() || defaultSize;
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
  const fallback = parseFallback(query, fallbackOrder);
  if (fallback instanceof Response) return fallback;
  const submittedBrightness = singleQueryValue(query, "brightness")?.trim().toLowerCase();
  // brightness=all is the explicit spelling of "not specified".
  const brightness = submittedBrightness === "all" ? null : submittedBrightness || null;
  if (brightness && !isRandomBrightness(brightness)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid brightness" },
      { field: "brightness" }
    );
  }
  const scoped = query.has("id") || query.has("group");
  const device = singleQueryValue(query, "device")?.trim().toLowerCase() || "auto";
  if (!randomRequestDevices.has(device)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid device" },
      { field: "device" }
    );
  }

  const theme = parseSelectorGroup(query, "theme");
  if (theme instanceof Response) return theme;
  let tag: ReturnType<typeof parseTagFilter>;
  try {
    tag = parseTagFilter(compactTagFilterValues(query.getAll("tag")), "mixed");
  } catch (error) {
    if (!(error instanceof TagFilterError)) throw error;
    return apiErrorResponse({ status: 400, message: error.message }, { field: "tag" });
  }
  const author = parseSelectorGroup(query, "author");
  if (author instanceof Response) return author;
  const selectorCount = theme.submittedCount + tag.termCount + author.submittedCount;
  if (selectorCount > appConfig.randomQuery.maxSelectorCount) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Too many selectors" },
      { maxSelectors: appConfig.randomQuery.maxSelectorCount }
    );
  }

  let ids: string[] = [];
  if (query.has("id")) {
    const targetedIds = parseTargetedIds(query);
    if (targetedIds instanceof Response) return targetedIds;
    ids = targetedIds;
  }

  const groups = query.has("group") ? parseGroups(query) : [];
  if (groups instanceof Response) return groups;
  return {
    mode: (explicitMode ?? defaultMode) as RandomMethod,
    size: size as RandomImageSize,
    limit,
    ids,
    groups,
    scoped,
    fallback,
    seed,
    device: device as RandomRequestDevice,
    brightness: brightness as RandomBrightness | null,
    theme: theme.selectors,
    tag: tag.expression,
    author: author.selectors
  };
}

/**
 * Keeps known slugs and records the rest, which match no image. Each
 * image has one theme and one author, so a list mixing both forms selects the
 * included slugs that are not excluded.
 */
function knownSelectorGroup(
  selectors: RandomSelectorGroup,
  knownSlugs: ReadonlySet<string>,
  ignored: string[]
): RandomSelectorGroup {
  const known = (terms: string[]) => {
    const slugs: string[] = [];
    for (const term of terms) {
      if (knownSlugs.has(term)) slugs.push(term);
      else ignored.push(term);
    }
    return [...new Set(slugs)].sort();
  };
  const include = known(selectors.include);
  const exclude = known(selectors.exclude);
  if (!selectors.include.length) return { include, exclude };
  const excluded = new Set(exclude);
  return {
    include: include.filter((slug) => !excluded.has(slug)),
    exclude: []
  };
}

/** An all-clause naming an unknown tag cannot match, so only fully known clauses remain. */
function knownTagExpression(
  expression: TagExpression,
  knownSlugs: ReadonlySet<string>,
  ignored: string[]
): TagExpression {
  if (!expression) return null;
  const clauses: string[][] = [];
  for (const clause of expression.anyOf) {
    const slugs = clause.filter((slug) => knownSlugs.has(slug));
    if (slugs.length === clause.length) clauses.push(slugs);
    else ignored.push(...clause.filter((slug) => !knownSlugs.has(slug)));
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
 * Unknown slugs match no image: they drop out of include lists and tag
 * clauses before planning, so they never reach index keys, dedupe or seed
 * signatures. An impossible filter is recorded so selection can try an explicitly
 * requested fallback without querying an index for an unknown slug.
 */
export function normalizeRandomQuery(
  query: ParsedRandomQuery,
  slugs: RandomSelectorSlugs
): NormalizedRandomQuery {
  const ignored: RandomIgnoredSelectors = { theme: [], tag: [], author: [], group: [] };
  const theme = knownSelectorGroup(query.theme, slugs.theme, ignored.theme);
  const tag = knownTagExpression(query.tag, slugs.tag, ignored.tag);
  const author = knownSelectorGroup(query.author, slugs.author, ignored.author);
  const groups = query.groups.filter((slug) => {
    if (slugs.groups?.has(slug)) return true;
    ignored.group.push(slug);
    return false;
  });
  const unmatchable =
    (query.scoped && !query.ids.length && !groups.length) ||
    (query.theme.include.length > 0 && theme.include.length === 0) ||
    (query.tag !== null && tag === null) ||
    (query.author.include.length > 0 && author.include.length === 0);

  const normalized = {
    ...query,
    theme,
    tag,
    author,
    groups,
    ignored
  };
  return {
    ...normalized,
    unmatchable,
    // Compact keys are the existing Redis dedupe-key serialization, not DTO fields.
    // Unscoped requests keep their previous keys; only known groups enter signatures.
    signature: JSON.stringify({
      "d": normalized.device === "auto" ? "" : normalized.device,
      "b": normalized.brightness ?? "",
      "t": normalized.theme,
      tag: normalized.tag,
      "a": normalized.author,
      ...(normalized.ids.length ? { "i": normalized.ids } : {}),
      ...(normalized.groups.length ? { "g": normalized.groups } : {}),
      // The expanded relaxation order: different orders keep separate recent histories.
      ...(normalized.fallback.length ? {
        "f": normalized.fallback,
        "ex": Object.fromEntries((["theme", "author"] as const)
          .filter((field) => query.fallback.includes(field) && query[field].include.length)
          .map((field) => [field, knownSelectorGroup(
            { include: [], exclude: query[field].exclude }, slugs[field], []
          ).exclude]))
      } : {}),
      ...(unmatchable ? { "empty": true } : {})
    })
  };
}
