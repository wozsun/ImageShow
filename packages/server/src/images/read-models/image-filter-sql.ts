import { brightnesses, devices, unsetSelector } from "@imageshow/shared/browser";
import type {
  ImageFilterDimension,
  ImageFilterPlan,
  ImageSelectorGroup
} from "../filter-plan.ts";

export type ImageFilterAxis = ImageFilterDimension;

export type ImageFilterSqlInput = {
  status: "ready" | "deleted";
  plan: ImageFilterPlan;
};

/** Keyset boundary on the image ID, which also orders images by image time. */
export type ImageIdBound = {
  comparison: "<" | ">";
  id: string;
};

function selectedValues(group: ImageSelectorGroup) {
  if (group.include.length && group.exclude.length) {
    throw new Error("Image filter selector group mixes include and exclude");
  }
  if (group?.include.length) {
    return { exclude: false, values: group.include };
  }
  if (group?.exclude.length) {
    return { exclude: true, values: group.exclude };
  }
  return null;
}

/** A single value compares with "=" so PostgreSQL can walk a (value, id) index in ID order; "= ANY" cannot promise that order even for one element. */
function textMatch(column: string, values: readonly string[], bind: (value: unknown) => string) {
  return values.length === 1
    ? `${column}=${bind(values[0])}`
    : `${column}=ANY(${bind(values)}::text[])`;
}

function assertSqlAlias(alias: string | undefined) {
  if (alias !== undefined && !/^[a-z][a-z0-9_]*$/u.test(alias)) {
    throw new Error("Image filter SQL alias is invalid");
  }
}

/**
 * Canonical PostgreSQL predicate builder for public/admin lists, facets and
 * random fallback. Callers may omit the facet axis being counted, but selector
 * NULL/exclusion and tag membership semantics remain owned here. An ID bound
 * also limits tag membership, so an ID-ordered merge with image_tag starts at
 * the boundary instead of the newest tag rows.
 */
export function buildImageFilterSql(
  input: ImageFilterSqlInput,
  options: {
    alias?: string;
    omittedAxes?: readonly ImageFilterAxis[];
    idBound?: ImageIdBound;
  } = {}
) {
  assertSqlAlias(options.alias);
  const prefix = options.alias ? `${options.alias}.` : "";
  const tagAlias = `${options.alias ?? "image"}_filter_tag`;
  const omitted = new Set(options.omittedAxes ?? []);
  const params: unknown[] = [];
  const where: string[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  where.push(`${prefix}status=${bind(input.status)}`);
  const idBound = options.idBound
    ? `${options.idBound.comparison} ${bind(options.idBound.id)}::uuid`
    : null;
  if (idBound) where.push(`${prefix}id ${idBound}`);
  const axes = input.plan.axes;
  if (!omitted.has("device") && !omitted.has("brightness")) {
    if (axes.length === 0) {
      where.push("FALSE");
    } else if (axes.length < devices.length * brightnesses.length) {
      const predicates = axes.map(
        ({ device, brightness }) =>
          `(${prefix}device=${bind(device)} AND ${prefix}brightness=${bind(brightness)})`
      );
      where.push(`(${predicates.join(" OR ")})`);
    }
  } else if (!omitted.has("device")) {
    const selectedDevices = [...new Set(axes.map((axis) => axis.device))];
    if (selectedDevices.length < devices.length) {
      where.push(`${prefix}device=ANY(${bind(selectedDevices)}::text[])`);
    }
  } else if (!omitted.has("brightness")) {
    const selectedBrightnesses = [...new Set(axes.map((axis) => axis.brightness))];
    if (selectedBrightnesses.length < brightnesses.length) {
      where.push(`${prefix}brightness=ANY(${bind(selectedBrightnesses)}::text[])`);
    }
  }

  for (const [axis, column, group] of [
    ["theme", "theme", input.plan.theme],
    ["author", "author", input.plan.author]
  ] as const) {
    if (omitted.has(axis)) continue;
    const selection = selectedValues(group);
    if (!selection) continue;
    const includesNull = selection.values.includes(unsetSelector);
    const values = includesNull
      ? selection.values.filter((value) => value !== unsetSelector)
      : selection.values;
    const matches = textMatch(`${prefix}${column}`, values, bind);
    where.push(
      selection.exclude
        ? includesNull
          ? `(${prefix}${column} IS NOT NULL AND NOT (${matches}))`
          : `(${prefix}${column} IS NULL OR NOT (${matches}))`
        : includesNull
          ? `(${prefix}${column} IS NULL OR ${matches})`
          : matches
    );
  }

  if (!omitted.has("tag") && input.plan.tag) {
    const clauses = input.plan.tag.anyOf;
    const singletons = clauses.filter((clause) => clause.length === 1).flat()
      .filter((slug) => slug !== unsetSelector);
    const predicates: string[] = [];
    if (clauses.some((clause) => clause.length === 1 && clause[0] === unsetSelector)) {
      predicates.push(`NOT EXISTS (
        SELECT 1 FROM image_tag ${tagAlias} WHERE ${tagAlias}.image_id=${prefix}id
      )`);
    }
    if (singletons.length) {
      predicates.push(`EXISTS (
        SELECT 1
          FROM image_tag ${tagAlias}
         WHERE ${tagAlias}.image_id=${prefix}id
           AND ${textMatch(`${tagAlias}.tag_slug`, singletons, bind)}${idBound ? `
           AND ${tagAlias}.image_id ${idBound}` : ""}
      )`);
    }
    for (const clause of clauses.filter((clause) => clause.length > 1)) {
      // An image cannot be untagged and carry a named tag at the same time.
      if (clause.includes(unsetSelector)) continue;
      predicates.push(`NOT EXISTS (
        SELECT 1 FROM unnest(${bind(clause)}::text[]) AS selected_tag(slug)
        WHERE NOT EXISTS (
          SELECT 1 FROM image_tag ${tagAlias}
          WHERE ${tagAlias}.image_id=${prefix}id
            AND ${tagAlias}.tag_slug=selected_tag.slug
        )
      )`);
    }
    where.push(predicates.length ? `(${predicates.join(" OR ")})` : "FALSE");
  }

  if (!omitted.has("tag") && input.plan.tagExclude.length) {
    if (input.plan.tagExclude.includes(unsetSelector)) {
      where.push(`EXISTS (
        SELECT 1 FROM image_tag ${tagAlias} WHERE ${tagAlias}.image_id=${prefix}id
      )`);
    }
    const excludedTags = input.plan.tagExclude.filter((slug) => slug !== unsetSelector);
    if (excludedTags.length) {
      where.push(`NOT EXISTS (
        SELECT 1 FROM image_tag ${tagAlias}
        WHERE ${tagAlias}.image_id=${prefix}id
          AND ${tagAlias}.tag_slug=ANY(${bind(excludedTags)}::text[])
      )`);
    }
  }

  if (input.plan.range) {
    const { groups, ids } = input.plan.range;
    const range: string[] = [];
    if (groups.length) {
      range.push(`EXISTS(SELECT 1 FROM image_group_member member
        WHERE member.image_id=${prefix}id AND member.group_slug=ANY(${bind(groups)}::text[]))`);
    }
    const fullIds = ids.filter((id) => id.length > 12);
    const suffixes = ids.filter((id) => id.length === 12);
    if (fullIds.length) range.push(`${prefix}id=ANY(${bind(fullIds)}::uuid[])`);
    if (suffixes.length) range.push(`right(${prefix}id::text,12)=ANY(${bind(suffixes)}::text[])`);
    where.push(range.length ? `(${range.join(" OR ")})` : "FALSE");
  }

  return { params, where };
}
