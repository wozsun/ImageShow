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

export type ParsedWeiboPostUrl = {
  identifier: string;
  sourceUrl: string;
};

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
