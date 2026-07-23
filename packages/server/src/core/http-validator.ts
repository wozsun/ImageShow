export type HttpValidators = {
  etag?: string;
  lastModified?: string;
};

export function staticResponseEtag(headers: Headers) {
  const modified = headers.get("Last-Modified");
  const contentRange = headers.get("Content-Range");
  const rangeTotal = contentRange?.match(/^bytes\s+\d+-\d+\/(\d+)$/i)?.[1];
  const length = rangeTotal ?? headers.get("Content-Length");
  const modifiedTime = modified ? new Date(modified).getTime() : Number.NaN;
  const resourceLength = length === null ? Number.NaN : Number(length);
  if (
    !Number.isFinite(modifiedTime)
    || !Number.isSafeInteger(resourceLength)
    || resourceLength < 0
  ) return "";
  const encoding = headers.get("Content-Encoding") ?? "identity";
  return `W/"${modifiedTime.toString(16)}-${resourceLength.toString(16)}-${encoding}"`;
}

function stripWeakPrefix(etag: string) {
  return etag.startsWith("W/") ? etag.slice(2) : etag;
}

function isEntityTag(value: string) {
  return /^(?:W\/)?"[^"\r\n]*"$/.test(value);
}

function parseHttpDate(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) * 1000 : null;
}

function weakEtagMatches(left: string, right: string) {
  return isEntityTag(left) && isEntityTag(right) && stripWeakPrefix(left) === stripWeakPrefix(right);
}

function strongEtagMatches(left: string, right: string) {
  return isEntityTag(left) && isEntityTag(right)
    && !left.startsWith("W/") && !right.startsWith("W/")
    && left === right;
}

function parseEntityTagList(header: string) {
  const candidates: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (character === '"') quoted = !quoted;
    else if (character === "," && !quoted) {
      candidates.push(header.slice(start, index).trim());
      start = index + 1;
    }
  }
  candidates.push(header.slice(start).trim());
  return quoted ? [] : candidates;
}

/** If-None-Match uses weak comparison for GET and HEAD responses. */
export function ifNoneMatchMatches(header: string | null | undefined, etag?: string | null) {
  if (!header) return false;
  return parseEntityTagList(header).some((candidate) => {
    return candidate === "*" || Boolean(etag && weakEtagMatches(candidate, etag));
  });
}

function ifModifiedSinceMatches(
  header: string | null | undefined,
  lastModified: string | null | undefined
) {
  const requestedTime = parseHttpDate(header);
  const modifiedTime = parseHttpDate(lastModified);
  return requestedTime !== null && modifiedTime !== null && modifiedTime <= requestedTime;
}

export function ifRangeMatches(
  header: string | null | undefined,
  validators: HttpValidators
) {
  const candidate = header?.trim();
  if (!candidate) return true;
  if (candidate.startsWith("W/") || candidate.startsWith('"')) {
    return Boolean(validators.etag && strongEtagMatches(candidate, validators.etag));
  }
  const requestedTime = parseHttpDate(candidate);
  const modifiedTime = parseHttpDate(validators.lastModified);
  return requestedTime !== null && modifiedTime !== null && modifiedTime <= requestedTime;
}

export function conditionalRequestNotModified(input: {
  ifNoneMatch?: string | null;
  ifModifiedSince?: string | null;
  etag?: string | null;
  lastModified?: string | null;
}) {
  if (input.ifNoneMatch) {
    return ifNoneMatchMatches(input.ifNoneMatch, input.etag);
  }
  return ifModifiedSinceMatches(input.ifModifiedSince, input.lastModified);
}
