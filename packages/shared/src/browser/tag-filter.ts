import { randomQueryLimits } from "./common.ts";

export type TagClause = readonly [string, ...string[]];
export type TagExpression = { anyOf: readonly [TagClause, ...TagClause[]] } | null;
export type TagMatchMode = "any" | "all";
export type TagFilterValue = string | string[];
export const publicTagGroupLimit = 9;

export function tagFilterValues(value: TagFilterValue): string[] {
  return typeof value === "string" ? (value ? [value] : []) : value;
}

export const tagFilterLimits = Object.freeze({
  terms: randomQueryLimits.maxSelectorsPerField,
  segments: randomQueryLimits.maxSelectorsPerField,
  termCharacters: randomQueryLimits.maxSelectorCharacters,
  basicCharacters: 1024
});

export class TagFilterError extends Error {
  readonly kind: "invalid" | "mixed" | "unknown";
  readonly term?: string;

  constructor(
    message: string,
    kind: "invalid" | "mixed" | "unknown" = "invalid",
    term?: string
  ) {
    super(message);
    this.name = "TagFilterError";
    this.kind = kind;
    this.term = term;
  }
}

/** Only ordering and exact duplicates are normalized; branches are never absorbed. */
export function normalizeTagExpression(
  clauses: readonly (readonly string[])[]
): NonNullable<TagExpression> {
  if (!clauses.length || clauses.some((clause) => !clause.length || clause.some((term) => !term))) {
    throw new TagFilterError("标签条件不能为空");
  }
  const unique = new Map<string, TagClause>();
  for (const clause of clauses) {
    const terms = [...new Set(clause)].sort() as [string, ...string[]];
    unique.set(JSON.stringify(terms), terms);
  }
  const sorted = [...unique].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { anyOf: sorted.map(([, clause]) => clause) as [TagClause, ...TagClause[]] };
}

export function parseTagFilter(
  values: readonly string[],
  capability: "basic" | "mixed" = "basic"
) {
  if (!values.length) return { expression: null, mode: "any" as TagMatchMode, termCount: 0 };
  if (
    values.length > tagFilterLimits.segments ||
    (capability === "basic" &&
      values.reduce((sum, value) => sum + value.length, 0) > tagFilterLimits.basicCharacters)
  ) {
    throw new TagFilterError("标签条件超过长度或段数限制");
  }
  const clauses: string[][] = [];
  for (const value of values) {
    const raw = value.trim();
    const all = /^all:/iu.test(raw);
    const terms = (all ? raw.slice(4) : raw).split(",").map((part) => {
      const term = part.trim();
      if (
        !term ||
        /^[!:]/u.test(term) ||
        /^all:/iu.test(term) ||
        /[\u0000-\u001f\u007f]/u.test(term)
      ) {
        throw new TagFilterError("标签条件格式无效");
      }
      if ([...term].length > tagFilterLimits.termCharacters)
        throw new TagFilterError("标签词项过长");
      return term.toLowerCase();
    });
    clauses.push(...(all ? [terms] : terms.map((term) => [term])));
  }
  const expression = normalizeTagExpression(clauses);
  const termCount = expression.anyOf.reduce((sum, clause) => sum + clause.length, 0);
  if (termCount > tagFilterLimits.terms) throw new TagFilterError("标签词项去重后最多 32 个");
  const singletons = expression.anyOf.every((clause) => clause.length === 1);
  if (capability === "basic" && !singletons && expression.anyOf.length !== 1) {
    throw new TagFilterError("此选择方式仅支持标签任一或全部", "mixed");
  }
  const explicitAll = values.length === 1 && /^all:/iu.test(values[0]!.trim());
  const mode: TagMatchMode =
    expression.anyOf.length === 1 && (!singletons || explicitAll) ? "all" : "any";
  return { expression, mode, termCount };
}

export function resolveTagExpression(
  expression: TagExpression,
  terms: ReadonlyMap<string, string>
): TagExpression {
  if (!expression) return null;
  return normalizeTagExpression(
    expression.anyOf.map((clause) =>
      clause.map((term) => {
        const slug = terms.get(term);
        if (!slug) throw new TagFilterError(`未知标签：${term}`, "unknown", term);
        return slug;
      })
    )
  );
}

export function tagExpressionValues(expression: TagExpression, mode?: TagMatchMode): string[] {
  if (!expression) return [];
  const normalized = normalizeTagExpression(expression.anyOf);
  if (mode === "all" && normalized.anyOf.length === 1) {
    return [`all:${normalized.anyOf[0].join(",")}`];
  }
  const singles = normalized.anyOf.filter((clause) => clause.length === 1).flat();
  return [
    ...(singles.length ? [singles.sort().join(",")] : []),
    ...normalized.anyOf
      .filter((clause) => clause.length > 1)
      .map((clause) => `all:${clause.join(",")}`)
  ];
}

export function parseGalleryTagFilter(values: readonly string[]) {
  if (values.length > publicTagGroupLimit) throw new TagFilterError("标签最多可分为 9 组");
  if (values.reduce((sum, value) => sum + value.length, 0) > tagFilterLimits.basicCharacters) {
    throw new TagFilterError("标签条件超过长度限制");
  }
  return parseTagFilter(values, "mixed");
}

export function basicTagSelection(value: TagFilterValue) {
  const parsed = parseTagFilter(tagFilterValues(value));
  return { mode: parsed.mode, selected: [...new Set(parsed.expression?.anyOf.flat() ?? [])] };
}

export function basicTagValue(selected: readonly string[], mode: TagMatchMode) {
  if (!selected.length) return "";
  const values = [...new Set(selected)].sort();
  const value = `${mode === "all" ? "all:" : ""}${values.join(",")}`;
  parseTagFilter([value]);
  return value;
}

/** Encode individual values, leaving only the supported filter punctuation readable. */
export function readableFilterSearch(params: URLSearchParams) {
  return [...params]
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)
          .replace(/%2C/giu, ",")
          .replace(/%3A/giu, ":")
          .replace(/%21/giu, "!")}`
    )
    .join("&");
}
