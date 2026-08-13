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
  return pathname === "/api/site-config"
    || pathname === "/api/gallery-facets"
    || pathname === "/api/gallery-stats"
    || /^\/api\/images(?:\/[^/]+)?$/.test(pathname);
}

export async function fetchApi(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const method = String(init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD" && csrfToken) headers.set("x-csrf-token", csrfToken);
  const credentials = init.credentials ?? (publicCacheableRequest(path, method) ? "omit" : "same-origin");
  const response = await fetch(path, { ...init, headers, credentials });
  if (response.status === 401 && !path.includes("/auth/login") && !path.includes("/auth/me")) {
    clearCsrfToken();
    if (typeof window !== "undefined") window.dispatchEvent(new Event(authExpiredEvent));
  }
  return response;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetchApi(path, init);
  const body = await response.text();
  let data: Record<string, unknown> = {};
  if (body) {
    try {
      data = JSON.parse(body) as Record<string, unknown>;
    } catch {
      // 非 JSON 错误由统一 HTTP fallback 展示，不泄露代理层 HTML 响应。
    }
  }
  if (!response.ok || data.ok === false) {
    const failure = data as Partial<ApiErrorResponseDto>;
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
