import { withStorageLocationReadLock } from "../../../storage/maintenance-lock.ts";
import { removeStorageObjectAndConfirm } from "../../../storage/objects/access.ts";
import { ingestionRetiredCleanupQueue } from "../cleanup/retry-queue.ts";

async function removeCommittedStagingKeys(
  storageSlug: string,
  keys: readonly string[]
) {
  await withStorageLocationReadLock(async (signal) => {
    const removals = await Promise.allSettled(keys.map((key) => (
      removeStorageObjectAndConfirm("_uploads", key, storageSlug, { signal })
    )));
    const failures = removals.flatMap((result) => (
      result.status === "rejected" ? [result.reason] : []
    ));
    if (failures.length) {
      throw new AggregateError(failures, "Committed Ingestion staging cleanup failed");
    }
  });
}

type IngestionCommitStagingCleanupPlanDependencies = {
  removeImmediately?: (key: string) => Promise<void>;
  removeRetained?: (keys: readonly string[]) => Promise<void>;
  schedule?: (work: () => Promise<void>) => Promise<void>;
};

/**
 * Retains the exact prepared-object paths from the PostgreSQL boundary until
 * direct removal succeeds or the bounded retry queue accepts ownership.
 */
export class IngestionCommitStagingCleanupPlan {
  readonly #keys: readonly string[];
  readonly #removeImmediately: (key: string) => Promise<void>;
  readonly #removeRetained: (keys: readonly string[]) => Promise<void>;
  readonly #schedule: (work: () => Promise<void>) => Promise<void>;
  #pendingKeys: string[] = [];
  #scheduled = false;

  constructor(
    storageSlug: string,
    keys: readonly string[],
    dependencies: IngestionCommitStagingCleanupPlanDependencies = {}
  ) {
    this.#keys = [...keys];
    this.#removeImmediately = dependencies.removeImmediately
      ?? (async (key) => {
        await removeStorageObjectAndConfirm("_uploads", key, storageSlug);
      });
    this.#removeRetained = dependencies.removeRetained
      ?? ((retainedKeys) => removeCommittedStagingKeys(storageSlug, retainedKeys));
    this.#schedule = dependencies.schedule
      ?? ((work) => ingestionRetiredCleanupQueue.enqueue(work));
  }

  arm() {
    this.#pendingKeys = [...this.#keys];
  }

  async removeNow() {
    const keys = [...this.#pendingKeys];
    const removals = await Promise.allSettled(keys.map(this.#removeImmediately));
    this.#pendingKeys = removals.flatMap((result, index) => (
      result.status === "rejected" ? [keys[index]!] : []
    ));
    return this.#pendingKeys.length;
  }

  async enqueueRetained() {
    if (!this.#pendingKeys.length || this.#scheduled) return;
    const retainedKeys = [...this.#pendingKeys];
    await this.#schedule(() => this.#removeRetained(retainedKeys));
    this.#scheduled = true;
  }
}
