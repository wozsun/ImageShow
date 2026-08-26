import type {
  IngestionQueueEventDto,
  IngestionQueueSummaryDto,
  IngestionQueueTypeDto,
  IngestionSessionPairDto,
  ServerIngestionItemDto
} from "@imageshow/shared/browser";
import type { ServerIngestionQueueBaseline } from "./server-ingestion-queue-state.js";

export type ServerIngestionQueueStatus =
  | "idle"
  | "connecting"
  | "loading"
  | "ready"
  | "disconnected"
  | "error";

export type ServerIngestionQueueView = Readonly<{
  status: ServerIngestionQueueStatus;
  connectionGeneration: number;
  actionScope: string;
  revision: number | null;
  lastAcceptedOrder: number | null;
  summary: IngestionQueueSummaryDto | null;
  items: readonly ServerIngestionItemDto[];
  staleItems: readonly IngestionSessionPairDto[];
  actionWatermark: string;
  error: string;
}>;

export function emptyServerIngestionQueueView(
  status: ServerIngestionQueueStatus,
  connectionGeneration: number,
  error = ""
): ServerIngestionQueueView {
  return {
    status,
    connectionGeneration,
    actionScope: "",
    revision: null,
    lastAcceptedOrder: null,
    summary: null,
    items: [],
    staleItems: [],
    actionWatermark: "",
    error
  };
}

export function readyServerIngestionQueueView(
  connectionGeneration: number,
  actionScope: string,
  baseline: ServerIngestionQueueBaseline
): ServerIngestionQueueView {
  return {
    status: "ready",
    connectionGeneration,
    actionScope,
    revision: baseline.revision,
    lastAcceptedOrder: baseline.lastAcceptedOrder,
    summary: baseline.summary,
    items: baseline.items,
    staleItems: baseline.staleItems,
    actionWatermark: baseline.actionWatermark,
    error: ""
  };
}

export function retainedServerIngestionQueueView(
  status: Extract<ServerIngestionQueueStatus, "loading" | "disconnected">,
  connectionGeneration: number,
  actionScope: string,
  baseline: ServerIngestionQueueBaseline
): ServerIngestionQueueView {
  return {
    ...readyServerIngestionQueueView(connectionGeneration, actionScope, baseline),
    status
  };
}

export function parseServerIngestionQueueEvent(
  raw: string,
  expectedType: IngestionQueueEventDto["type"],
  expectedQueue: IngestionQueueTypeDto
) {
  const parsed = JSON.parse(raw) as Partial<IngestionQueueEventDto>;
  if (parsed.type !== expectedType || parsed.queue !== expectedQueue) {
    throw new Error("内容接入队列事件格式无效");
  }
  return parsed as IngestionQueueEventDto;
}
