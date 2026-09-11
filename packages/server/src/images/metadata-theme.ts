import { z } from "zod";
import { slugMaxLength, slugPattern } from "@imageshow/shared/browser";

export const imageThemeInput = z.string().trim().toLowerCase().min(1)
  .max(slugMaxLength).regex(slugPattern).nullable();
