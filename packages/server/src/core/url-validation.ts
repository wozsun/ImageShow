import { isIP } from "node:net";

type HttpsUrlOptions = {
  requireDomain?: boolean;
};

export function isHttpsUrl(value: string, options: HttpsUrlOptions = {}) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
      return false;
    }
    return !options.requireDomain || isIP(parsed.hostname.replace(/^\[|\]$/g, "")) === 0;
  } catch {
    return false;
  }
}

export function isRootRelativeOrHttpsUrl(value: string) {
  if (value.startsWith("/") && !value.startsWith("//")) {
    return !/[\\\u0000-\u001f\u007f]/.test(value);
  }
  return isHttpsUrl(value);
}

export function isHttpsEndpoint(value: string) {
  if (!value) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return isHttpsUrl(value);
  return isHttpsUrl(`https://${value}`);
}
