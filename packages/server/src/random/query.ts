import { appConfig } from "@imageshow/shared";
import {
  parseTagFilter,
  resolveTagExpression,
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
  size: RandomImageSize | null;
  limit: number;
  ids: string[];
  seed: string | null;
  device: RandomRequestDevice;
  brightness: RandomBrightness | null;
  theme: RandomSelectorGroup;
  tag: TagExpression;
  author: RandomSelectorGroup;
};

export type NormalizedRandomQuery = ParsedRandomQuery & {
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

function targetedIdCombinationError(query: URLSearchParams) {
  if (!query.has("id")) return null;
  const incompatible = [...new Set(
    [...query.keys()].filter((key) => (
      key !== "id"
      && key !== "mode"
      && key !== "size"
      && key !== "limit"
      && !(key === "device" && query.get(key)?.toLowerCase() === "auto")
    ))
  )].sort();
  if (!incompatible.length) return null;
  return apiErrorResponse(
    { status: 400, message: "Bad Request: id cannot be combined with filters" },
    {
      field: "id",
      incompatible,
      hint: "id can only be combined with device=auto, mode, size, and limit"
    }
  );
}

function parseJsonLimit(
  query: URLSearchParams,
  explicitMode: string | null
): number | Response {
  if (!query.has("limit")) return 1;
  if (explicitMode !== "json") {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: limit requires mode=json" },
      {
        field: "limit",
        hint: "Use limit only with an explicit mode=json parameter"
      }
    );
  }

  const raw = query.get("limit") ?? "";
  if (!/^\d+$/u.test(raw)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid result count" },
      { field: "limit", hint: "Use a positive integer" }
    );
  }
  const significant = raw.replace(/^0+/u, "");
  if (!significant) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid result count" },
      { field: "limit", hint: "Use a positive integer" }
    );
  }

  const maximum = String(appConfig.randomQuery.maxJsonItems);
  if (
    significant.length > maximum.length
    || (significant.length === maximum.length && significant > maximum)
  ) {
    return appConfig.randomQuery.maxJsonItems;
  }
  return Number(significant);
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

function parseSeed(query: URLSearchParams, limit: number): string | null | Response {
  const seed = query.get("seed");
  if (seed === null) return null;
  if (
    !seed.trim()
    || disallowedSelectorCharacters.test(seed)
    || [...seed].length > appConfig.randomQuery.maxSeedCharacters
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
  if (limit !== 1) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: seed only supports one image" },
      { field: "limit", hint: "Omit limit or use limit=1 with mode=json" }
    );
  }
  return seed;
}

export function parseRandomQuery(
  url: URL,
  defaultMode: RandomDefaultMethod,
  defaultSize: RandomImageSize = "full"
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

  const explicitMode = query.get("mode")?.toLowerCase() ?? null;
  if (query.has("mode") && (!explicitMode || !randomMethods.has(explicitMode))) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid mode" },
      { field: "mode" }
    );
  }
  const size = query.get("size")?.toLowerCase()
    ?? (explicitMode === "json" ? null : defaultSize);
  if (size !== null && !randomSizes.has(size)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid size" },
      { field: "size", allowedValues: randomImageSizes }
    );
  }
  const limit = parseJsonLimit(query, explicitMode);
  if (limit instanceof Response) return limit;
  const seed = parseSeed(query, limit);
  if (seed instanceof Response) return seed;
  const targetedCombinationError = targetedIdCombinationError(query);
  if (targetedCombinationError) return targetedCombinationError;
  if (query.has("id")) {
    const ids = parseTargetedIds(query);
    if (ids instanceof Response) return ids;
    return {
      mode: (explicitMode ?? defaultMode) as RandomMethod,
      size: size as RandomImageSize | null,
      limit,
      ids,
      seed,
      device: "auto",
      brightness: null,
      theme: { include: [], exclude: [] },
      tag: null,
      author: { include: [], exclude: [] }
    };
  }
  const brightness = query.get("brightness")?.toLowerCase() || null;
  if (brightness && !isRandomBrightness(brightness)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid brightness" },
      { field: "brightness" }
    );
  }
  const device = query.get("device")?.toLowerCase() || "auto";
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
    tag = parseTagFilter(query.getAll("tag"), "mixed");
  } catch (error) {
    if (!(error instanceof TagFilterError)) throw error;
    return apiErrorResponse({ status: 400, message: error.message }, { field: "tag" });
  }
  const author = parseSelectorGroup(query, "author", "author");
  if (author instanceof Response) return author;
  const selectorCount =
    theme.submittedCount + tag.submittedCount + author.submittedCount;
  if (selectorCount > appConfig.randomQuery.maxSelectorCount) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Too many selectors" },
      { maxSelectors: appConfig.randomQuery.maxSelectorCount }
    );
  }

  return {
    mode: (explicitMode ?? defaultMode) as RandomMethod,
    size: size as RandomImageSize | null,
    limit,
    ids: [],
    seed,
    device: device as RandomRequestDevice,
    brightness: brightness as RandomBrightness | null,
    theme: theme.selectors,
    tag: tag.expression,
    author: author.selectors
  };
}

function normalizeSelectorGroup(
  field: "theme" | "author",
  noun: string,
  selectors: RandomSelectorGroup,
  map: ReadonlyMap<string, string>
): RandomSelectorGroup | Response {
  const include: string[] = [];
  const exclude: string[] = [];
  for (const term of selectors.include) {
    const slug = map.get(term);
    if (!slug) {
      return apiErrorResponse(
        { status: 404, message: `Not Found: Unknown ${noun} selector` },
        { field, value: term }
      );
    }
    include.push(slug);
  }
  for (const term of selectors.exclude) {
    const slug = map.get(term);
    if (slug) exclude.push(slug);
  }
  return {
    include: [...new Set(include)].sort(),
    exclude: [...new Set(exclude)].sort()
  };
}

export function normalizeRandomQuery(
  query: ParsedRandomQuery,
  maps: RandomSelectorMaps
): NormalizedRandomQuery | Response {
  const theme = normalizeSelectorGroup(
    "theme",
    "theme",
    query.theme,
    maps.theme
  );
  if (theme instanceof Response) return theme;
  let tag: TagExpression;
  try {
    tag = resolveTagExpression(query.tag, maps.tag);
  } catch (error) {
    if (!(error instanceof TagFilterError)) throw error;
    return apiErrorResponse({ status: 404, message: error.message }, { field: "tag", value: error.term });
  }
  const author = normalizeSelectorGroup(
    "author",
    "author",
    query.author,
    maps.author
  );
  if (author instanceof Response) return author;

  const normalized = {
    ...query,
    theme,
    tag,
    author
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
