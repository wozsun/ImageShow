import { storageLayoutUpgradeBatchMaxItems } from "@imageshow/shared/browser";
import { z } from "zod";

export const storageLayoutUpgradeBatchInput = z.strictObject({
  limit: z.number().int().min(1).max(storageLayoutUpgradeBatchMaxItems)
});
