import { appConfig } from "@imageshow/shared";
import { ApiError } from "./api-error.ts";

const disallowedSelectorCharacters = /[\u0000-\u001f\u007f]/u;

export function splitSelectors(rawValues: string[]): { include: string[]; exclude: string[] } {
  const values = [...new Set(rawValues
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))];
  if (values.length > appConfig.randomQuery.maxSelectorsPerField) {
    throw new ApiError(
      400,
      "validation_error",
      `Too many selectors; maximum ${appConfig.randomQuery.maxSelectorsPerField}`
    );
  }
  const include: string[] = [];
  const exclude: string[] = [];
  for (const value of values) {
    const excluded = value.startsWith("!");
    const bare = excluded ? value.slice(1).trim() : value;
    if (
      !bare
      || [...bare].length > appConfig.randomQuery.maxSelectorCharacters
      || disallowedSelectorCharacters.test(bare)
    ) {
      throw new ApiError(400, "validation_error", "Invalid image selector");
    }
    (excluded ? exclude : include).push(bare);
  }
  return { include, exclude };
}
