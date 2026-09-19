const redacted = "[redacted]";
const truncated = "[truncated]";
const sensitiveFields = new Set([
  "password", "passwordhash", "passphrase", "secret", "secretaccesskey", "accesskeyid", "accesskey",
  "token", "accesstoken", "refreshtoken", "sessiontoken", "sessionid", "producerexecutiontoken", "executiontoken",
  "authorization", "proxyauthorization", "cookie", "setcookie", "csrf", "csrftoken", "xcsrftoken",
  "body", "requestbody", "responsebody", "payload", "raw", "source", "original", "originalurl",
  "path", "filepath", "localpath", "directory", "rootpath", "storagedirectory", "configfile",
  "namespaceidentity", "namespaceidentities"
]);
const fieldName = (key: string) => key.toLowerCase().replace(/[-_]/g, "");

/** Only recognized credential formats are scrubbed; arbitrary prose is not a secret detector. */
export function safeLogText(value: string, maximumLength = 2_000): string {
  let text = value.slice(0, 16_384);
  text = text.replace(/\b(?:https?|s3|postgres(?:ql)?|rediss?|file):\/\/[^\s<>"']+/gi, (raw) => {
    try {
      const url = new URL(raw);
      return url.protocol === "file:" ? "[path]" : `[url:${url.protocol}//${url.hostname}]`;
    } catch {
      return "[url]";
    }
  });
  text = text.replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, redacted);
  text = text.replace(/\b(?:cookie|set-cookie)\s*:[^\r\n]*/gi, redacted);
  text = text.replace(/("?([a-z][a-z0-9_-]{0,63})"?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;{}]+)/gi,
    (whole, prefix: string, key: string) => sensitiveFields.has(fieldName(key)) ? `${prefix}${redacted}` : whole);
  text = text.replace(/(?:\b[a-z]:[\\/]|\\\\)[^\r\n"'<>|]*/gi, "[path]");
  text = text.replace(/(^|[\s('"=])\/[^\s"'<>()[\]{},;]+/g, "$1[path]");
  text = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return text.length > maximumLength ? text.slice(0, maximumLength) + truncated : text;
}

function safeStack(value: unknown) {
  if (Array.isArray(value)) value = value.slice(0, 10).filter((item) => typeof item === "string").join("\n");
  if (typeof value !== "string") return undefined;
  const frames: string[] = [];
  for (const line of value.slice(0, 16_384).split("\n")) {
    const normalized = line.replace(/\\/g, "/");
    const location = normalized.match(/((?:packages|node_modules|assets)\/[\w./@-]+:\d+:\d+|node:[\w/.-]+:\d+:\d+)/)?.[1];
    if (!location) continue;
    const name = normalized.match(/^\s*(?:at\s+)?([\w.$<> [\]-]+)\s+\(/)?.[1]?.trim();
    frames.push(name ? `${safeLogText(name, 120)} (${location})` : location);
    if (frames.length === 10) break;
  }
  return frames;
}

export type SafeLogValue = null | boolean | number | string | SafeLogValue[] | { [key: string]: SafeLogValue };

/** Builds bounded plain data; only known Error fields use guarded accessor reads. */
export function safeLogValue(value: unknown): SafeLogValue {
  const seen = new WeakSet<object>();
  let remainingNodes = 128;
  let remainingText = 6_000;
  const text = (value: string, maximumLength = 2_000) => {
    if (remainingText <= 0) return truncated;
    const result = safeLogText(value, Math.min(maximumLength, remainingText));
    remainingText -= result.length;
    return result;
  };
  const visit = (current: unknown, depth: number, key = ""): SafeLogValue => {
    if (--remainingNodes < 0 || depth > 6) return truncated;
    if (sensitiveFields.has(fieldName(key))) return redacted;
    if (key === "stack") return visit(safeStack(current) ?? [], depth + 1);
    if (current == null) return null;
    if (typeof current === "boolean" || typeof current === "number") return current;
    // Registered HTTP templates carry routing information, not filesystem locations.
    if (key === "route" && typeof current === "string" && /^\/[a-z0-9_/:*.-]*$/i.test(current)) {
      const route = current.slice(0, Math.max(0, Math.min(240, remainingText)));
      remainingText -= route.length;
      return route;
    }
    if (typeof current === "string") return text(current);
    if (typeof current === "bigint") return text(current.toString());
    if (typeof current !== "object") return `[${typeof current}]`;
    if (seen.has(current)) return "[circular]";
    seen.add(current);
    try {
      if (current instanceof Error) {
        const field = (name: string) => {
          try { return Reflect.get(current, name) as unknown; } catch { return undefined; }
        };
        const name = field("name");
        const message = field("message");
        const result: Record<string, SafeLogValue> = {
          name: typeof name === "string" ? text(name, 120) : "Error"
        };
        // Parser/validator errors may echo complete configuration or response fragments.
        if (name === "SyntaxError" || name === "ZodError") {
          result.message = name === "SyntaxError" ? "Invalid syntax (input omitted)" : "Validation failed (input omitted)";
          if (typeof message === "string") {
            const position = message.match(/\bposition (\d+)(?: \(line (\d+) column (\d+)\))?/);
            if (position) result.position = position[0];
          }
          const issues = field("issues");
          if (name === "ZodError" && Array.isArray(issues)) {
            result.issues = visit(issues.slice(0, 16).map((issue) => ({
              code: issue.code,
              field: Array.isArray(issue.path) ? issue.path.filter((part: unknown) => typeof part === "string" || typeof part === "number").join(".") : ""
            })), depth + 1);
          }
        } else if (typeof message === "string") {
          let safeMessage = message.slice(0, 16_384);
          for (const fieldName of ["path", "dest"]) {
            const path = field(fieldName);
            if (typeof path === "string" && path) safeMessage = safeMessage.split(path).join("[path]");
          }
          result.message = text(safeMessage);
        }
        for (const name of ["code", "status", "errno", "syscall", "cause", "errors"]) {
          const detail = field(name);
          if (detail !== undefined) result[name] = visit(detail, depth + 1, name);
        }
        const stack = safeStack(field("stack"));
        if (stack?.length) result.stack = visit(stack, depth + 1);
        return result;
      }
      if (ArrayBuffer.isView(current) || current instanceof ArrayBuffer) return "[binary]";
      if (current instanceof URL) return text(current.href);
      if (Array.isArray(current)) {
        const result: SafeLogValue[] = [];
        for (let index = 0; index < Math.min(current.length, 32); index++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          result.push(descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : "[accessor]");
          if (remainingNodes <= 0) break;
        }
        if (current.length > result.length) result.push(truncated);
        return result;
      }
      const result: Record<string, SafeLogValue> = Object.create(null);
      const name = Object.getOwnPropertyDescriptor(current, "name")?.value;
      const contentError = name === "SyntaxError" || name === "ZodError";
      let count = 0;
      for (const key in current) {
        if (!Object.hasOwn(current, key)) continue;
        if (count++ === 32 || remainingNodes <= 0) { result.truncated = true; break; }
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        result[text(key, 120)] = contentError && key === "message" ? "Invalid input (content omitted)" : descriptor && "value" in descriptor
          ? visit(descriptor.value, depth + 1, key)
          : "[accessor]";
      }
      return result;
    } catch {
      return "[uninspectable]";
    } finally {
      seen.delete(current);
    }
  };
  return visit(value, 0);
}

export function formatLogContext(value: unknown): string {
  const text = JSON.stringify(safeLogValue(value));
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= 8_192) return text;
  const preview = new TextDecoder().decode(encoder.encode(text).subarray(0, 4_000), { stream: true });
  return JSON.stringify({ truncated: true, preview });
}
