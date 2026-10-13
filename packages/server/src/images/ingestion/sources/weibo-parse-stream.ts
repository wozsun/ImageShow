import {
  packImageAddresses,
  type ApiErrorResponseDto,
  type WeiboImportProgressDto
} from "@imageshow/shared/browser";
import type { Context } from "hono";
import type { AdminSession } from "../../../core/http/admin-session-context.ts";
import { logger } from "../../../core/logger.ts";
import { streamAdminSse } from "../../../users/admin-sse.ts";
import { JsonlManifestError } from "./jsonl.ts";
import { createWeiboImportBatchManifest } from "./weibo.ts";
import { WeiboImportError } from "./weibo-types.ts";

// The response is already a 200 stream, so the request audit cannot record a
// failed parse; log it here, as a failed request would have been.
function parseFailure(error: unknown, owner: string): ApiErrorResponseDto {
  if (error instanceof WeiboImportError || error instanceof JsonlManifestError) {
    logger.warn("weibo_import_parse_failed", { owner, code: error.code, error: error.message });
    return { ok: false, code: error.code, error: error.message, details: {} };
  }
  logger.error("weibo_import_parse_failed", { owner, error });
  return { ok: false, code: "internal_error", error: "Internal server error", details: {} };
}

/**
 * Parse one batch of Weibo links on this request: push its progress, then end
 * with the result or the failure. Closing the request cancels the parse.
 */
export function streamWeiboImportParse(
  context: Context,
  session: AdminSession,
  urls: string[],
  options: Readonly<{ sourceEnabled: boolean; timeZone?: string }>
) {
  return streamAdminSse(
    context,
    { session, closedEvent: "weibo_import_parse_sse_closed" },
    async ({ stream, signal, close, onHeartbeat }) => {
      // Only the latest progress waits for the socket, so a slow client never
      // receives a backlog of stale stages.
      let latest: WeiboImportProgressDto | null = null;
      let writing: Promise<void> | null = null;
      const writeLatest = async () => {
        try {
          while (latest) {
            const data = JSON.stringify(latest);
            latest = null;
            await stream.writeSSE({ event: "progress", data });
          }
        } finally {
          writing = null;
        }
      };
      const publish = (progress: WeiboImportProgressDto) => {
        latest = progress;
        writing ??= writeLatest().catch(close);
      };
      onHeartbeat(() => {
        void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => undefined);
      });

      let outcome: { event: "result" | "error"; data: string };
      try {
        const result = await createWeiboImportBatchManifest(urls, {
          ...options,
          signal,
          onProgress: publish
        });
        outcome = { event: "result", data: JSON.stringify(packImageAddresses(result)) };
      } catch (error) {
        if (signal.aborted) throw error;
        outcome = { event: "error", data: JSON.stringify(parseFailure(error, session.username)) };
      }
      await writing;
      await stream.writeSSE(outcome);
    }
  );
}
