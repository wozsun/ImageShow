import {
  getRuntimeConfig,
  onRuntimeConfigChange
} from "../../../config/runtime-config-store.ts";
import { abortSignalError } from "../../../core/abort.ts";
import { DynamicConcurrencyLimiter } from "../../../core/concurrency.ts";

type PrefetchWorkOutcome<Result> =
  | Readonly<{ status: "completed"; value: Result }>
  | Readonly<{ status: "failed"; error: unknown }>;

/**
 * Bounds remote materialization to one successor batch. A permit is retained
 * through download and normalization admission, then released while the
 * admitted normalization continues. The limit is derived from the sole
 * Normalize resource owner instead of exposing a second tuning value.
 */
const importPrefetchAdmission = new DynamicConcurrencyLimiter(
  () => getRuntimeConfig().normalize.concurrency,
  (signal) => abortSignalError(signal, "Import prefetch aborted")
);

onRuntimeConfigChange(() => importPrefetchAdmission.refresh());

export async function withImportPrefetchAdmission<Result>(
  signal: AbortSignal,
  work: (onNormalizationAdmitted: () => void) => Promise<Result>
) {
  let observed: Promise<PrefetchWorkOutcome<Result>> | undefined;
  await importPrefetchAdmission.run(signal, async () => {
    let admitted = false;
    let markAdmitted!: () => void;
    const normalizationAdmitted = new Promise<void>((resolve) => {
      markAdmitted = resolve;
    });
    const workPromise = Promise.resolve().then(() => work(() => {
      if (admitted) return;
      admitted = true;
      markAdmitted();
    }));
    observed = workPromise.then<
      PrefetchWorkOutcome<Result>,
      PrefetchWorkOutcome<Result>
    >(
      (value) => ({ status: "completed", value }),
      (error: unknown) => ({ status: "failed", error })
    );
    const first = await Promise.race([
      normalizationAdmitted.then(() => ({ status: "admitted" as const })),
      observed
    ]);
    if (first.status === "failed") throw first.error;
  });

  if (!observed) {
    throw new Error("Import prefetch work was not started");
  }
  const outcome = await observed;
  if (outcome.status === "failed") throw outcome.error;
  return outcome.value;
}
