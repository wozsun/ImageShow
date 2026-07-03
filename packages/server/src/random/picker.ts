import { appConfig, categoryKey, indexKey } from "@imageshow/shared";
import { getRandomObject, getRandomPoolSnapshot, rebuildFolderMap, type RandomObjectIndexItem } from "../core/redis.js";
import { pool } from "../core/db.js";
import { routeError } from "../core/http.js";
import { isRandomBrightness, parseAuthorSelectors, parseTagSelectors, parseThemeSelectors, randomBrightness, randomDevices, validThemesFromMap } from "./query.js";

export type PickedImage = RandomObjectIndexItem & { method: "proxy" | "redirect" };

function inferDevice(ua: string) {
  if (!ua) return "r";
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return "mb";
  if (/Windows|Macintosh|Linux x86_64|X11/i.test(ua)) return "pc";
  return "r";
}

export function resolveCandidateAxes(requestedDevice: string | null, requestedBrightness: string | null, userAgent: string) {
  const device = requestedDevice || inferDevice(userAgent);
  // r 表示“随机设备”：请求未指定且 UA 不明确时，同时在 pc/mb 两个池里按后续权重挑选。
  const deviceCandidates = device === "r" ? [...randomDevices] : [device as "pc" | "mb"];
  const brightnessCandidates = requestedBrightness && isRandomBrightness(requestedBrightness) ? [requestedBrightness] : [...randomBrightness];
  return { deviceCandidates, brightnessCandidates, requestedDevice, requestedBrightness };
}

export type CandidateAxes = ReturnType<typeof resolveCandidateAxes>;

function noCandidatesError(url: URL, axes: CandidateAxes) {
  const hasFilters = Boolean(axes.requestedDevice || axes.requestedBrightness || url.searchParams.getAll("t").length || url.searchParams.getAll("tag").length || url.searchParams.getAll("a").length);
  return routeError({ status: 404, message: hasFilters ? "Not Found: No available images for the selected filters" : "Not Found: No available images" });
}

export async function pickFromRedisPool(url: URL, method: "proxy" | "redirect", axes: CandidateAxes, recent: Set<string> = new Set()): Promise<PickedImage | Response | null> {
  const snapshot = await getRandomPoolSnapshot();
  let folderMap = snapshot.folderMap;
  let themes = snapshot.themes;
  let rebuilds = 0;

  let fallback: RandomObjectIndexItem | null = null;
  for (let attempt = 0; attempt < appConfig.randomDedupe.maxAttempts; attempt += 1) {
    const themeCandidates = parseThemeSelectors(url.searchParams, themes);
    if (themeCandidates instanceof Response) return themeCandidates;
    const candidates: Array<{ category: string; count: number }> = [];
    for (const candidateDevice of axes.deviceCandidates) {
      const deviceMap = folderMap[candidateDevice] ?? {};
      for (const brightness of axes.brightnessCandidates) {
        for (const theme of themeCandidates) {
          const count = Number(deviceMap[brightness]?.[theme] ?? 0);
          if (Number.isFinite(count) && count > 0) candidates.push({ category: categoryKey(candidateDevice, brightness, theme), count });
        }
      }
    }
    if (!candidates.length) return noCandidatesError(url, axes);
    const item = await weightedPick(candidates);
    if (!item) {
      // Redis 随机池可能因手动改库或异常退出而短暂落后；命中空洞时重建 folderMap 后再试几次。
      if (rebuilds >= appConfig.randomMissRetries) break;
      rebuilds += 1;
      folderMap = await rebuildFolderMap();
      themes = validThemesFromMap(folderMap);
      continue;
    }
    // 短期去重优先避免重复；如果全都命中 recent，保留一个可用 fallback，避免接口明明有图却返回空。
    if (recent.has(item.id)) { fallback = item; continue; }
    return { ...item, method };
  }
  return fallback ? { ...fallback, method } : null;
}

async function weightedPick(candidates: Array<{ category: string; count: number }>): Promise<RandomObjectIndexItem | null> {
  const total = candidates.reduce((sum, choice) => sum + choice.count, 0);
  let ticket = Math.random() * total;
  // 先按分类图片数量加权选分类，再在该分类连续 index 范围里选序号，避免小分类被大分类同等概率淹没。
  const selected = candidates.find((item) => {
    ticket -= item.count;
    return ticket < 0;
  }) ?? candidates[candidates.length - 1];
  const idx = 1 + Math.floor(Math.random() * selected.count);
  return getRandomObject(indexKey(selected.category, idx));
}

export async function pickFromDatabase(url: URL, method: "proxy" | "redirect", axes: CandidateAxes, recent: Set<string> = new Set()): Promise<PickedImage | Response | null> {
  const themes = (await pool.query(
    "SELECT DISTINCT theme FROM metadata WHERE status='ready' ORDER BY theme"
  )).rows.map((row) => row.theme as string);
  const themeCandidates = parseThemeSelectors(url.searchParams, themes);
  if (themeCandidates instanceof Response) return themeCandidates;
  if (!themeCandidates.length) return noCandidatesError(url, axes);
  const tags = parseTagSelectors(url.searchParams);
  if (tags instanceof Response) return tags;
  const authors = parseAuthorSelectors(url.searchParams);
  if (authors instanceof Response) return authors;
  const conditions = ["status='ready'", "device = ANY($1::text[])", "brightness = ANY($2::text[])", "theme = ANY($3::text[])"];
  const params: unknown[] = [axes.deviceCandidates, axes.brightnessCandidates, themeCandidates];

  if (tags.include.length) { params.push(tags.include); conditions.push(`id IN (SELECT image_id FROM image_tag WHERE tag_slug = ANY($${params.length}::text[]))`); }
  if (tags.exclude.length) { params.push(tags.exclude); conditions.push(`id NOT IN (SELECT image_id FROM image_tag WHERE tag_slug = ANY($${params.length}::text[]))`); }

  if (authors.include.length) { params.push(authors.include); conditions.push(`author = ANY($${params.length}::text[])`); }
  if (authors.exclude.length) { params.push(authors.exclude); conditions.push(`(author IS NULL OR author <> ALL($${params.length}::text[]))`); }
  const recentIds = [...recent];

  for (const excludeRecent of recentIds.length ? [true, false] : [false]) {
    // PG 降级路径先排除 recent；如果排除后无结果，再放宽一次，保证随机 API 可用性优先于短期去重。
    const passConditions = [...conditions];
    const passParams = [...params];
    if (excludeRecent) { passParams.push(recentIds); passConditions.push(`id <> ALL($${passParams.length}::uuid[])`); }
    const where = passConditions.join(" AND ");

    const total = Number((await pool.query(`SELECT count(*)::int AS n FROM metadata WHERE ${where}`, passParams)).rows[0].n);
    if (!total) continue;
    const row = (await pool.query(
      `SELECT id, object_key, ext, index_key, device, brightness, theme, category_index, storage_slug, is_link
       FROM metadata
       WHERE ${where}
       ORDER BY id
       OFFSET $${passParams.length + 1}
       LIMIT 1`,
      [...passParams, Math.floor(Math.random() * total)]
    )).rows[0];
    if (row) {
      return {
        id: row.id,
        object_key: row.object_key,
        ext: row.ext,
        index_key: row.index_key,
        device: row.device,
        brightness: row.brightness,
        theme: row.theme,
        category_index: Number(row.category_index),
        storage_slug: row.storage_slug,
        is_link: row.is_link,
        method
      };
    }
  }
  return noCandidatesError(url, axes);
}
