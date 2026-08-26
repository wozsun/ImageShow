import type { IngestionJob } from "../../../../../lib/types.js";

export type DetachedProvisionalHandoff = Readonly<{
  connectionGeneration: number;
  job: IngestionJob;
}>;

export type HandoffRetryGate = Readonly<{
  connectionGeneration: number;
  revision: number;
  mode: "state-change" | "coverage";
}>;

export type ServerQueueConnectionSnapshot = Readonly<{
  status: "idle" | "connecting" | "loading" | "ready" | "disconnected" | "error";
  connectionGeneration: number;
  revision: number | null;
  lastAcceptedOrder: number | null;
}>;
