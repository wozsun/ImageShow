import type { AnalyticsEventName, AnalyticsPage } from "@imageshow/shared/browser";
import type { DatabaseReader } from "../core/database/pools.ts";

export type VisitEventRow = {
  occurredAt: Date;
  visitorId: string;
  sessionId: string;
  event: AnalyticsEventName;
  page: AnalyticsPage;
  embedded: boolean;
  referrerHost: string | null;
  embedHost: string | null;
  device: string;
  browser: string;
  browserMajor: number | null;
  os: string;
  detail: Record<string, unknown>;
};

// Statistics are disposable: a full buffer drops new events instead of
// growing, and a failed write drops its batch instead of retrying.
const bufferCapacity = 5_000;
const writeBatchSize = 500;

let buffered: VisitEventRow[] = [];
let droppedSinceWrite = 0;

/** Returns false when the buffer is full and the events were dropped. */
export function bufferVisitEvents(rows: readonly VisitEventRow[]) {
  if (buffered.length + rows.length > bufferCapacity) {
    droppedSinceWrite += rows.length;
    return false;
  }
  buffered.push(...rows);
  return true;
}

export function visitEventBatchReady() {
  return buffered.length >= writeBatchSize;
}

export function discardBufferedVisitEvents() {
  buffered = [];
  droppedSinceWrite = 0;
}

/** Takes what the next write owns; later events stay for the following write. */
export function takeVisitEventBatches() {
  const taken = buffered;
  const dropped = droppedSinceWrite;
  buffered = [];
  droppedSinceWrite = 0;
  const batches: VisitEventRow[][] = [];
  for (let index = 0; index < taken.length; index += writeBatchSize) {
    batches.push(taken.slice(index, index + writeBatchSize));
  }
  return { batches, dropped };
}

export async function insertVisitEvents(database: DatabaseReader, rows: readonly VisitEventRow[]) {
  await database.query(
    `INSERT INTO visit_event (
       occurred_at, visitor_id, session_id, event, page, embedded,
       referrer_host, embed_host, device, browser, browser_major, os, detail
     )
     SELECT *
       FROM unnest(
         $1::timestamptz[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::boolean[],
         $7::text[], $8::text[], $9::text[], $10::text[], $11::integer[], $12::text[],
         $13::jsonb[]
       )`,
    [
      rows.map((row) => row.occurredAt),
      rows.map((row) => row.visitorId),
      rows.map((row) => row.sessionId),
      rows.map((row) => row.event),
      rows.map((row) => row.page),
      rows.map((row) => row.embedded),
      rows.map((row) => row.referrerHost),
      rows.map((row) => row.embedHost),
      rows.map((row) => row.device),
      rows.map((row) => row.browser),
      rows.map((row) => row.browserMajor),
      rows.map((row) => row.os),
      rows.map((row) => JSON.stringify(row.detail))
    ]
  );
}
