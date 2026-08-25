import { appConfig } from "@imageshow/shared";
import type { ImportSessionSnapshot } from "./session-model.ts";
import { ImportSessionRepository } from "./session-repository.ts";
import { heartbeatImportExecution } from "./execution-session.ts";

export async function withImportExecutionHeartbeat<T>(
  repository: ImportSessionRepository,
  session: ImportSessionSnapshot,
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
        heartbeatSession = await heartbeatImportExecution(
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
    appConfig.importRuntime.workerHeartbeatSeconds * 1000
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
