import { appConfig } from "@imageshow/shared";
import { mapWithWorkerPool } from "../../core/concurrency.ts";
import { parseJsonlManifest } from "./jsonl.ts";
import { runWeiboRequestWithinGlobalLimit } from "./weibo-request-limiter.ts";

const weiboUserAgent = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  "AppleWebKit/537.36 (KHTML, like Gecko)",
  "Chrome/136.0.0.0 Safari/537.36"
].join(" ");
const weiboRequestTimeoutMs = 15_000;
const weiboVisitorResponseMaxBytes = 64 * 1024;
const weiboStatusResponseMaxBytes = 4 * 1024 * 1024;

type UnknownRecord = Record<string, unknown>;
type FetchImplementation = typeof fetch;

export type WeiboImportErrorCode =
  | "weibo_invalid_url"
  | "weibo_visitor_failed"
  | "weibo_request_failed"
  | "weibo_response_too_large"
  | "weibo_image_limit_exceeded"
  | "weibo_post_unavailable"
  | "weibo_post_incomplete"
  | "weibo_no_images"
  | "weibo_no_importable_images";

export class WeiboImportError extends Error {
  readonly code: WeiboImportErrorCode;

  constructor(code: WeiboImportErrorCode, message: string) {
    super(message);
    this.name = "WeiboImportError";
    this.code = code;
  }
}

export type ExtractedWeiboPost = {
  source_url: string;
  weibo_id: string;
  bid: string;
  user_id: string;
  published_at: string;
  original_image_urls: string[];
  image_count: number;
  author?: string;
};

export type WeiboPostParseError = {
  line: number;
  url: string;
  code: WeiboImportErrorCode;
  error: string;
};

type WeiboExtractionOptions = {
  authorSlugs: Readonly<Record<string, string>>;
  fetchImplementation?: FetchImplementation;
  concurrency?: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
};

type WeiboManifestOptions = WeiboExtractionOptions & {
  timeZone?: string;
};

type IndexedWeiboUrl = {
  line: number;
  url: string;
  parsedUrl: ReturnType<typeof parseWeiboPostUrl>;
};

type WeiboBatchExtraction =
  | { line: number; post: ExtractedWeiboPost; error?: never }
  | { line: number; post?: never; error: WeiboPostParseError };

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function scalarString(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Exported for focused URL verification and reused by batch parsing. */
export function parseWeiboPostUrl(input: string) {
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
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/(^|\.)weibo\.(com|cn)$/.test(hostname)
  ) {
    throw new WeiboImportError("weibo_invalid_url", "仅支持公开的 HTTPS 微博链接");
  }

  let segments: string[];
  try {
    segments = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    throw new WeiboImportError("weibo_invalid_url", "微博链接路径无法解析");
  }

  let identifier = url.searchParams.get("id") ?? "";
  for (const marker of ["detail", "status"]) {
    const markerIndex = segments.findIndex((part) => part.toLowerCase() === marker);
    if (!identifier && markerIndex >= 0 && segments[markerIndex + 1]) {
      identifier = segments[markerIndex + 1];
    }
  }

  // 典型网页链接为 https://weibo.com/{uid}/{bid}。
  if (!identifier && segments.length >= 2) identifier = segments.at(-1) ?? "";
  identifier = identifier.replace(/\.html$/i, "");
  if (!/^[A-Za-z0-9]{1,32}$/.test(identifier)) {
    throw new WeiboImportError("weibo_invalid_url", "无法从链接中识别微博 ID 或短码");
  }

  return { identifier, sourceUrl: url.toString() };
}

/** @internal Exported only for focused Weibo date verification. */
export function normalizeWeiboDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();

  // 微博公开接口通常返回：Thu Jul 02 21:19:54 +0800 2026。
  const englishDate = trimmed.match(
    /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})\s+([+-]\d{4})\s+(\d{4})$/
  );
  if (englishDate) {
    const months: Record<string, string> = {
      Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
      Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12"
    };
    const [, monthName, day, time, offset, year] = englishDate;
    const month = months[monthName];
    if (month) {
      return `${year}-${month}-${day.padStart(2, "0")}T${time}${offset.slice(0, 3)}:${offset.slice(3)}`;
    }
  }

  // 部分接口会返回没有时区的东八区本地时间。
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

/** @internal Exported only for focused Weibo image URL verification. */
export function toOriginalWeiboImageUrl(value: unknown): string | null {
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
    imageVariantUrl(info, "largest") ||
    imageVariantUrl(info, "original") ||
    imageVariantUrl(info, "large") ||
    scalarString(info.url)
  );
}

/** @internal Exported only for focused Weibo response verification. */
export function extractOriginalWeiboImageUrls(value: unknown) {
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
        if (item?.type === "pic" || data?.type !== "video") add(bestImageUrl(data));
      }
    }

    // 转发微博的配图位于 retweeted_status，沿用原脚本的顺序继续追加。
    visit(post.retweeted_status);
  };

  visit(value);
  return result;
}

function parseCallbackJson(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new WeiboImportError("weibo_visitor_failed", "微博访客接口返回了无法识别的数据");
  }
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown;
  } catch {
    throw new WeiboImportError("weibo_visitor_failed", "微博访客接口返回了无效数据");
  }
}

async function readResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
) {
  signal.throwIfAborted();

  let rejectForAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectForAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectForAbort, { once: true });
    if (signal.aborted) rejectForAbort();
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (rejectForAbort) signal.removeEventListener("abort", rejectForAbort);
  }
}

function responseLimitLabel(maxBytes: number) {
  return maxBytes % (1024 * 1024) === 0
    ? `${maxBytes / (1024 * 1024)} MiB`
    : `${maxBytes / 1024} KiB`;
}

async function readWeiboResponseText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  context: string
) {
  signal.throwIfAborted();
  const tooLarge = () => new WeiboImportError(
    "weibo_response_too_large",
    `${context}：响应正文超过 ${responseLimitLabel(maxBytes)} 安全上限`
  );
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await readResponseChunk(reader, signal);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function requestAndParseWeiboResponse<Result>(
  fetchImplementation: FetchImplementation,
  input: string | URL,
  init: RequestInit,
  code: Extract<WeiboImportErrorCode, "weibo_visitor_failed" | "weibo_request_failed">,
  context: string,
  maxResponseBytes: number,
  parseResponse: (response: Response, text: string) => Result,
  timeoutMs = weiboRequestTimeoutMs
) {
  const callerSignal = init.signal ?? undefined;
  const effectiveTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(1, Math.floor(timeoutMs))
    : weiboRequestTimeoutMs;

  try {
    return await runWeiboRequestWithinGlobalLimit(callerSignal, async () => {
      const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
      const requestSignal = callerSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : timeoutSignal;
      const response = await fetchImplementation(input, {
        ...init,
        signal: requestSignal
      });
      const text = await readWeiboResponseText(
        response,
        maxResponseBytes,
        requestSignal,
        context
      );
      return parseResponse(response, text);
    });
  } catch (error) {
    // A client cancellation must stop the whole batch instead of being
    // downgraded to one failed post. Timeout, connection and body read errors
    // remain typed Weibo errors and can be isolated to the affected post.
    if (callerSignal?.aborted) throw callerSignal.reason ?? error;
    if (error instanceof WeiboImportError) throw error;
    throw new WeiboImportError(code, `${context}：${errorMessage(error)}`);
  }
}

/** @internal Exported only for focused Weibo visitor protocol verification. */
export async function createWeiboVisitorCookie(
  fetchImplementation: FetchImplementation = fetch,
  signal?: AbortSignal,
  requestTimeoutMs = weiboRequestTimeoutMs
) {
  const fingerprint = JSON.stringify({
    os: "1",
    browser: "Chrome136,0,0,0",
    fonts: "undefined",
    screenInfo: "1920*1080*24",
    plugins: ""
  });
  const commonHeaders = {
    "user-agent": weiboUserAgent,
    referer: "https://passport.weibo.com/"
  };
  const generated = await requestAndParseWeiboResponse(
    fetchImplementation,
    "https://passport.weibo.com/visitor/genvisitor",
    {
      method: "POST",
      headers: {
        ...commonHeaders,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ cb: "gen_callback", fp: fingerprint }),
      signal
    },
    "weibo_visitor_failed",
    "初始化微博访客身份失败",
    weiboVisitorResponseMaxBytes,
    (response, text) => ({
      response,
      data: asRecord(parseCallbackJson(text))
    }),
    requestTimeoutMs
  );
  const generatedData = generated.data;
  const generatedPayload = asRecord(generatedData?.data);
  const tid = scalarString(generatedPayload?.tid);
  if (!generated.response.ok || Number(generatedData?.retcode) !== 20_000_000 || !tid) {
    throw new WeiboImportError(
      "weibo_visitor_failed",
      `初始化微博访客身份失败：${scalarString(generatedData?.msg) || generated.response.status}`
    );
  }

  const incarnateUrl = new URL("https://passport.weibo.com/visitor/visitor");
  const incarnateParameters = {
    a: "incarnate",
    t: tid,
    w: "2",
    c: "095",
    gc: "",
    cb: "cross_domain",
    from: "weibo",
    _rand: String(Math.random())
  };
  for (const [name, parameter] of Object.entries(incarnateParameters)) {
    incarnateUrl.searchParams.set(name, parameter);
  }

  const incarnated = await requestAndParseWeiboResponse(
    fetchImplementation,
    incarnateUrl,
    { headers: commonHeaders, redirect: "manual", signal },
    "weibo_visitor_failed",
    "获取微博访客身份失败",
    weiboVisitorResponseMaxBytes,
    (response, text) => ({
      response,
      data: asRecord(parseCallbackJson(text))
    }),
    requestTimeoutMs
  );
  const identity = incarnated.data;
  const identityPayload = asRecord(identity?.data);
  const sub = scalarString(identityPayload?.sub);
  const subp = scalarString(identityPayload?.subp);
  if (!incarnated.response.ok || Number(identity?.retcode) !== 20_000_000 || !sub || !subp) {
    throw new WeiboImportError(
      "weibo_visitor_failed",
      `获取微博访客身份失败：${scalarString(identity?.msg) || incarnated.response.status}`
    );
  }

  // 访客身份只存在当前请求内，不写入配置、日志或磁盘。
  return `SUB=${sub}; SUBP=${subp}`;
}

/** @internal Exported only for focused Weibo status protocol verification. */
export async function fetchWeiboStatus(
  identifier: string,
  cookie: string,
  fetchImplementation: FetchImplementation = fetch,
  signal?: AbortSignal,
  requestTimeoutMs = weiboRequestTimeoutMs
) {
  const endpoint = `https://weibo.com/ajax/statuses/show?id=${encodeURIComponent(identifier)}`;
  return requestAndParseWeiboResponse(
    fetchImplementation,
    endpoint,
    {
      headers: {
        accept: "application/json, text/plain, */*",
        referer: "https://weibo.com/",
        "user-agent": weiboUserAgent,
        "x-requested-with": "XMLHttpRequest",
        cookie
      },
      redirect: "manual",
      signal
    },
    "weibo_request_failed",
    "请求微博失败",
    weiboStatusResponseMaxBytes,
    (response, text) => {
      const location = response.headers.get("location") ?? "";
      if (response.status >= 300 && response.status < 400) {
        const message = /passport\.weibo\.(com|cn)/.test(location)
          ? "微博要求登录验证，当前仅支持无需登录即可访问的公开微博"
          : `微博接口返回重定向：${location || response.status}`;
        throw new WeiboImportError("weibo_post_unavailable", message);
      }
      if (!response.ok) {
        throw new WeiboImportError("weibo_request_failed", `微博接口返回 HTTP ${response.status}`);
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new WeiboImportError(
          "weibo_request_failed",
          "微博没有返回 JSON，可能触发了登录验证或访问限制"
        );
      }
    },
    requestTimeoutMs
  );
}

async function extractWeiboPostWithVisitor(
  parsedUrl: ReturnType<typeof parseWeiboPostUrl>,
  visitorCookie: string,
  options: WeiboExtractionOptions
): Promise<ExtractedWeiboPost> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const rawStatus = await fetchWeiboStatus(
    parsedUrl.identifier,
    visitorCookie,
    fetchImplementation,
    options.signal,
    options.requestTimeoutMs
  );
  const status = asRecord(rawStatus);
  const weiboId = scalarString(status?.idstr) || scalarString(status?.id);
  const createdAt = scalarString(status?.created_at);
  if (!status || !weiboId || !createdAt) {
    throw new WeiboImportError(
      "weibo_post_unavailable",
      "没有获得微博详情，微博可能不存在、不可见或要求登录"
    );
  }

  const publishedAt = normalizeWeiboDate(createdAt);
  const user = asRecord(status.user);
  const userId = scalarString(user?.idstr) || scalarString(user?.id);
  if (!publishedAt || !userId) {
    throw new WeiboImportError("weibo_post_incomplete", "微博缺少可识别的发布时间或用户 ID");
  }

  const originalImageUrls = extractOriginalWeiboImageUrls(status);
  if (!originalImageUrls.length) {
    throw new WeiboImportError("weibo_no_images", "这条微博没有可导入的公开图片");
  }

  const mappedAuthor = Object.hasOwn(options.authorSlugs, userId)
    ? options.authorSlugs[userId]
    : undefined;
  return {
    source_url: parsedUrl.sourceUrl,
    weibo_id: weiboId,
    bid: scalarString(status.mblogid) || parsedUrl.identifier,
    user_id: userId,
    published_at: publishedAt,
    original_image_urls: originalImageUrls,
    image_count: originalImageUrls.length,
    ...(mappedAuthor ? { author: mappedAuthor } : {})
  };
}

/** @internal Exported only for focused Weibo extraction verification. */
export async function extractWeiboPost(
  inputUrl: string,
  options: WeiboExtractionOptions
): Promise<ExtractedWeiboPost> {
  const parsedUrl = parseWeiboPostUrl(inputUrl);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const visitorCookie = await createWeiboVisitorCookie(
    fetchImplementation,
    options.signal,
    options.requestTimeoutMs
  );
  return extractWeiboPostWithVisitor(parsedUrl, visitorCookie, options);
}

/** @internal Exported only for focused generated JSONL verification. */
export function weiboPostToJsonl(post: ExtractedWeiboPost) {
  const publicationYear = post.published_at.slice(0, 4);
  return post.original_image_urls.map((original) => JSON.stringify({
    original,
    source: post.source_url,
    image_time: post.published_at,
    tags: [publicationYear],
    ...(post.author ? { author: post.author } : {})
  })).join("\n");
}

function assertWeiboImageCountWithinHardLimit(imageCount: number) {
  if (imageCount <= appConfig.imports.weiboImageHardLimit) return;
  throw new WeiboImportError(
    "weibo_image_limit_exceeded",
    `单批微博解析结果不能超过 ${appConfig.imports.weiboImageHardLimit} 张图片`
  );
}

function presentWeiboPost(post: ExtractedWeiboPost) {
  return {
    source_url: post.source_url,
    weibo_id: post.weibo_id,
    bid: post.bid,
    user_id: post.user_id,
    author: post.author ?? null,
    published_at: post.published_at,
    image_count: post.image_count
  };
}

function createWeiboPostParseError(
  error: unknown,
  line: number,
  url: string
): WeiboPostParseError {
  if (!(error instanceof WeiboImportError)) throw error;
  return { line, url, code: error.code, error: error.message };
}

/** @internal Exported only for focused single-post manifest verification. */
export async function createWeiboImportManifest(
  inputUrl: string,
  options: WeiboManifestOptions
) {
  const post = await extractWeiboPost(inputUrl, options);
  assertWeiboImageCountWithinHardLimit(post.image_count);
  const manifest = parseJsonlManifest(weiboPostToJsonl(post), {
    maxItems: appConfig.imports.weiboImageHardLimit,
    timeZone: options.timeZone
  });
  if (!manifest.items.length) {
    throw new WeiboImportError(
      "weibo_no_importable_images",
      "微博图片链接无法转换为有效的 JSONL 导入清单"
    );
  }

  return {
    post: presentWeiboPost(post),
    manifest
  };
}

export async function createWeiboImportBatchManifest(
  inputUrls: string[],
  options: WeiboManifestOptions
) {
  const extractionByLine = new Map<number, WeiboBatchExtraction>();
  const validUrls: IndexedWeiboUrl[] = [];
  const seenIdentifiers = new Set<string>();

  inputUrls.forEach((url, index) => {
    const line = index + 1;
    try {
      const parsedUrl = parseWeiboPostUrl(url);
      if (seenIdentifiers.has(parsedUrl.identifier)) return;
      seenIdentifiers.add(parsedUrl.identifier);
      validUrls.push({ line, url, parsedUrl });
    } catch (error) {
      extractionByLine.set(line, {
        line,
        error: createWeiboPostParseError(error, line, url)
      });
    }
  });

  if (validUrls.length) {
    const fetchImplementation = options.fetchImplementation ?? fetch;
    const visitorCookie = await createWeiboVisitorCookie(
      fetchImplementation,
      options.signal,
      options.requestTimeoutMs
    );
    let fetchedImageCount = 0;
    const fetched = await mapWithWorkerPool(
      validUrls,
      options.concurrency ?? appConfig.runtimeDefaults.weibo.concurrency,
      async ({ line, url, parsedUrl }): Promise<WeiboBatchExtraction> => {
        try {
          const post = await extractWeiboPostWithVisitor(parsedUrl, visitorCookie, options);
          fetchedImageCount += post.image_count;
          assertWeiboImageCountWithinHardLimit(fetchedImageCount);
          return {
            line,
            post
          };
        } catch (error) {
          if (
            error instanceof WeiboImportError
            && error.code === "weibo_image_limit_exceeded"
          ) {
            throw error;
          }
          return {
            line,
            error: createWeiboPostParseError(error, line, url)
          };
        }
      },
      { signal: options.signal }
    );
    for (const extraction of fetched) extractionByLine.set(extraction.line, extraction);
  }

  const posts: ExtractedWeiboPost[] = [];
  const errors: WeiboPostParseError[] = [];
  const seenWeiboIds = new Set<string>();
  for (let line = 1; line <= inputUrls.length; line += 1) {
    const extraction = extractionByLine.get(line);
    if (extraction?.post && !seenWeiboIds.has(extraction.post.weibo_id)) {
      seenWeiboIds.add(extraction.post.weibo_id);
      posts.push(extraction.post);
    }
    if (extraction?.error) errors.push(extraction.error);
  }

  assertWeiboImageCountWithinHardLimit(
    posts.reduce((total, post) => total + post.image_count, 0)
  );

  // 每条微博内部按接口返回的图片顺序展开；全局 JSONL 行号继续递增。
  // 相同发布时间下，靠后的图片会获得更大的 manifest_position，并在
  // image_time DESC, id DESC 的图库排序中显示为更新。
  const manifest = parseJsonlManifest(posts.map(weiboPostToJsonl).join("\n"), {
    maxItems: appConfig.imports.weiboImageHardLimit,
    timeZone: options.timeZone
  });

  return {
    posts: posts.map(presentWeiboPost),
    errors,
    manifest
  };
}
