import { createHash } from "node:crypto";
import {
  publicDocumentCacheControl,
  spaDocumentHeaders
} from "../core/http/headers.ts";
import { ifNoneMatchMatches } from "../core/http/validators.ts";

type SpaDocumentRepresentation = {
  body: string;
  etag: string;
};

export function createSpaDocumentRepresentation(body: string): SpaDocumentRepresentation {
  return {
    body,
    // 动态压缩可能为同一 HTML 内容选择不同 Content-Encoding。弱标签表达
    // 语义表示相同，不错误声称压缩前后的响应字节完全一致。
    etag: `W/"${createHash("sha256").update(body).digest("base64url")}"`
  };
}

export function spaDocumentResponse(
  representation: SpaDocumentRepresentation,
  ifNoneMatch?: string | null
) {
  const notModified = ifNoneMatchMatches(ifNoneMatch, representation.etag);
  return new Response(notModified ? null : representation.body, {
    status: notModified ? 304 : 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": publicDocumentCacheControl,
      ETag: representation.etag,
      ...spaDocumentHeaders
    }
  });
}
