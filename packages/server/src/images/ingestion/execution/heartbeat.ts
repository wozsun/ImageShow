import { appConfig } from "@imageshow/shared";
import type { IngestionSessionSnapshot } from "../sessions/model.ts";
import { IngestionSessionRepository } from "../repository.ts";
import { heartbeatIngestionExecution } from "./session.ts";

export async function withIngestionExecutionHeartbeat<T>(
  repository: IngestionSessionRepository,
  session: IngestionSessionSnapshot,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>
) {
  const controller = new AbortController();
  const combinedSignal = AbortSignal.any([signal, controller.signal]);
  let stopped = false;
  let heartbeatSession = session;
  let heartbeat = Promise.resolve();
  const queueHeartbeat = () => {
    heartbeat = heartbeat.then(async () => {
      if (stopped || combinedSignal.aborted) return;
      try {
        heartbeatSession = await heartbeatIngestionExecution(
          repository,
          heartbeatSession
        );
      } catch (error) {
        if (!stopped && !combinedSignal.aborted) controller.abort(error);
      }
    });
  };
  const timer = setInterval(
    queueHeartbeat,
    appConfig.ingestionRuntime.workerHeartbeatSeconds * 1000
  );
  timer.unref();
  try {
    combinedSignal.throwIfAborted();
    const result = await work(combinedSignal);
    combinedSignal.throwIfAborted();
    return result;
  } finally {
    stopped = true;
    clearInterval(timer);
    await heartbeat;
  }
}
