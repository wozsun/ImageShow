// Link import (two-phase): register externally-hosted images by URL without ever storing
// the original. prepare() downloads one URL once to read dimensions, infer the device,
// compute md5 and build a 512px thumbnail, then stages that thumbnail server-side (Redis,
// TTL'd) and returns a preview — no row yet. commit() takes the staged id plus the
// (card-edited) metadata, inserts an is_link row (object_key = the URL), and
// only then writes the thumbnail to the chosen backend, so a rolled-back insert never leaves
// an orphaned file. Abandoned stages simply expire in Redis.
import { v7 as uuidv7 } from "uuid";
import { appConfig, categoryKey, indexKey, type Brightness, type Device } from "@imageshow/shared";
import { adjustCategoryCount, upsertCategory, withTransaction } from "../core/db.js";
import { ApiError } from "../core/http.js";
import { bumpFolder, invalidateImageReadCaches, redis } from "../core/redis.js";
import { assertStorageUploadable, getUploadLimitBytes } from "../config/settings.js";
import { createThumbnail, detectDeviceFromDimensions, probeImageBytes } from "./processing.js";
import { detectBrightness } from "./brightness.js";
import { linkThumbnailKey } from "../storage/image-paths.js";
import { writeStorageBuffer } from "../storage/storage.js";
import { ensureTheme } from "../themes/service.js";
import { ensureAuthor } from "../authors/service.js";
import { setImageTags } from "../tags/service.js";

const STAGE_PREFIX = "imageshow:linkstage:";

// What we keep between prepare and commit: enough to insert the row plus the thumbnail bytes
// (base64) so commit writes them to the final backend without re-downloading.
type LinkStage = { url: string; width: number; height: number; ext: string; md5: string; thumbnail: string };

export type LinkPrepareResult = {
  staging_id: string;
  url: string;
  width: number;
  height: number;
  device: Device;
  brightness: Brightness;
  ext: string;
  md5: string;
  thumb_data_url: string;
};

export type LinkCommitAttrs = {
  staging_id: string;
  device: Device;
  brightness: Brightness | "auto";
  theme: string;
  author: string;
  title: string;
  description: string;
  source: string;
  original: string;
  tags: string[];
  // Backend the generated thumbnail is written to (the original is only linked).
  storage_slug: string;
};

// Downloads the image bytes once, capped at the configured upload size limit (both a
// content-length precheck and a post-read guard) and bounded by a fetch timeout.
async function fetchImageBytes(url: string, limitBytes: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), appConfig.linkImport.fetchTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new ApiError(400, "link_fetch_failed", `下载失败（HTTP ${response.status}）`, { url });
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared && declared > limitBytes) throw new ApiError(400, "link_too_large", "图片超过大小上限", { limit: limitBytes });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > limitBytes) throw new ApiError(400, "link_too_large", "图片超过大小上限", { limit: limitBytes });
    return buffer;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if ((error as Error).name === "AbortError") throw new ApiError(400, "link_timeout", "下载超时", { url });
    throw new ApiError(400, "link_fetch_failed", "下载失败", { url });
  } finally {
    clearTimeout(timer);
  }
}

// Phase 1: download + probe + thumbnail, stash the thumbnail bytes in Redis (TTL'd), and
// return a data-URL preview plus the detected device/brightness for the card defaults.
export async function prepareLinkImage(url: string): Promise<LinkPrepareResult> {
  if (!/^https?:\/\//i.test(url)) throw new ApiError(400, "link_scheme", "仅支持 http(s) 链接", { url });
  const limit = await getUploadLimitBytes();
  const buffer = await fetchImageBytes(url, limit);
  const probe = await probeImageBytes(buffer);
  const thumbnail = await createThumbnail(buffer);
  const thumbB64 = thumbnail.toString("base64");
  // Card defaults: device from aspect ratio, brightness auto-detected from the thumbnail
  // (the user can still change either before committing).
  const device = detectDeviceFromDimensions(probe.width, probe.height);
  const brightness = await detectBrightness(thumbnail);
  const stagingId = uuidv7();
  const stage: LinkStage = { url, width: probe.width, height: probe.height, ext: probe.ext, md5: probe.md5, thumbnail: thumbB64 };
  await redis.set(`${STAGE_PREFIX}${stagingId}`, JSON.stringify(stage), "EX", appConfig.uploadTtlSeconds);
  return { staging_id: stagingId, url, width: probe.width, height: probe.height, device, brightness, ext: probe.ext, md5: probe.md5, thumb_data_url: `data:image/webp;base64,${thumbB64}` };
}

// Phase 2: insert the link row from the staged bytes + card-edited metadata, then write the
// thumbnail to the chosen backend (after commit only, so a rollback can't orphan a file).
export async function commitLinkImage(attrs: LinkCommitAttrs): Promise<{ status: "imported" | "duplicate" }> {
  const raw = await redis.get(`${STAGE_PREFIX}${attrs.staging_id}`);
  if (!raw) throw new ApiError(400, "link_stage_expired", "导入会话已过期，请重新导入该链接", { staging_id: attrs.staging_id });
  const stage = JSON.parse(raw) as LinkStage;
  // Fail before any DB work if the chosen thumbnail backend isn't writable (e.g. an
  // S3 backend with incomplete credentials).
  await assertStorageUploadable(attrs.storage_slug);
  const thumbnail = Buffer.from(stage.thumbnail, "base64");
  const brightness: Brightness = attrs.brightness === "auto" ? await detectBrightness(thumbnail) : attrs.brightness;
  const device = attrs.device;
  const theme = attrs.theme;
  const cat = categoryKey(device, brightness, theme);
  const id = attrs.staging_id;
  const inserted = await withTransaction(async (client) => {
    await upsertCategory(client, cat, device, brightness, theme);
    await ensureTheme(client, theme);
    await ensureAuthor(client, attrs.author);
    const catRow = (await client.query("SELECT count FROM category WHERE category_key=$1 FOR UPDATE", [cat])).rows[0];
    const nextIndex = Number(catRow.count) + 1;
    const idx = indexKey(cat, nextIndex);
    const title = attrs.title;
    // object_key = the imported URL (what the random API 302s to); original = the card's
    // 原图URL (auto-filled to that URL but separately editable). Only the thumbnail is stored.
    const result = await client.query(
      `INSERT INTO metadata(id, device, brightness, theme, category_key, category_index, index_key, width, height, ext, object_key, storage_slug, is_link, title, description, source, original, md5, thumbnail_size, author)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (object_key) DO NOTHING`,
      [id, device, brightness, theme, cat, nextIndex, idx, stage.width, stage.height, stage.ext, stage.url, attrs.storage_slug, title, attrs.description, attrs.source, attrs.original, stage.md5, thumbnail.byteLength, attrs.author || null]
    );
    const inserted = Boolean(result.rowCount);
    if (inserted) await adjustCategoryCount(client, cat, 1);
    return inserted;
  });
  if (inserted) {
    // After commit only, so a rolled-back insert never leaves a thumbnail behind. The
    // link thumbnail is foldered by category (<device>-<brightness>/<theme>/<id>.webp),
    // mirroring how stored objects are organized.
    await writeStorageBuffer("link", linkThumbnailKey(device, brightness, theme, id), thumbnail, "image/webp", attrs.storage_slug);
    if (attrs.tags.length) await setImageTags(id, attrs.tags);
    await bumpFolder(cat, 1);
    await invalidateImageReadCaches();
  }
  // Whether imported or a duplicate, the stage is consumed.
  await redis.del(`${STAGE_PREFIX}${attrs.staging_id}`);
  return { status: inserted ? "imported" : "duplicate" };
}
