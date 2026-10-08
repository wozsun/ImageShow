import { imageGroupBatchLimit } from "@imageshow/shared/browser";
import { z } from "zod";
import { requestSlugInput, uuidInput } from "./primitives.ts";
import { sortOrderUpdateInput } from "./sort-order.ts";

export const groupSlugInput = requestSlugInput;
export const groupCreateInput = z.strictObject({
  slug: groupSlugInput,
  display_name: z.string().trim().max(64).default(""),
  sort_order: sortOrderUpdateInput.shape.sort_order.optional()
});
export const groupRenameInput = groupCreateInput.pick({ display_name: true });
// Invalid IDs belong to the per-item result, so one typo does not reject a batch.
export const groupAddInput = z.strictObject({
  ids: z.array(z.string().max(1024)).min(1).max(imageGroupBatchLimit)
});
export const groupRemoveInput = z.strictObject({
  ids: z.array(uuidInput).min(1).max(imageGroupBatchLimit)
});
