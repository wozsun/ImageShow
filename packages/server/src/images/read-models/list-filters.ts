import { resolveAuthorSlugs } from "../../authors/query.ts";
import { ApiError } from "../../core/api-error.ts";
import { splitSelectors } from "../../core/selectors.ts";
import { resolveTagNames } from "../../tags/query.ts";
import { resolveThemeSlugs } from "../../themes/query.ts";

export type ImageListFilterQuery = {
  status: "ready" | "deleted";
  d?: string;
  b?: string;
  t?: string;
  tag?: string;
  a?: string;
};

async function selectorFilter(
  rawValue: string,
  params: unknown[],
  resolve: (terms: string[]) => Promise<string[]>,
  noun: string,
  clause: (paramIndex: number, exclude: boolean) => string
) {
  const { include, exclude } = splitSelectors([rawValue]);
  if (include.length && exclude.length) {
    throw new ApiError(
      400,
      "validation_error",
      `Cannot mix include and exclude ${noun} selectors`
    );
  }

  const isExclude = exclude.length > 0;
  params.push(await resolve(isExclude ? exclude : include));
  return clause(params.length, isExclude);
}

/**
 * Public and admin image lists intentionally share one set of PostgreSQL
 * filters. Pagination and total counts can clone the returned arrays, but
 * must not rebuild only a subset of these clauses.
 */
export async function buildImageListFilters(query: ImageListFilterQuery) {
  const params: unknown[] = [query.status];
  const where = ["status = $1"];

  if (query.d) {
    params.push(query.d);
    where.push(`device = $${params.length}`);
  }
  if (query.b) {
    params.push(query.b);
    where.push(`brightness = $${params.length}`);
  }
  if (query.t) {
    where.push(await selectorFilter(
      query.t,
      params,
      resolveThemeSlugs,
      "theme",
      (index, exclude) => exclude
        ? `NOT (theme = ANY($${index}::text[]))`
        : `theme = ANY($${index}::text[])`
    ));
  }
  if (query.tag) {
    where.push(await selectorFilter(
      query.tag,
      params,
      resolveTagNames,
      "tag",
      (index, exclude) => exclude
        ? `NOT (id IN (SELECT image_id FROM image_tag WHERE tag_slug = ANY($${index}::text[])))`
        : `id IN (SELECT image_id FROM image_tag WHERE tag_slug = ANY($${index}::text[]))`
    ));
  }
  if (query.a) {
    where.push(await selectorFilter(
      query.a,
      params,
      resolveAuthorSlugs,
      "author",
      (index, exclude) => exclude
        ? `(author IS NULL OR NOT (author = ANY($${index}::text[])))`
        : `author = ANY($${index}::text[])`
    ));
  }

  return { params, where };
}
