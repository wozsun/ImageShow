import { appConfig } from "@imageshow/shared";
import { mapWithWorkerPool } from "../../core/concurrency.ts";
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
  WeiboImportError,
  type ExtractedWeiboPost,
  type ParsedWeiboPostUrl,
  type WeiboPostParseError
} from "./weibo-types.ts";

type WeiboExtractionOptions = {
  authorSlugs: Readonly<Record<string, string>>;
  concurrency?: number;
  signal?: AbortSignal;
};

type WeiboManifestOptions = WeiboExtractionOptions & {
  timeZone?: string;
};

type IndexedWeiboUrl = {
  line: number;
  url: string;
  parsedUrl: ParsedWeiboPostUrl;
};

type WeiboBatchExtraction =
  | { line: number; post: ExtractedWeiboPost; error?: never }
  | { line: number; post?: never; error: WeiboPostParseError };

async function extractWeiboPostWithVisitor(
  parsedUrl: ParsedWeiboPostUrl,
  visitorCookie: string,
  options: WeiboExtractionOptions
) {
  const rawStatus = await fetchWeiboStatus(
    parsedUrl.identifier,
    visitorCookie,
    options.signal
  );
  return extractWeiboPost(rawStatus, parsedUrl, options.authorSlugs);
}

function weiboPostToJsonl(post: ExtractedWeiboPost) {
  const publicationYear = post.published_at.slice(0, 4);
  return post.original_image_urls.map((original) => JSON.stringify({
    original,
    source: post.source_url,
    image_time: post.published_at,
    device: "auto",
    brightness: "auto",
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
    const visitorCookie = await createWeiboVisitorCookie(options.signal);
    let fetchedImageCount = 0;
    const fetched = await mapWithWorkerPool(
      validUrls,
      options.concurrency ?? appConfig.runtimeDefaults.weibo.concurrency,
      async ({ line, url, parsedUrl }): Promise<WeiboBatchExtraction> => {
        try {
          const post = await extractWeiboPostWithVisitor(
            parsedUrl,
            visitorCookie,
            options
          );
          fetchedImageCount += post.image_count;
          assertWeiboImageCountWithinHardLimit(fetchedImageCount);
          return { line, post };
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
    for (const extraction of fetched) {
      extractionByLine.set(extraction.line, extraction);
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
    posts.map(weiboPostToJsonl).join("\n"),
    {
      maxItems: appConfig.imports.weiboImageHardLimit,
      timeZone: options.timeZone
    }
  );

  return {
    post_count: posts.length,
    errors: errors.map(({ line, url, error }) => ({ line, url, error })),
    manifest
  };
}
