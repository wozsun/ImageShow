const nanosecondsPerMicrosecond = 1_000n;
const minimumCursorMicroseconds = BigInt(Number.MIN_SAFE_INTEGER);
const maximumCursorMicroseconds = BigInt(Number.MAX_SAFE_INTEGER);

// Redis ZSET scores and the existing cursor contract require an exact Number.
function isCursorMicroseconds(microseconds: bigint) {
  return microseconds >= minimumCursorMicroseconds
    && microseconds <= maximumCursorMicroseconds;
}

export function timestampMicroseconds(value: string) {
  let nanoseconds: bigint;
  try {
    nanoseconds = Temporal.Instant.from(value).epochNanoseconds;
  } catch {
    return null;
  }
  // Sub-microsecond precision would be truncated, so it is not a cursor time.
  if (nanoseconds % nanosecondsPerMicrosecond !== 0n) return null;
  const microseconds = nanoseconds / nanosecondsPerMicrosecond;
  return isCursorMicroseconds(microseconds) ? microseconds : null;
}

export function microsecondsTimestamp(microseconds: bigint) {
  if (!isCursorMicroseconds(microseconds)) return null;
  return Temporal.Instant
    .fromEpochNanoseconds(microseconds * nanosecondsPerMicrosecond)
    .toString({ fractionalSecondDigits: 6 });
}
