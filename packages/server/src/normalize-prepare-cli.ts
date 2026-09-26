import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import type { PreparationAction } from "@imageshow/shared/browser";
import { deploymentConfig } from "./config/deployment-config.ts";
import { initializeRuntimeConfig } from "./config/runtime-config-store.ts";
import { configureDatabasePools, closeDatabasePools } from "./core/database/pools.ts";
import { assertCoreDatabaseReady } from "./core/database/schema.ts";
import { claimBackgroundJob, markBackgroundJobSucceeded, renewBackgroundJobLease, rescheduleBackgroundJob } from "./jobs/repository.ts";
import { WorkerExecutionCoordinator } from "./jobs/worker-execution.ts";
import type { BackgroundJob } from "./jobs/types.ts";
import { handlePreparationJob, recoverPreparationJob } from "./images/preparation/execution.ts";
import { controlPreparation, readPreparationStatus } from "./images/preparation/service.ts";
import { acquireApplicationHost } from "./images/preparation/process-ownership.ts";

configureDatabasePools(deploymentConfig.database);
let host: Awaited<ReturnType<typeof acquireApplicationHost>> | undefined;
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    profile: { type: "string" }, concurrency: { type: "string" }
  } });
  const command = positionals[0];
  if (positionals.length !== 1 || !["start", "stop", "verify", "retry", "reconcile", "set-concurrency", "status", "run"].includes(command ?? "")) {
    throw new Error("用法: normalize-prepare-cli.js start|stop|verify|retry|reconcile|set-concurrency|status|run [--profile 文件.json] [--concurrency 1–8]");
  }
  initializeRuntimeConfig();
  await assertCoreDatabaseReady();
  if (command === "run") {
    host = await acquireApplicationHost();
    const worker = new WorkerExecutionCoordinator<BackgroundJob, Awaited<ReturnType<typeof handlePreparationJob>>>({
      taskTimeoutMs: () => null,
      leaseRenewalIntervalMs: 5_000, renewLease: renewBackgroundJobLease, execute: handlePreparationJob,
      async settle(job, completion) {
        if (completion.status === "fulfilled") await markBackgroundJobSucceeded(job);
        else await rescheduleBackgroundJob(job, 0);
      }
    });
    let exiting = false;
    const stop = (manual: boolean) => {
      if (exiting) return;
      exiting = true;
      void (async () => {
        if (manual) {
          const status = await readPreparationStatus();
          if (status.run_id) await controlPreparation({ action: "stop", revision: status.revision });
        }
      })().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }).finally(() => worker.stop());
    };
    process.once("SIGINT", () => stop(true));
    process.once("SIGTERM", () => stop(false));
    host.signal.addEventListener("abort", () => stop(false), { once: true });
    await recoverPreparationJob();
    while (!exiting) {
      const ran = await worker.claimAndRun(() => claimBackgroundJob("normalize.prepare"));
      if (!ran) break;
      await delay(250);
    }
    worker.stop();
    await worker.drain(40_000);
  } else if (command !== "status") {
    const status = await readPreparationStatus();
    await controlPreparation({
      action: command as PreparationAction, revision: status.revision,
      profile: values.profile ? JSON.parse(await readFile(values.profile, "utf8")) : undefined,
      concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency)
    });
  }
  process.stdout.write(`${JSON.stringify(await readPreparationStatus(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await host?.close();
  await closeDatabasePools();
}
