import { ApiError } from "../core/api-error.ts";

export type PageWindow = Readonly<{
  page: number;
  limit: number;
  start: number;
  endExclusive: number;
}>;

/** Converts one validated page request into the only offset window used below. */
export function createPageWindow(page: number, limit: number): PageWindow {
  if (
    !Number.isSafeInteger(page)
    || page < 1
    || !Number.isSafeInteger(limit)
    || limit < 1
  ) {
    throw new ApiError(
      400,
      "validation_error",
      "page 与 limit 必须是正安全整数"
    );
  }
  const start = (page - 1) * limit;
  const endExclusive = start + limit;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(endExclusive)
  ) {
    throw new ApiError(
      400,
      "validation_error",
      "分页窗口超出安全整数范围"
    );
  }
  return Object.freeze({ page, limit, start, endExclusive });
}
