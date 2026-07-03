import { appConfig, categoryKey, indexKey, type Brightness, type Device } from "@imageshow/shared";
import { adjustCategoryCount, upsertCategory, withTransaction } from "../../core/db.js";
import { ApiError } from "../../core/http.js";
import { bumpFolder, invalidateImageReadCaches, redis } from "../../core/redis.js";
import { assertStorageUploadable, getUploadLimitBytes } from "../../config/settings.js";
import { createThumbnail, detectDeviceFromDimensions, probeImageBytes } from "../processing.js";
import { detectBrightness } from "../brightness.js";
import { linkThumbnailKey } from "../../storage/image-paths.js";
import { writeStorageBuffer } from "../../storage/storage.js";
import { ensureTheme } from "../../themes/service.js";
import { ensureAuthor } from "../../authors/service.js";
import { setImageTags } from "../../tags/service.js";
import { fetchImportImage } from "./fetch.js";
import { proxyExternalImage } from "../serving.js";

const STAGE_PREFIX = "imageshow:linkstage:";
const CANCEL_PREFIX = "imageshow:linkstage-cancelled:";
const activePrepares = new Map<string, AbortController>();

type LinkStage = { url: string; width: number; height: number; ext: string; md5: string; thumbnail: string; storage_slug: string; size: number };

export type LinkPrepareResult = {
  staging_id: string;
  url: string;
  width: number;
  height: number;
  original_width: number;
  original_height: number;
  device: Device;
  brightness: Brightness;
  ext: string;
  md5: string;
  thumb_data_url: string;
  original_size: number;
  size: number;
  quality: null;
  transcoded: false;
  storage_slug: string;
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
};

export async function prepareLinkImage(url: string, stagingId: string, storageSlug: string): Promise<LinkPrepareResult> {
  if (!/^https?:\/\//i.test(url)) throw new ApiError(400, "link_scheme", "仅支持 http(s) 链接", { url });
  await assertStorageUploadable(storageSlug);
  const controller = new AbortController();
  activePrepares.set(stagingId, controller);
  try {
    const limit = await getUploadLimitBytes();
    const buffer = await fetchImportImage(url, limit, controller.signal);
    const probe = await probeImageBytes(buffer);
    const thumbnail = await createThumbnail(buffer);
    const thumbB64 = thumbnail.toString("base64");
    const device = detectDeviceFromDimensions(probe.width, probe.height);
    const brightness = await detectBrightness(thumbnail);
    if (await redis.get(`${CANCEL_PREFIX}${stagingId}`)) throw new ApiError(409, "import_cancelled", "导入已取消");
    const stage: LinkStage = { url, width: probe.width, height: probe.height, ext: probe.ext, md5: probe.md5, thumbnail: thumbB64, storage_slug: storageSlug, size: probe.size };
    await redis.set(`${STAGE_PREFIX}${stagingId}`, JSON.stringify(stage), "EX", appConfig.uploadTtlSeconds);
    return {
      staging_id: stagingId, url, width: probe.width, height: probe.height, device, brightness,
      original_width: probe.width, original_height: probe.height,
      ext: probe.ext, md5: probe.md5, thumb_data_url: `data:image/webp;base64,${thumbB64}`,
      original_size: probe.size, size: probe.size, quality: null, transcoded: false,
      storage_slug: storageSlug
    };
  } finally {
    activePrepares.delete(stagingId);
    await redis.del(`${CANCEL_PREFIX}${stagingId}`).catch(() => undefined);
  }
}

export async function cancelLinkImage(stagingId: string) {
  activePrepares.get(stagingId)?.abort();
  await Promise.all([
    redis.set(`${CANCEL_PREFIX}${stagingId}`, "1", "EX", appConfig.uploadTtlSeconds),
    redis.del(`${STAGE_PREFIX}${stagingId}`)
  ]);
}

export async function previewLinkImage(stagingId: string): Promise<Response> {
  const raw = await redis.get(`${STAGE_PREFIX}${stagingId}`);
  if (!raw) throw new ApiError(404, "link_stage_expired", "导入会话已过期，请重新导入该链接", { staging_id: stagingId });
  const stage = JSON.parse(raw) as LinkStage;
  return proxyExternalImage(stage.url, stage.ext || "jpg", false, { "Cache-Control": "private, no-store" }, undefined, () => new Response(Buffer.from(stage.thumbnail, "base64"), {
    headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store" }
  }));
}

export async function commitLinkImage(attrs: LinkCommitAttrs): Promise<{ status: "imported" | "duplicate" }> {
  const raw = await redis.get(`${STAGE_PREFIX}${attrs.staging_id}`);
  if (!raw) throw new ApiError(400, "link_stage_expired", "导入会话已过期，请重新导入该链接", { staging_id: attrs.staging_id });
  const stage = JSON.parse(raw) as LinkStage;
  await assertStorageUploadable(stage.storage_slug);
  const thumbnail = Buffer.from(stage.thumbnail, "base64");
  const brightness: Brightness = attrs.brightness === "auto" ? await detectBrightness(thumbnail) : attrs.brightness;
  const device = attrs.device;
  const theme = attrs.theme;
  const cat = categoryKey(device, brightness, theme);
  const id = attrs.staging_id;
  const commit = await withTransaction(async (client) => {
    await upsertCategory(client, cat, device, brightness, theme);
    await ensureTheme(client, theme);
    await ensureAuthor(client, attrs.author);
    const catRow = (await client.query("SELECT count FROM category WHERE category_key=$1 FOR UPDATE", [cat])).rows[0];
    const nextIndex = Number(catRow.count) + 1;
    const idx = indexKey(cat, nextIndex);
    const title = attrs.title;
    const result = await client.query(
      `INSERT INTO metadata(id, device, brightness, theme, category_key, category_index, index_key, width, height, ext, object_key, storage_slug, is_link, title, description, source, original, md5, thumbnail_size, author)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (object_key) DO NOTHING`,
      [id, device, brightness, theme, cat, nextIndex, idx, stage.width, stage.height, stage.ext, stage.url, stage.storage_slug, title, attrs.description, attrs.source, attrs.original, stage.md5, thumbnail.byteLength, attrs.author || null]
    );
    const inserted = Boolean(result.rowCount);
    if (inserted) await adjustCategoryCount(client, cat, 1);
    const resume = !inserted && Boolean((await client.query("SELECT 1 FROM metadata WHERE id=$1", [id])).rowCount);
    return { inserted, resume };
  });
  if (commit.inserted || commit.resume) {
    await writeStorageBuffer("link", linkThumbnailKey(device, brightness, theme, id), thumbnail, "image/webp", stage.storage_slug);
    if (attrs.tags.length) await setImageTags(id, attrs.tags);
    if (commit.inserted) await bumpFolder(cat, 1);
    await invalidateImageReadCaches();
  }
  await redis.del(`${STAGE_PREFIX}${attrs.staging_id}`);
  return { status: commit.inserted || commit.resume ? "imported" : "duplicate" };
}
