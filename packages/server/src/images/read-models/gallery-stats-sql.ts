import { appConfig } from "@imageshow/shared";
import { unsetThemeFilter, type Brightness, type Device } from "@imageshow/shared/browser";
import { withTransactionOnClient } from "../../core/database/transactions.ts";
import { publicPgFallbackWorkLimitExceeded } from "../../core/database/public-fallback.ts";
import type { DatabaseReader } from "../../core/database/pools.ts";
import { imageFilterPlanWithout, type ImageFilterPlan } from "../filter-plan.ts";
import type { GalleryTagCountPlans } from "./gallery-stats-plan.ts";
import {
  activeReadyImageCounts,
  isUnfilteredReadyImagePlan,
  nonNegativeReadyImageCount,
  type ReadyImageCountSnapshot
} from "../ready-cache/counts/model.ts";
import type { ReadyImageCountContext } from "../ready-cache/counts/query.ts";
import { getReadyImageRevision } from "../ready-cache/revision.ts";
import { buildImageFilterSql, type ImageFilterAxis } from "./image-filter-sql.ts";

type CountRow = { image_count: number };
type CategoryRow = CountRow & { device: Device; brightness: Brightness };
type MemberCountRow = CountRow & { slug: string };

function count(value: unknown) {
  const result = nonNegativeReadyImageCount(value);
  if (result === null) throw new Error("Invalid gallery image count");
  return result;
}

function countsBy<T extends CountRow>(rows: T[], key: (row: T) => string) {
  return Object.fromEntries(rows.map((row) => [key(row), count(row.image_count)]));
}

function categorySnapshot(rows: CategoryRow[]) {
  let matching = 0;
  const axes: Record<string, number> = {};
  const devices: Record<string, number> = {};
  const brightnesses: Record<string, number> = {};
  // Validate and sum the complete grouping before projecting supported UI axes.
  for (const row of rows) {
    const value = count(row.image_count);
    matching = count(matching + value);
    axes[`${row.device}:${row.brightness}`] = value;
    devices[row.device] = count((devices[row.device] ?? 0) + value);
    brightnesses[row.brightness] = count((brightnesses[row.brightness] ?? 0) + value);
  }
  return { matching, axes, devices, brightnesses };
}

// Candidate counts omit their own axis, preserving OR within and AND across axes.
async function filteredRows<T>(
  client: DatabaseReader,
  plan: ImageFilterPlan,
  omittedAxes: readonly ImageFilterAxis[],
  sql: (where: string, rowLimit: string) => string
) {
  const clause = buildImageFilterSql({ status: "ready", plan }, { alias: "m", omittedAxes });
  clause.params.push(appConfig.publicPgFallback.maximumVocabularyRows + 1);
  const result = await client.query(
    sql(clause.where.join(" AND "), `$${clause.params.length}`),
    clause.params
  );
  if (result.rows.length > appConfig.publicPgFallback.maximumVocabularyRows) {
    throw publicPgFallbackWorkLimitExceeded("Gallery statistics exceed the public result limit");
  }
  return result.rows as T[];
}

function countsForGlobalMembers(
  rows: MemberCountRow[],
  globalStats: Map<string, number>,
  prefix: string
) {
  const members = Object.keys(activeReadyImageCounts(globalStats, prefix));
  if (members.length > appConfig.publicPgFallback.maximumVocabularyRows) {
    throw publicPgFallbackWorkLimitExceeded("Gallery statistics exceed the public result limit");
  }
  const result: Record<string, number> = Object.fromEntries(members.map((slug) => [slug, 0]));
  for (const row of rows) {
    if (!Object.hasOwn(result, row.slug))
      throw new Error("Gallery count member is outside its revision snapshot");
    result[row.slug] = count(row.image_count);
  }
  return result;
}

async function readFacetCounts(
  client: DatabaseReader,
  plan: ImageFilterPlan,
  globalStats: Map<string, number> | null,
  tagCandidates: ImageFilterPlan
) {
  if (globalStats) {
    const themeRows = await filteredRows<MemberCountRow>(
      client,
      plan,
      ["theme"],
      (where, limit) =>
        `SELECT coalesce(m.theme, '${unsetThemeFilter}') AS slug, count(*)::int AS image_count
         FROM metadata m WHERE ${where} GROUP BY m.theme LIMIT ${limit}`
    );
    const tagRows = await filteredRows<MemberCountRow>(
      client,
      tagCandidates,
      [],
      (where, limit) =>
        `SELECT facet_it.tag_slug AS slug, count(*)::int AS image_count
         FROM metadata m JOIN image_tag facet_it ON facet_it.image_id=m.id
        WHERE ${where} GROUP BY facet_it.tag_slug LIMIT ${limit}`
    );
    const authorRows = await filteredRows<MemberCountRow>(
      client,
      plan,
      ["author"],
      (where, limit) =>
        `SELECT m.author AS slug, count(*)::int AS image_count
         FROM metadata m WHERE ${where} AND m.author IS NOT NULL
        GROUP BY m.author LIMIT ${limit}`
    );
    return {
      themes: countsForGlobalMembers(themeRows, globalStats, "theme:"),
      tags: countsForGlobalMembers(tagRows, globalStats, "tag:"),
      authors: countsForGlobalMembers(authorRows, globalStats, "author:")
    };
  }

  // Without a revision snapshot, membership is every value on a ready image.
  const themeRows = await filteredRows<MemberCountRow>(
    client,
    plan,
    ["theme"],
    (where, limit) =>
      `SELECT coalesce(m.theme, '${unsetThemeFilter}') AS slug,
            (count(*) FILTER (WHERE ${where}))::int AS image_count
       FROM metadata m WHERE m.status='ready' GROUP BY m.theme LIMIT ${limit}`
  );
  const tagRows = await filteredRows<MemberCountRow>(
    client,
    tagCandidates,
    [],
    (where, limit) =>
      `SELECT facet_it.tag_slug AS slug,
            (count(*) FILTER (WHERE ${where}))::int AS image_count
       FROM metadata m JOIN image_tag facet_it ON facet_it.image_id=m.id
      WHERE m.status='ready' GROUP BY facet_it.tag_slug LIMIT ${limit}`
  );
  const authorRows = await filteredRows<MemberCountRow>(
    client,
    plan,
    ["author"],
    (where, limit) =>
      `SELECT m.author AS slug,
            (count(*) FILTER (WHERE ${where}))::int AS image_count
       FROM metadata m WHERE m.status='ready' AND m.author IS NOT NULL
      GROUP BY m.author LIMIT ${limit}`
  );
  return {
    themes: countsBy(themeRows, (row) => row.slug),
    tags: countsBy(tagRows, (row) => row.slug),
    authors: countsBy(authorRows, (row) => row.slug)
  };
}

async function readTagGroupCounts(
  client: DatabaseReader,
  plan: ImageFilterPlan,
  matching: number,
  groups: ImageFilterPlan[]
) {
  const counts = new Map([[plan.signature, matching]]);
  const pending = [
    ...new Map(
      groups
        .filter((group) => !counts.has(group.signature))
        .map((group) => [group.signature, group])
    ).values()
  ];
  if (pending.length) {
    const params: unknown[] = [];
    const columns = pending.map((group, index) => {
      const clause = buildImageFilterSql({ status: "ready", plan: group }, { alias: "m" });
      const offset = params.length;
      const where = clause.where
        .join(" AND ")
        .replace(/\$(\d+)/g, (_, position: string) => `$${offset + Number(position)}`);
      params.push(...clause.params);
      return `(count(*) FILTER (WHERE ${where}))::int AS group_${index}`;
    });
    const result = await client.query(
      `SELECT ${columns.join(", ")} FROM metadata m WHERE m.status='ready'`,
      params
    );
    pending.forEach((group, index) => {
      const value = count(result.rows[0]?.[`group_${index}`]);
      if (value > matching) throw new Error("Tag group count exceeds the combined result");
      counts.set(group.signature, value);
    });
  }
  return groups.map((group) => counts.get(group.signature)!);
}

export async function readPublicGalleryCountSnapshot(
  plan: ImageFilterPlan,
  client: DatabaseReader,
  signal: AbortSignal,
  context?: ReadyImageCountContext,
  tagCounts?: GalleryTagCountPlans
) {
  signal.throwIfAborted();
  const snapshot = await withTransactionOnClient(client, async () => {
    const unfiltered = isUnfilteredReadyImagePlan(plan);
    // The unfiltered path always uses four business SELECTs, without a revision query.
    const globalStats =
      !unfiltered && context
        && (await getReadyImageRevision(client)).revision === context.revision
        ? context.globalStats
        : null;
    const categoryRows = await filteredRows<CategoryRow>(
      client,
      plan,
      [],
      (where, limit) =>
        `SELECT m.device, m.brightness, count(*)::int AS image_count
         FROM metadata m WHERE ${where} GROUP BY m.device, m.brightness LIMIT ${limit}`
    );
    const categories = categorySnapshot(categoryRows);
    const total = unfiltered
      ? categories.matching
      : globalStats
        ? count(globalStats.get("total"))
        : count(
            (
              await client.query(
                "SELECT count(*)::int AS image_count FROM metadata WHERE status='ready'"
              )
            ).rows[0]?.image_count
          );
    const devices = unfiltered
      ? categories.devices
      : countsBy(
          await filteredRows<CountRow & { device: Device }>(
            client,
            plan,
            ["device"],
            (where, limit) =>
              `SELECT m.device, count(*)::int AS image_count FROM metadata m
          WHERE ${where} GROUP BY m.device LIMIT ${limit}`
          ),
          (row) => row.device
        );
    const brightnesses = unfiltered
      ? categories.brightnesses
      : countsBy(
          await filteredRows<CountRow & { brightness: Brightness }>(
            client,
            plan,
            ["brightness"],
            (where, limit) =>
              `SELECT m.brightness, count(*)::int AS image_count FROM metadata m
          WHERE ${where} GROUP BY m.brightness LIMIT ${limit}`
          ),
          (row) => row.brightness
        );
    const facets = await readFacetCounts(
      client,
      plan,
      globalStats,
      tagCounts?.candidates ?? imageFilterPlanWithout(plan, "tag")
    );
    const tagGroups = tagCounts
      ? await readTagGroupCounts(client, plan, categories.matching, tagCounts.groups)
      : undefined;
    signal.throwIfAborted();
    return {
      total,
      matching: categories.matching,
      axes: categories.axes,
      devices,
      brightnesses,
      ...(tagGroups ? { tagGroups } : {}),
      themes: facets.themes,
      tags: facets.tags,
      authors: facets.authors
    } satisfies ReadyImageCountSnapshot;
  }, { mode: "read_only_repeatable_read" });
  signal.throwIfAborted();
  return snapshot;
}
