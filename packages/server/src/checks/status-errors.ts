import type {
  AdminCheckErrorCategory,
  AdminCheckFailureDto,
  AdminCheckResourceDto
} from "@imageshow/shared/browser";
import { errorMessage } from "../core/api-error.ts";

function errorCode(error: unknown, fallback: string) {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && code ? code : fallback;
}

function looksLikeConnectionFailure(error: unknown) {
  const value = error as { code?: unknown; name?: unknown };
  const code = typeof value?.code === "string" ? value.code : "";
  const name = typeof value?.name === "string" ? value.name : "";
  return name === "redis_unavailable"
    || code.startsWith("08")
    || [
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ETIMEDOUT",
      "NR_CLOSED"
    ].includes(code)
    || /connection|socket|redis unavailable/iu.test(errorMessage(error));
}

function adminCheckFailure(
  error: unknown,
  fallbackCategory: AdminCheckErrorCategory,
  fallbackCode: string
): AdminCheckFailureDto {
  return {
    category: looksLikeConnectionFailure(error)
      ? "connection"
      : fallbackCategory,
    code: errorCode(error, fallbackCode),
    message: errorMessage(error)
  };
}

export async function captureAdminCheck<T>(
  work: () => Promise<T>,
  fallbackCategory: AdminCheckErrorCategory,
  fallbackCode: string
): Promise<AdminCheckResourceDto<T>> {
  try {
    return { status: "ok", data: await work(), error: null };
  } catch (error) {
    return {
      status: "error",
      data: null,
      error: adminCheckFailure(error, fallbackCategory, fallbackCode)
    };
  }
}
