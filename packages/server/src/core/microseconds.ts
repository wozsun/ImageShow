const microsecondsPerSecond = 1_000_000n;
const minimumCursorMicroseconds = BigInt(Number.MIN_SAFE_INTEGER);
const maximumCursorMicroseconds = BigInt(Number.MAX_SAFE_INTEGER);
const cursorTimestampPattern = new RegExp(
  "^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2}):(\\d{2})" +
    "(?:\\.(\\d{1,6}))?(Z|[+-]\\d{2}(?::?\\d{2})?)$"
);

export function timestampMicroseconds(value: string) {
  const match = cursorTimestampPattern.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = Number((match[7] ?? "").padEnd(6, "0"));
  if (month < 1 || month > 12
    || day < 1 || day > 31
    || hour > 23
    || minute > 59
    || second > 59) {
    return null;
  }
  const localMilliseconds = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    second
  );
  if (!Number.isFinite(localMilliseconds)) return null;
  const localDate = new Date(localMilliseconds);
  if (
    localDate.getUTCFullYear() !== year ||
    localDate.getUTCMonth() !== month - 1 ||
    localDate.getUTCDate() !== day ||
    localDate.getUTCHours() !== hour ||
    localDate.getUTCMinutes() !== minute ||
    localDate.getUTCSeconds() !== second
  ) {
    return null;
  }

  const zone = match[8]!;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    const offsetHours = Number(digits.slice(0, 2));
    const offsetMinutePart = digits.length === 4
      ? Number(digits.slice(2))
      : 0;
    if (offsetHours > 23 || offsetMinutePart > 59) return null;
    offsetMinutes = (offsetHours * 60 + offsetMinutePart) * (zone.startsWith("-") ? -1 : 1);
  }
  const utcMilliseconds = localMilliseconds - offsetMinutes * 60_000;
  if (!Number.isSafeInteger(utcMilliseconds)) return null;
  const microseconds = BigInt(utcMilliseconds) * 1_000n + BigInt(fraction);
  // Redis ZSET scores and the existing cursor contract require an exact Number.
  return microseconds >= minimumCursorMicroseconds
    && microseconds <= maximumCursorMicroseconds
    ? microseconds
    : null;
}

export function microsecondsTimestamp(microseconds: bigint) {
  if (microseconds < minimumCursorMicroseconds
    || microseconds > maximumCursorMicroseconds) {
    return null;
  }
  let seconds = microseconds / microsecondsPerSecond;
  let fraction = microseconds % microsecondsPerSecond;
  if (fraction < 0) {
    seconds -= 1n;
    fraction += microsecondsPerSecond;
  }
  const date = new Date(Number(seconds) * 1_000);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.toISOString().slice(0, 19)}.${String(fraction).padStart(6, "0")}Z`;
}
