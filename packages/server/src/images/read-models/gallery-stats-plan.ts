import {
  normalizeTagExpression, parseGalleryTagFilter, parseTagFilter, TagFilterError,
  type Brightness, type Device, type TagExpression
} from "@imageshow/shared/browser";
import { ApiError } from "../../core/api-error.ts";
import type { VocabularyReadAccess } from "../../vocab/vocab-cache.ts";
import {
  createImageFilterPlan, resolveImageFilterPlan, resolveImageTagExpressions,
  type ImageFilterPlan
} from "../filter-plan.ts";

export type GalleryStatsQuery = {
  device?: Device;
  brightness?: Brightness;
  theme?: string;
  tag?: string | string[];
  author?: string;
  /** One-based AND group whose selected tags constrain candidate counts. */
  tag_scope?: number;
};

export type GalleryTagCountPlans = {
  candidates: ImageFilterPlan;
  groups: ImageFilterPlan[];
  signature: string;
};

export async function resolveGalleryStatsPlan(query: GalleryStatsQuery, access: VocabularyReadAccess) {
  const values = query.tag === undefined ? [] : typeof query.tag === "string" ? [query.tag] : query.tag;
  let groups: ReturnType<typeof parseTagFilter>[];
  try {
    parseGalleryTagFilter(values);
    groups = values.map((value) => parseTagFilter([value]));
  } catch (error) {
    if (!(error instanceof TagFilterError)) throw error;
    throw new ApiError(400, "validation_error", error.message, { field: "tag" });
  }
  const scope = query.tag_scope;
  if (scope !== undefined && (!Number.isInteger(scope) || scope < 1 || groups[scope - 1]?.mode !== "all")) {
    throw new ApiError(400, "validation_error", "标签计数范围必须指向已选的且组", { field: "tag_scope" });
  }
  const [base, expressions] = await Promise.all([
    resolveImageFilterPlan({ ...query, tag: undefined }, access),
    resolveImageTagExpressions(groups.map((group) => group.expression), access)
  ]);
  if (!expressions.length) return { plan: base, tagCounts: undefined };

  const withTags = (tag: TagExpression) => createImageFilterPlan({
    devices: base.axes.map((axis) => axis.device),
    brightnesses: base.axes.map((axis) => axis.brightness),
    theme: base.theme, author: base.author, tag
  });
  const plan = withTags(normalizeTagExpression(expressions.flatMap((expression) => expression?.anyOf ?? [])));
  const groupPlans = expressions.map(withTags);
  const candidates = scope === undefined ? base : groupPlans[scope - 1]!;
  const tagCounts: GalleryTagCountPlans = {
    candidates, groups: groupPlans,
    signature: JSON.stringify([plan.signature, candidates.signature, groupPlans.map((group) => group.signature)])
  };
  return { plan, tagCounts };
}
