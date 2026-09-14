const connectionFailureCodes = new Set([
  "08000", "08001", "08003", "08006",
  "53300", "57P01", "57P02", "57P03",
  "ECONNREFUSED", "ECONNRESET", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
  "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"
]);

// These pg / pg-pool connection errors have no code. Do not classify arbitrary
// messages containing "connection", or intentional client closure, as outages.
const connectionFailureMessages = new Map([
  ["Connection terminated unexpectedly", "connection_terminated"],
  ["Connection terminated due to connection timeout", "connection_timeout"],
  ["timeout expired", "connection_timeout"],
  ["timeout exceeded when trying to connect", "pool_connection_timeout"],
  ["Client has encountered a connection error and is not queryable", "connection_failed"]
]);

/** A safe diagnostic reason, only for errors caught at a PostgreSQL read. */
export function databaseConnectionFailureReason(error: unknown) {
  if (!(error instanceof Error) || error.name === "AbortError") return undefined;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string") {
    return connectionFailureCodes.has(code) ? code : undefined;
  }
  return connectionFailureMessages.get(error.message);
}
