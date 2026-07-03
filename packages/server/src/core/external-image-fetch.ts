import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fileTypeFromBuffer } from "file-type";
import { ApiError } from "./http.js";
import { logger } from "./logger.js";

const maxExternalRedirects = 5;
const imageSniffBytes = 4100;
const allowedImageMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const metadataHostnames = new Set(["metadata", "metadata.google.internal"]);
const externalImageRejectedCode = "external_image_rejected";
const externalImageRejectedMessage = "外部图片请求未通过安全校验";
const tlsCertificateErrorCodes = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);

type ImageValidation = "sniff" | "header" | "none";

export type SafeExternalImageFetchOptions = {
  method?: "GET" | "HEAD";
  headers?: HeadersInit;
  timeoutMs: number;
  signal?: AbortSignal;
  imageValidation?: ImageValidation;
};

export function isExternalImageRejection(error: unknown) {
  return error instanceof ApiError && error.code === externalImageRejectedCode;
}

function externalImageRejected(reason: string, context: Record<string, unknown> = {}) {
  logger.debug("external image rejected", { reason, ...context });
  return new ApiError(400, externalImageRejectedCode, externalImageRejectedMessage);
}

function urlLogContext(url: URL) {
  return {
    protocol: url.protocol,
    hostname: normalizeHostname(url.hostname)
  };
}

function normalizeHostname(hostname: string) {
  const lower = hostname.toLowerCase().replace(/\.$/, "");
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

function parseIpv4(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function ipv4InRange(address: number, base: number, bits: number) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (base & mask);
}

function isBlockedIpv4(address: string) {
  const value = parseIpv4(address);
  if (value === null) return true;
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ].some(([base, bits]) => ipv4InRange(value, parseIpv4(base as string) ?? 0, bits as number));
}

function parseIpv6(address: string): bigint | null {
  const clean = address.toLowerCase().split("%", 1)[0];
  const ipv4Tail = clean.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  let value = clean;
  let tailParts: string[] = [];
  if (ipv4Tail) {
    const ipv4 = parseIpv4(ipv4Tail);
    if (ipv4 === null) return null;
    value = clean.slice(0, clean.length - ipv4Tail.length).replace(/:$/, "");
    tailParts = [((ipv4 >>> 16) & 0xffff).toString(16), (ipv4 & 0xffff).toString(16)];
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = 8 - tailParts.length - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => "0"), ...right, ...tailParts];
  if (parts.length !== 8) return null;

  let result = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    result = (result << 16n) + BigInt(parseInt(part, 16));
  }
  return result;
}

function ipv6InRange(address: bigint, base: bigint, bits: number) {
  const all = (1n << 128n) - 1n;
  const mask = bits === 0 ? 0n : (all << BigInt(128 - bits)) & all;
  return (address & mask) === (base & mask);
}

function isBlockedIpv6(address: string) {
  const value = parseIpv6(address);
  if (value === null) return true;
  const mapped = parseIpv6("::ffff:0:0");
  if (mapped !== null && ipv6InRange(value, mapped, 96)) {
    const ipv4 = Number(value & 0xffffffffn);
    return isBlockedIpv4(`${(ipv4 >>> 24) & 255}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`);
  }
  return [
    ["::", 128],
    ["::1", 128],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
    ["2001:db8::", 32]
  ].some(([base, bits]) => {
    const parsedBase = parseIpv6(base as string);
    return parsedBase !== null && ipv6InRange(value, parsedBase, bits as number);
  });
}

function isBlockedIp(address: string) {
  const family = isIP(address);
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function tlsCertificateErrorCode(error: unknown) {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && tlsCertificateErrorCodes.has(code)) return code;
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && /\b(certificate|cert|self[- ]signed|hostname\/IP does not match|altname)\b/i.test(message)) {
      return "TLS_CERTIFICATE_INVALID";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return "";
}

function assertTlsCertificateVerificationEnabled() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw externalImageRejected("tls_verification_disabled");
  }
}

async function validateExternalImageUrl(input: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw externalImageRejected("invalid_url");
  }
  if (url.protocol !== "https:") {
    throw externalImageRejected("invalid_protocol", urlLogContext(url));
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || metadataHostnames.has(hostname)) {
    throw externalImageRejected("blocked_hostname", urlLogContext(url));
  }

  const directIp = isIP(hostname);
  if (directIp) {
    throw externalImageRejected("direct_ip_hostname", urlLogContext(url));
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw externalImageRejected("dns_lookup_failed", urlLogContext(url));
  }
  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) {
    throw externalImageRejected("blocked_resolved_address", urlLogContext(url));
  }
  return url;
}

function isRedirect(status: number) {
  return [301, 302, 303, 307, 308].includes(status);
}

function isAllowedImageContentType(value: string | null) {
  const mime = value?.split(";")[0]?.trim().toLowerCase() ?? "";
  return allowedImageMimeTypes.has(mime);
}

function imageMimeFromExt(ext?: string) {
  const normalized = ext === "jpg" ? "jpeg" : ext;
  return normalized && ["jpeg", "png", "webp", "gif", "avif"].includes(normalized) ? `image/${normalized}` : "";
}

async function responseWithSniffedImageBody(response: Response) {
  if (!response.body) throw externalImageRejected("empty_image_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let detectedMime = "";

  try {
    while (total < imageSniffBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
      const detected = await fileTypeFromBuffer(Buffer.concat(chunks, total));
      detectedMime = imageMimeFromExt(detected?.ext);
      if (detectedMime) break;
    }
    if (!detectedMime) throw externalImageRejected("unsupported_image_body");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  let bufferedIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (bufferedIndex < chunks.length) {
          controller.enqueue(chunks[bufferedIndex]);
          bufferedIndex += 1;
          return;
        }
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });

  const headers = new Headers(response.headers);
  if (!isAllowedImageContentType(headers.get("content-type"))) headers.set("Content-Type", detectedMime);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

function abortError(signal?: AbortSignal) {
  if (signal?.aborted) return new ApiError(409, "import_cancelled", "导入已取消");
  return new ApiError(400, "external_url_timeout", "外部图片请求超时");
}

function responseWithAbortScope(
  response: Response,
  cleanup: () => void
) {
  if (!response.body) {
    cleanup();
    return response;
  }
  const reader = response.body.getReader();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    cleanup();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          close();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel(reason) {
      close();
      return reader.cancel(reason);
    }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function fetchWithTimeout(url: URL, options: SafeExternalImageFetchOptions) {
  assertTlsCertificateVerificationEnabled();
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs);
  let handedOff = false;
  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  };
  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      redirect: "manual",
      signal: controller.signal
    });
    handedOff = Boolean(response.body);
    return responseWithAbortScope(response, cleanup);
  } catch (error) {
    if ((error as Error).name === "AbortError") throw abortError(options.signal);
    if (tlsCertificateErrorCode(error)) throw externalImageRejected("tls_certificate_invalid", urlLogContext(url));
    throw error;
  } finally {
    if (!handedOff) cleanup();
  }
}

export async function safeFetchExternalImage(input: string, options: SafeExternalImageFetchOptions): Promise<Response> {
  let current = input;
  for (let redirects = 0; redirects <= maxExternalRedirects; redirects += 1) {
    const url = await validateExternalImageUrl(current);
    const response = await fetchWithTimeout(url, options);
    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw externalImageRejected("redirect_without_location", urlLogContext(url));
      current = new URL(location, url).toString();
      continue;
    }

    if (!response.ok) return response;

    const validation = options.imageValidation ?? "sniff";
    try {
      if (validation === "header" && !isAllowedImageContentType(response.headers.get("content-type"))) {
        await response.body?.cancel().catch(() => undefined);
        throw externalImageRejected("unsupported_image_header", urlLogContext(url));
      }
      if (validation === "sniff" && options.method !== "HEAD") return responseWithSniffedImageBody(response);
      return response;
    } catch (error) {
      if ((error as Error).name === "AbortError") throw abortError(options.signal);
      throw error;
    }
  }
  throw externalImageRejected("redirect_limit_exceeded");
}
