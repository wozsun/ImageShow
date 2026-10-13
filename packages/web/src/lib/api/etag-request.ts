import { ApiClientError, fetchApi, parseApiResponse } from "./client.js";

/**
 * Read a JSON response with its ETag. With a cached representation it sends
 * If-None-Match and reuses that representation on 304.
 */
export async function apiWithEtag<T>(
  path: string,
  init: RequestInit = {},
  notModified?: Readonly<{ etag: string; data: T }>,
  inspectResponse?: (response: Response) => void
): Promise<Readonly<{ data: T; etag: string }>> {
  const headers = new Headers(init.headers);
  if (notModified?.etag) headers.set("If-None-Match", notModified.etag);
  const response = await fetchApi(path, { ...init, headers });
  inspectResponse?.(response);
  const responseEtag = response.headers.get("etag") ?? "";
  if (response.status === 304) {
    if (!notModified) {
      throw new ApiClientError("HTTP 304", response.status);
    }
    return {
      data: notModified.data,
      etag: responseEtag || notModified.etag
    };
  }
  return {
    data: await parseApiResponse<T>(response),
    // A 200 representation without its own validator must not inherit the
    // validator of the representation it replaced.
    etag: responseEtag
  };
}
