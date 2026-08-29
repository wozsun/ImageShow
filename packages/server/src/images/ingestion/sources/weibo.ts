import { appConfig } from "@imageshow/shared";
import type { WeiboImportResultDto } from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../../../config/runtime-config-store.ts";
import { parseJsonlManifest } from "./jsonl.ts";
import {
  createWeiboVisitorCookie,
  fetchWeiboStatus
} from "./weibo-client.ts";
import {
  extractWeiboPost,
  parseWeiboPostUrl
} from "./weibo-parser.ts";
import {
  createWeiboRequestScheduler
} from "./weibo-request-scheduler.ts";
import {
  WeiboImportError,
  type ExtractedWeiboPost,
  type ParsedWeiboPostUrl,
  type WeiboPostParseError
} from "./weibo-types.ts";

type WeiboExtractionOptions = {
  authorSlugs: Readonly<Record<string, string>>;
  signal?: AbortSignal;
};

type WeiboManifestOptions = WeiboExtractionOptions & {
  timeZone?: string;
  sourceEnabled: boolean;
};

type IndexedWeiboUrl = {
  line: number;
  url: string;
  parsedUrl: ParsedWeiboPostUrl;
};

type WeiboBatchExtraction =
  | { line: number; post: ExtractedWeiboPost; error?: never }
  | { line: number; post?: never; error: WeiboPostParseError };

const weiboRequestScheduler = createWeiboRequestScheduler({
  createVisitorIdentity: (signal) => createWeiboVisitorCookie(signal),
  delayRange: () => {
    const [minDelaySeconds, maxDelaySeconds] = getRuntimeConfig().weibo
      .request_delay_seconds;
    return {
      minDelaySeconds,
      maxDelaySeconds
    };
  }
});

export function weiboPostToJsonl(
  post: ExtractedWeiboPost,
  sourceEnabled: boolean
) {
  const publicationYear = post.published_at.slice(0, 4);
  return post.original_image_urls.map((original) => JSON.stringify({
    original,
    ...(sourceEnabled ? { source: post.source_url } : {}),
    image_time: post.published_at,
    device: "auto",
    brightness: "auto",
    tags: [publicationYear],
    ...(post.author ? { author: post.author } : {})
  })).join("\n");
}

function assertWeiboImageCountWithinHardLimit(imageCount: number) {
  if (imageCount <= appConfig.ingestion.weiboImageHardLimit) return;
  throw new WeiboImportError(
    "weibo_image_limit_exceeded",
    `单批微博解析结果不能超过 ${appConfig.ingestion.weiboImageHardLimit} 张图片`
  );
}

function createWeiboPostParseError(
  error: unknown,
  line: number,
  url: string
): WeiboPostParseError {
  if (!(error instanceof WeiboImportError)) throw error;
  return { line, url, code: error.code, error: error.message };
}

export async function createWeiboImportBatchManifest(
  inputUrls: string[],
  options: WeiboManifestOptions
): Promise<WeiboImportResultDto> {
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
    let fetchedImageCount = 0;
    const fetched = await weiboRequestScheduler.scheduleBatch(
      validUrls.map(({ line, parsedUrl }) => (
        async (visitorCookie: string, signal: AbortSignal): Promise<WeiboBatchExtraction> => {
          const post = extractWeiboPost(
            await fetchWeiboStatus(parsedUrl.identifier, visitorCookie, signal),
            parsedUrl,
            options.authorSlugs
          );
          fetchedImageCount += post.image_count;
          assertWeiboImageCountWithinHardLimit(fetchedImageCount);
          return { line, post };
        }
      )),
      options.signal
    );
    for (const [index, result] of fetched.entries()) {
      const { line, url } = validUrls[index];
      if (result.status === "fulfilled") {
        extractionByLine.set(line, result.value);
      } else {
        extractionByLine.set(line, {
          line,
          error: createWeiboPostParseError(result.reason, line, url)
        });
      }
    }
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
  const manifest = parseJsonlManifest(
    posts.map((post) => weiboPostToJsonl(
      post,
      options.sourceEnabled
    )).join("\n"),
    {
      maxItems: appConfig.ingestion.weiboImageHardLimit,
      timeZone: options.timeZone
    }
  );

  return {
    post_count: posts.length,
    errors: errors.map(({ line, url, error }) => ({ line, url, error })),
    manifest
  };
}
