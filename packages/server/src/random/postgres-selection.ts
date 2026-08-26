import { appConfig } from "@imageshow/shared";
import { randomUuidV7At } from "../core/uuid.ts";
import type { DatabaseReader } from "../core/database/pools.ts";
import type { ImageFilterPlan } from "../images/filter-plan.ts";
import { buildImageFilterSql } from "../images/read-models/image-filter-sql.ts";
import {
  readyImageCacheItemFromRow,
  type ReadyImageCacheItem,
  type ReadyImageSourceRow
} from "../images/ready-cache/model.ts";
import { readyImageSourceColumns } from "../images/ready-cache/source.ts";

function bind(params: unknown[], value: unknown) {
  params.push(value);
  return `$${params.length}`;
}

function filterClause(plan: ImageFilterPlan) {
  const clause = buildImageFilterSql({
    status: "ready",
    plan
  }, { alias: "m" });
  return { params: clause.params, sql: clause.where.join(" AND ") };
}

function uuidV7Milliseconds(id: string) {
  const compact = id.replaceAll("-", "");
  const value = Number.parseInt(compact.slice(0, 12), 16);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("PostgreSQL random fallback returned an invalid UUIDv7");
  }
  return value;
}

function randomPivot(minId: string, maxId: string) {
  const minimum = uuidV7Milliseconds(minId);
  const maximum = uuidV7Milliseconds(maxId);
  const timestamp = minimum + Math.floor(
    Math.random() * (Math.max(0, maximum - minimum) + 1)
  );
  return randomUuidV7At(new Date(timestamp));
}

function shuffle(items: ReadyImageCacheItem[]) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

async function readCandidates(
  plan: ImageFilterPlan,
  pivot: string,
  comparison: ">=" | "<",
  limit: number,
  reader: DatabaseReader,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const clause = filterClause(plan);
  const pivotParameter = bind(clause.params, pivot);
  const limitParameter = bind(clause.params, limit);
  const rows = (await reader.query(
    `SELECT ${readyImageSourceColumns}
       FROM metadata m
      WHERE ${clause.sql}
        AND m.id ${comparison} ${pivotParameter}::uuid
      ORDER BY m.id ASC
      LIMIT ${limitParameter}`,
    clause.params
  )).rows as ReadyImageSourceRow[];
  signal?.throwIfAborted();
  return rows.map(readyImageCacheItemFromRow);
}

export async function sampleReadyImagesFromPostgres(
  plan: ImageFilterPlan,
  limit: number,
  recent: ReadonlySet<string>,
  reader: DatabaseReader,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const clause = filterClause(plan);
  const bounds = (await reader.query<{
    min_id: string | null;
    max_id: string | null;
  }>(
    `SELECT lower_bound.id::text AS min_id,
            upper_bound.id::text AS max_id
       FROM LATERAL (
         SELECT m.id
           FROM metadata m
          WHERE ${clause.sql}
          ORDER BY m.id ASC
          LIMIT 1
       ) lower_bound
       CROSS JOIN LATERAL (
         SELECT m.id
           FROM metadata m
          WHERE ${clause.sql}
          ORDER BY m.id DESC
          LIMIT 1
       ) upper_bound`,
    clause.params
  )).rows[0];
  signal?.throwIfAborted();
  if (!bounds?.min_id || !bounds.max_id) return [];

  const pivot = randomPivot(bounds.min_id, bounds.max_id);
  const candidateLimit = Math.min(
    appConfig.publicPgFallback.maximumRandomCandidates,
    Math.max(
      appConfig.publicPgFallback.minimumRandomCandidates,
      limit * 3,
      limit + recent.size
    )
  );
  const forward = await readCandidates(
    plan,
    pivot,
    ">=",
    candidateLimit,
    reader,
    signal
  );
  const wrapped = forward.length < candidateLimit
    ? await readCandidates(
        plan,
        pivot,
        "<",
        candidateLimit - forward.length,
        reader,
        signal
      )
    : [];
  const unique = new Map(
    [...forward, ...wrapped].map((item) => [item.id, item])
  );
  const randomized = shuffle([...unique.values()]);
  const fresh = randomized.filter((item) => !recent.has(item.id));
  const repeated = randomized.filter((item) => recent.has(item.id));
  return [...fresh, ...repeated].slice(0, limit);
}
