export type HttpValidators = {
  etag?: string;
  lastModified?: string;
};

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

/** If-None-Match uses weak comparison for GET and HEAD responses. */
export function ifNoneMatchMatches(header: string | null | undefined, etag?: string | null) {
  if (!header) return false;
  return header.split(",").some((rawCandidate) => {
    const candidate = rawCandidate.trim();
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
