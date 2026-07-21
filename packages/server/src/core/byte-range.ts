import { ApiError } from "./api-error.ts";

export type ByteRange = { start: number; end: number };

export function totalSizeFromContentRange(header: string | null | undefined) {
  if (!header) return undefined;
  const match = /^bytes\s+(?:\d+-\d+|\*)\/(\d+)$/i.exec(header.trim());
  if (!match) return undefined;
  const totalSize = Number(match[1]);
  return Number.isSafeInteger(totalSize) && totalSize >= 0 ? totalSize : undefined;
}

export function assertSingleByteRangeSyntax(header: string | undefined, totalSize?: number) {
  if (!header) return;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) {
    throw new ApiError(416, "range_not_satisfiable", "Only one byte range is supported", totalSize === undefined ? {} : { total_size: totalSize });
  }
}

export function parseSingleByteRange(header: string | undefined, totalSize: number): ByteRange | null {
  if (!header) return null;
  assertSingleByteRangeSyntax(header, totalSize);
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new ApiError(416, "range_not_satisfiable", "Requested range is not satisfiable", { total_size: totalSize });
    }
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : totalSize - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalSize || end < start) {
    throw new ApiError(416, "range_not_satisfiable", "Requested range is not satisfiable", { total_size: totalSize });
  }
  return { start, end: Math.min(end, totalSize - 1) };
}
