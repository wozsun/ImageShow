import { unpackImageAddresses } from "@imageshow/shared/browser";
import type { ApiErrorResponseDto } from "@imageshow/shared/browser";

let csrfToken = "";
export const authExpiredEvent = "imageshow:auth-expired";

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "",
    readonly details: unknown = {}
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError;
}

export function setCsrfToken(value: string) {
  csrfToken = value;
}

export function clearCsrfToken() {
  csrfToken = "";
}

export function getCsrfToken() {
  return csrfToken;
}

function publicCacheableRequest(path: string, method: string) {
  if (method !== "GET" && method !== "HEAD") return false;
  const pathname = new URL(path, "https://imageshow.invalid").pathname;
  return (
    pathname === "/api/site-config" ||
    pathname === "/api/gallery-facets" ||
    pathname === "/api/gallery-stats" ||
    /^\/api\/images(?:\/[^/]+)?$/.test(pathname)
  );
}

/**
 * The request half of `api()`, owning CSRF, credentials and auth expiry. It is
 * exported for admin clients that handle the response themselves (ETag
 * requests, event streams); others use `api()`.
 */
export async function fetchApi(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const method = String(init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && csrfToken) headers.set("x-csrf-token", csrfToken);
  const credentials =
    init.credentials ?? (publicCacheableRequest(path, method) ? "omit" : "same-origin");
  const response = await fetch(path, { ...init, headers, credentials });
  if (response.status === 401 && !path.includes("/auth/login") && !path.includes("/auth/me")) {
    clearCsrfToken();
    window.dispatchEvent(new Event(authExpiredEvent));
  }
  return response;
}

/** The response half of `api()`: a JSON success body, or an ApiClientError. */
export async function parseApiResponse<T>(response: Response): Promise<T> {
  if (response.status === 204) return {} as T;
  const body = await response.text();
  let data: unknown = {};
  try {
    data = unpackImageAddresses(JSON.parse(body));
  } catch {
    if (response.ok) {
      throw new ApiClientError(
        "服务器响应不是有效的 JSON",
        response.status,
        "invalid_json_response"
      );
    }
    // 非 JSON 错误由统一 HTTP fallback 展示，不泄露代理层 HTML 响应。
  }
  const failure =
    data !== null && typeof data === "object"
      ? data as Partial<ApiErrorResponseDto>
      : {};
  if (!response.ok || failure.ok === false) {
    throw new ApiClientError(
      typeof failure.error === "string"
        ? failure.error
        : `HTTP ${response.status}`,
      response.status,
      typeof failure.code === "string" ? failure.code : "",
      failure.details ?? {}
    );
  }
  return data as T;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  return parseApiResponse<T>(await fetchApi(path, init));
}
