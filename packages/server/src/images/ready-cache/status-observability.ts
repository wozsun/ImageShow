import type {
  ReadyImageCacheRecentErrorDto
} from "@imageshow/shared/browser";
import { errorMessage } from "../../core/api-error.ts";

type ReadyImageCacheErrorScope = "core" | "derived";

const recentErrors: Record<
  ReadyImageCacheErrorScope,
  ReadyImageCacheRecentErrorDto | null
> = {
  core: null,
  derived: null
};

export function recordReadyImageCacheError(
  category: ReadyImageCacheErrorScope,
  code: string,
  error: unknown
) {
  recentErrors[category] = {
    category,
    code,
    message: errorMessage(error).slice(0, 1_000),
    occurred_at: new Date().toISOString()
  };
}

export function getReadyImageCacheRecentErrors() {
  return { ...recentErrors };
}
