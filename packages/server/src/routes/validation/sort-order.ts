import { z } from "zod";
import { sortOrderMin, sortOrderMax, type SortOrderUpdateInputDto } from "@imageshow/shared/browser";

export const sortOrderUpdateInput = z.strictObject({
  sort_order: z.number().int().min(sortOrderMin).max(sortOrderMax)
}) satisfies z.ZodType<SortOrderUpdateInputDto>;
