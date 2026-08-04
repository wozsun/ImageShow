import { appConfig } from "@imageshow/shared";
import {
  randomMethods as randomMethodValues,
  type RandomMethod
} from "@imageshow/shared/browser";
import { apiErrorResponse } from "../core/http/responses.ts";

export const randomDevices = ["pc", "mb"] as const;
export const randomBrightnesses = ["dark", "light"] as const;
const randomRequestDeviceValues = ["pc", "mb", "r"] as const;
export type RandomBrightness = (typeof randomBrightnesses)[number];
type RandomRequestDevice = (typeof randomRequestDeviceValues)[number];

export type RandomSelectorGroup = {
  include: string[];
  exclude: string[];
};

export type ParsedRandomQuery = {
  method: RandomMethod;
  resultLimit: number;
  ids: string[];
  requestedDevice: RandomRequestDevice | null;
  requestedBrightness: RandomBrightness | null;
  theme: RandomSelectorGroup;
  tag: RandomSelectorGroup;
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
const randomAllowedQueryValues = ["d", "b", "t", "tag", "a", "id", "m", "n"] as const;
const randomAllowedQuery = new Set<string>(randomAllowedQueryValues);
const randomSingleValueQuery = new Set(["d", "b", "m", "n"]);
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
  field: "t" | "tag" | "a",
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
    [...query.keys()].filter((key) => key !== "id" && key !== "m" && key !== "n")
  )].sort();
  if (!incompatible.length) return null;
  return apiErrorResponse(
    { status: 400, message: "Bad Request: id cannot be combined with filters" },
    {
      field: "id",
      incompatible,
      hint: "id can only be combined with m and n"
    }
  );
}

function parseJsonResultLimit(
  query: URLSearchParams,
  explicitMethod: string | null
): number | Response {
  if (!query.has("n")) return 1;
  if (explicitMethod !== "json") {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: n requires m=json" },
      { field: "n", hint: "Use n only with an explicit m=json parameter" }
    );
  }

  const raw = query.get("n") ?? "";
  if (!/^\d+$/u.test(raw)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid result count" },
      { field: "n", hint: "Use a positive integer" }
    );
  }
  const significant = raw.replace(/^0+/u, "");
  if (!significant) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid result count" },
      { field: "n", hint: "Use a positive integer" }
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

export function parseRandomQuery(
  url: URL,
  defaultMethod: RandomMethod
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

  const explicitMethod = query.get("m")?.toLowerCase() ?? null;
  if (query.has("m") && (!explicitMethod || !randomMethods.has(explicitMethod))) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid method" },
      { field: "m" }
    );
  }
  const resultLimit = parseJsonResultLimit(query, explicitMethod);
  if (resultLimit instanceof Response) return resultLimit;
  const targetedCombinationError = targetedIdCombinationError(query);
  if (targetedCombinationError) return targetedCombinationError;
  if (query.has("id")) {
    const ids = parseTargetedIds(query);
    if (ids instanceof Response) return ids;
    return {
      method: (explicitMethod ?? defaultMethod) as RandomMethod,
      resultLimit,
      ids,
      requestedDevice: null,
      requestedBrightness: null,
      theme: { include: [], exclude: [] },
      tag: { include: [], exclude: [] },
      author: { include: [], exclude: [] }
    };
  }
  const requestedBrightness = query.get("b")?.toLowerCase() || null;
  if (requestedBrightness && !isRandomBrightness(requestedBrightness)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid brightness" },
      { field: "b" }
    );
  }
  const requestedDevice = query.get("d")?.toLowerCase() || null;
  if (requestedDevice && !randomRequestDevices.has(requestedDevice)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid device" },
      { field: "d" }
    );
  }

  const theme = parseSelectorGroup(query, "t", "theme");
  if (theme instanceof Response) return theme;
  const tag = parseSelectorGroup(query, "tag", "tag");
  if (tag instanceof Response) return tag;
  const author = parseSelectorGroup(query, "a", "author");
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
    method: (explicitMethod ?? defaultMethod) as RandomMethod,
    resultLimit,
    ids: [],
    requestedDevice: requestedDevice as RandomRequestDevice | null,
    requestedBrightness: requestedBrightness as RandomBrightness | null,
    theme: theme.selectors,
    tag: tag.selectors,
    author: author.selectors
  };
}

function normalizeSelectorGroup(
  field: "t" | "tag" | "a",
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
  const theme = normalizeSelectorGroup("t", "theme", query.theme, maps.theme);
  if (theme instanceof Response) return theme;
  const tag = normalizeSelectorGroup("tag", "tag", query.tag, maps.tag);
  if (tag instanceof Response) return tag;
  const author = normalizeSelectorGroup("a", "author", query.author, maps.author);
  if (author instanceof Response) return author;

  const normalized = {
    ...query,
    theme,
    tag,
    author
  };
  return {
    ...normalized,
    signature: JSON.stringify({
      d: normalized.requestedDevice ?? "",
      b: normalized.requestedBrightness ?? "",
      t: normalized.theme,
      tag: normalized.tag,
      a: normalized.author
    })
  };
}
