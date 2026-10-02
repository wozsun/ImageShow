import type { AdminSession } from "./admin-session-context.ts";

declare module "hono" {
  interface ContextVariableMap {
    session: AdminSession | undefined;
    logRequestId: string | undefined;
    requestBodyBytes: number | undefined;
    embedDocumentResponse: boolean | undefined;
    adminReadRequest: boolean | undefined;
  }
}
