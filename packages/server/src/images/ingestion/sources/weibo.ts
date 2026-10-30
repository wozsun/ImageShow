import { appConfig } from "@imageshow/shared";
import type {
  WeiboImportProgressDto,
  WeiboImportResultDto
} from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../../../config/runtime-config-store.ts";
import { resolveWeiboAuthorSlugs } from "../../../vocab/authors/query.ts";
import { parseJsonlManifest } from "./jsonl.ts";
import {
  createWeiboVisitorCookie,
  fetchWeiboStatus
} from "./weibo-client.ts";
import {
  extractWeiboPost,
  parseWeiboPostUrl
} from "./weibo-parser.ts";
import { createWeiboRequestScheduler } from "./weibo-request-scheduler.ts";
import {
  WeiboImportError,
  type ExtractedWeiboPost,
  type ParsedWeiboPostUrl,
  type WeiboPostParseError
} from "./weibo-types.ts";

type WeiboManifestOptions = {
  signal: AbortSignal;
  sourceEnabled: boolean;
  /** Receives a snapshot whenever a stage is entered, with the counts so far. */
  onProgress?: (progress: WeiboImportProgressDto) => void;
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
    const [minDelaySeconds, maxDelaySeconds] = getRuntimeConfig().weibo.request_delay_seconds;
    return {
      minDelaySeconds,
      maxDelaySeconds
    };
  }
});

/** @internal Exported only so contract tests can cover it directly. */
export function weiboPostToJsonl(
  post: ExtractedWeiboPost,
  sourceEnabled: boolean,
  authorSlugs: ReadonlyMap<string, string>
) {
  const publicationYear = post.published_at.slice(0, 4);
  return post.images
    .map((image) =>
      JSON.stringify({
        original: image.original_url,
        ...(sourceEnabled ? { source: post.source_url } : {}),
        image_time: post.published_at,
        device: "auto",
        brightness: "auto",
        tags: [publicationYear],
        ...(image.user_id && authorSlugs.has(image.user_id)
          ? { author: authorSlugs.get(image.user_id) }
          : {})
      })
    )
    .join("\n");
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

  const progress: WeiboImportProgressDto = {
    stage: "fetching",
    total: validUrls.length,
    processed: 0,
    failed: 0,
    images: 0
  };
  // Report a stage only once it is entered: the scheduler reports queueing
  // and the request interval, each request its start. Completed counts ride
  // on the next report instead of announcing the next post early.
  const reportStage = (stage: WeiboImportProgressDto["stage"]) => {
    progress.stage = stage;
    options.onProgress?.({ ...progress });
  };

  if (validUrls.length) {
    const fetched = await weiboRequestScheduler.scheduleBatch(
      validUrls.map(
        ({ line, parsedUrl }) =>
          async (visitorCookie: string, signal: AbortSignal): Promise<WeiboBatchExtraction> => {
            reportStage("fetching");
            try {
              const post = extractWeiboPost(
                await fetchWeiboStatus(parsedUrl.identifier, visitorCookie, signal),
                parsedUrl
              );
              progress.images += post.image_count;
              assertWeiboImageCountWithinHardLimit(progress.images);
              return { line, post };
            } catch (error) {
              progress.failed += 1;
              throw error;
            } finally {
              progress.processed += 1;
            }
          }
      ),
      options.signal,
      reportStage
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
    reportStage("finishing");
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

  const authorSlugs = await resolveWeiboAuthorSlugs(
    posts.flatMap((post) => post.images.flatMap((image) => (image.user_id ? [image.user_id] : [])))
  );
  const manifest = parseJsonlManifest(
    posts.map((post) => weiboPostToJsonl(
      post,
      options.sourceEnabled,
      authorSlugs
    )).join("\n"),
    { maxItems: appConfig.ingestion.weiboImageHardLimit }
  );

  return {
    post_count: posts.length,
    errors: errors.map(({ line, url, error }) => ({ line, url, error })),
    manifest
  };
}
