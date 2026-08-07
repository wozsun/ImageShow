import {
  publicDocumentCacheControl,
  spaDocumentHeaders
} from "../core/http/headers.ts";
import {
  contentResponse,
  createContentRepresentation,
  type ContentRepresentation
} from "../core/http/content-response.ts";

type SpaDocumentResponseOptions = {
  cacheControl?: string;
  headers?: Readonly<Record<string, string>>;
  ifNoneMatch?: string | null;
};

export function createSpaDocumentRepresentation(body: string): ContentRepresentation {
  return createContentRepresentation(body);
}

export function spaDocumentResponse(
  representation: ContentRepresentation,
  options: SpaDocumentResponseOptions = {}
) {
  return contentResponse(representation, {
    cacheControl: options.cacheControl ?? publicDocumentCacheControl,
    contentType: "text/html; charset=utf-8",
    headers: options.headers ?? spaDocumentHeaders,
    ifNoneMatch: options.ifNoneMatch
  });
}
