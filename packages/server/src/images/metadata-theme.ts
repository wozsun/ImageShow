import { z } from "zod";
import { slugMaxLength, slugPattern } from "@imageshow/shared/browser";

/** 6.2.0 transition for old JSONL, frozen requests and Redis drafts. */
export function upgradeThemeValue(value: string | null): string | null {
  return value === "none" ? null : value;
}

export const imageThemeInput = z.string().trim().toLowerCase().min(1)
  .max(slugMaxLength).regex(slugPattern).nullable().transform(upgradeThemeValue);

/** Keep outstanding request/commit identities stable during this upgrade. */
export function themeIntentHashValue(value: string | null): string {
  return value ?? "none";
}
