import { z } from "zod";

export const runtimeConfigSaveInput = z.strictObject({
  config: z.unknown(),
  revision: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
});
