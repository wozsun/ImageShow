let csrfToken = "";
export const authExpiredEvent = "imageshow:auth-expired";

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = ""
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
    || pathname === "/img-count"
    || /^\/api\/images(?:\/[^/]+)?$/.test(pathname);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (init.method && init.method !== "GET" && csrfToken) headers.set("x-csrf-token", csrfToken);
  const method = String(init.method ?? "GET").toUpperCase();
  const credentials = init.credentials ?? (publicCacheableRequest(path, method) ? "omit" : "same-origin");
  const response = await fetch(path, { ...init, headers, credentials });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !path.includes("/auth/login") && !path.includes("/auth/me")) {
    clearCsrfToken();
    if (typeof window !== "undefined") window.dispatchEvent(new Event(authExpiredEvent));
  }
  if (!response.ok || data.ok === false) throw new ApiClientError(data.error || `HTTP ${response.status}`, response.status, data.code || "");
  return data;
}
