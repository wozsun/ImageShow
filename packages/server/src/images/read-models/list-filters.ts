import type { Brightness, Device } from "@imageshow/shared/browser";
import {
  resolveImageFilterPlan,
  type ImageFilterPlan
} from "../filter-plan.ts";
import type { VocabularyReadAccess } from "../../vocab/vocab-cache.ts";
import { buildImageFilterSql } from "./image-filter-sql.ts";

export type ImageListFilterQuery = {
  status: "ready" | "deleted";
  d?: Device;
  b?: Brightness;
  t?: string;
  tag?: string;
  a?: string;
};

/**
 * Public and admin image lists intentionally share one set of PostgreSQL
 * filters. Pagination and total counts can clone the returned arrays, but
 * must not rebuild only a subset of these clauses.
 */
export async function buildImageListFilters(
  query: ImageListFilterQuery,
  access: VocabularyReadAccess = {}
) {
  const plan = await resolveImageFilterPlan(query, access);
  return buildImageFilterSql({
    status: query.status,
    plan
  });
}

/** Reuses the canonical selector plan already resolved for the Redis read. */
export function buildResolvedReadyImageListFilters(
  plan: ImageFilterPlan
) {
  return buildImageFilterSql({
    status: "ready",
    plan
  });
}
