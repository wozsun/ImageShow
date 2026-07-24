import {
  WeiboImportError,
  type ExtractedWeiboPost,
  type ParsedWeiboPostUrl
} from "./weibo-types.ts";
import {
  asRecord,
  scalarString,
  type UnknownRecord
} from "./weibo-values.ts";

/** Parses one supported Weibo post URL into its canonical identifiers. */
export function parseWeiboPostUrl(input: string): ParsedWeiboPostUrl {
  const value = input.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WeiboImportError(
      "weibo_invalid_url",
      "请输入完整的微博链接，例如 https://weibo.com/用户ID/微博短码"
    );
  }

  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || !/(^|\.)weibo\.(com|cn)$/.test(hostname)
  ) {
    throw new WeiboImportError("weibo_invalid_url", "仅支持公开的 HTTPS 微博链接");
  }

  let segments: string[];
  try {
    segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
  } catch {
    throw new WeiboImportError("weibo_invalid_url", "微博链接路径无法解析");
  }

  let identifier = url.searchParams.get("id") ?? "";
  for (const marker of ["detail", "status"]) {
    const markerIndex = segments.findIndex(
      (part) => part.toLowerCase() === marker
    );
    if (!identifier && markerIndex >= 0 && segments[markerIndex + 1]) {
      identifier = segments[markerIndex + 1];
    }
  }

  if (!identifier && segments.length >= 2) {
    identifier = segments.at(-1) ?? "";
  }
  identifier = identifier.replace(/\.html$/i, "");
  if (!/^[A-Za-z0-9]{1,32}$/.test(identifier)) {
    throw new WeiboImportError(
      "weibo_invalid_url",
      "无法从链接中识别微博 ID 或短码"
    );
  }

  return { identifier, sourceUrl: url.toString() };
}

function normalizeWeiboDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  const englishDate = trimmed.match(
    /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{4})\s+(\d{4})$/
  );
  if (englishDate) {
    const months: Record<string, string> = {
      Jan: "01",
      Feb: "02",
      Mar: "03",
      Apr: "04",
      May: "05",
      Jun: "06",
      Jul: "07",
      Aug: "08",
      Sep: "09",
      Oct: "10",
      Nov: "11",
      Dec: "12"
    };
    const [, monthName, day, time, offset, year] = englishDate;
    const month = months[monthName];
    if (month) {
      return `${year}-${month}-${day.padStart(2, "0")}T${time}${offset.slice(0, 3)}:${offset.slice(3)}`;
    }
  }

  const localDate = trimmed.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})$/
  );
  if (localDate) {
    const [, year, month, day, hour, minute, second] = localDate;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T${hour.padStart(2, "0")}:${minute}:${second}+08:00`;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function toOriginalWeiboImageUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  return value.replace(
    /\/(?:wap\d+|thumb\d+|thumbnail|bmiddle|mw\d+|orj\d+|woriginal|large)\//i,
    "/large/"
  );
}

function imageVariantUrl(info: UnknownRecord, name: string) {
  return scalarString(asRecord(info[name])?.url);
}

function bestImageUrl(value: unknown): string | null {
  const info = asRecord(value);
  if (!info || info.type === "video") return null;
  return toOriginalWeiboImageUrl(
    imageVariantUrl(info, "largest")
    || imageVariantUrl(info, "original")
    || imageVariantUrl(info, "large")
    || scalarString(info.url)
  );
}

function extractOriginalWeiboImageUrls(value: unknown) {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: unknown) => {
    const originalUrl = toOriginalWeiboImageUrl(candidate);
    if (!originalUrl || seen.has(originalUrl)) return;
    seen.add(originalUrl);
    result.push(originalUrl);
  };
  const visit = (candidate: unknown) => {
    const post = asRecord(candidate);
    if (!post) return;

    const picInfos = asRecord(post.pic_infos) ?? {};
    const orderedIds = Array.isArray(post.pic_ids) ? post.pic_ids : [];
    for (const id of orderedIds) add(bestImageUrl(picInfos[scalarString(id)]));
    for (const info of Object.values(picInfos)) add(bestImageUrl(info));

    if (Array.isArray(post.pics)) {
      for (const pic of post.pics) add(bestImageUrl(pic));
    }

    const mixedItems = asRecord(post.mix_media_info)?.items;
    if (Array.isArray(mixedItems)) {
      for (const itemValue of mixedItems) {
        const item = asRecord(itemValue);
        const data = asRecord(item?.data);
        if (item?.type === "pic" || data?.type !== "video") {
          add(bestImageUrl(data));
        }
      }
    }

    visit(post.retweeted_status);
  };

  visit(value);
  return result;
}

export function extractWeiboPost(
  rawStatus: unknown,
  parsedUrl: ParsedWeiboPostUrl,
  authorSlugs: Readonly<Record<string, string>>
): ExtractedWeiboPost {
  const status = asRecord(rawStatus);
  const returnedWeiboId = scalarString(status?.idstr)
    || scalarString(status?.id);
  const createdAt = scalarString(status?.created_at);
  if (!status || !createdAt) {
    throw new WeiboImportError(
      "weibo_post_unavailable",
      "没有获得微博详情，微博可能不存在、不可见或要求登录"
    );
  }

  const publishedAt = normalizeWeiboDate(createdAt);
  const user = asRecord(status.user);
  const userId = scalarString(user?.idstr) || scalarString(user?.id);
  if (!publishedAt || !userId) {
    throw new WeiboImportError(
      "weibo_post_incomplete",
      "微博缺少可识别的发布时间或用户 ID"
    );
  }

  const originalImageUrls = extractOriginalWeiboImageUrls(status);
  if (!originalImageUrls.length) {
    throw new WeiboImportError(
      "weibo_no_images",
      "这条微博没有可导入的公开图片"
    );
  }

  const mappedAuthor = Object.hasOwn(authorSlugs, userId)
    ? authorSlugs[userId]
    : undefined;
  const mblogId = scalarString(status.mblogid);
  const weiboId = returnedWeiboId || parsedUrl.identifier;
  return {
    source_url: mblogId
      ? `https://weibo.com/${encodeURIComponent(userId)}/${encodeURIComponent(mblogId)}`
      : returnedWeiboId
        ? `https://weibo.com/${encodeURIComponent(userId)}/${encodeURIComponent(returnedWeiboId)}`
        : parsedUrl.sourceUrl,
    weibo_id: weiboId,
    bid: mblogId || parsedUrl.identifier,
    user_id: userId,
    published_at: publishedAt,
    original_image_urls: originalImageUrls,
    image_count: originalImageUrls.length,
    ...(mappedAuthor ? { author: mappedAuthor } : {})
  };
}
