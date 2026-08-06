import { brightnesses, devices } from "@imageshow/shared/browser";
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

function assertSqlAlias(alias: string | undefined) {
  if (alias !== undefined && !/^[a-z][a-z0-9_]*$/u.test(alias)) {
    throw new Error("Image filter SQL alias is invalid");
  }
}

/**
 * Canonical PostgreSQL predicate builder for public/admin lists, facets and
 * random fallback. Callers may omit the facet axis being counted, but selector
 * NULL/exclusion and tag membership semantics remain owned here.
 */
export function buildImageFilterSql(
  input: ImageFilterSqlInput,
  options: {
    alias?: string;
    omittedAxes?: readonly ImageFilterAxis[];
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
  const axes = input.plan.axes;
  if (!omitted.has("device") && !omitted.has("brightness")) {
    if (axes.length === 0) {
      where.push("FALSE");
    } else if (axes.length < devices.length * brightnesses.length) {
      const predicates = axes.map(({ device, brightness }) => (
        `(${prefix}device=${bind(device)} AND ${prefix}brightness=${bind(brightness)})`
      ));
      where.push(`(${predicates.join(" OR ")})`);
    }
  } else if (!omitted.has("device")) {
    const selectedDevices = [...new Set(axes.map((axis) => axis.device))];
    if (selectedDevices.length < devices.length) {
      where.push(`${prefix}device=ANY(${bind(selectedDevices)}::text[])`);
    }
  } else if (!omitted.has("brightness")) {
    const selectedBrightnesses = [
      ...new Set(axes.map((axis) => axis.brightness))
    ];
    if (selectedBrightnesses.length < brightnesses.length) {
      where.push(
        `${prefix}brightness=ANY(${bind(selectedBrightnesses)}::text[])`
      );
    }
  }

  for (const [axis, column, group] of [
    ["theme", "theme", input.plan.theme],
    ["author", "author", input.plan.author]
  ] as const) {
    if (omitted.has(axis)) continue;
    const selection = selectedValues(group);
    if (!selection) continue;
    const matches = `${prefix}${column}=ANY(${bind(selection.values)}::text[])`;
    where.push(selection.exclude
      ? column === "author"
        ? `(${prefix}author IS NULL OR NOT (${matches}))`
        : `NOT (${matches})`
      : matches);
  }

  if (!omitted.has("tag")) {
    const selection = selectedValues(input.plan.tag);
    if (selection) {
      const exists = `EXISTS (
        SELECT 1
          FROM image_tag ${tagAlias}
         WHERE ${tagAlias}.image_id=${prefix}id
           AND ${tagAlias}.tag_slug=ANY(${bind(selection.values)}::text[])
      )`;
      where.push(selection.exclude ? `NOT ${exists}` : exists);
    }
  }

  return { params, where };
}
