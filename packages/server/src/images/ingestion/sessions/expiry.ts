import { appConfig } from "@imageshow/shared";
import type { IngestionQueueType } from "./model.ts";

export function queueIdleTtlMs(queue: IngestionQueueType) {
  return (queue === "upload"
    ? appConfig.ingestionRuntime.uploadSessionIdleTtlSeconds
    : appConfig.ingestionRuntime.importSessionIdleTtlSeconds) * 1000;
}
