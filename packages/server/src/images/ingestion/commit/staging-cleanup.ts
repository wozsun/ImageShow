import { withStorageLocationReadLock } from "../../../storage/maintenance-lock.ts";
import {
  assertStorageRemovalResults,
  removeStorageObjectsAndConfirm,
  type ResolvedStorageRemovalResult
} from "../../../storage/objects/access.ts";
import { ingestionCleanupRetryQueue } from "../cleanup/retry-queue.ts";

async function removeCommittedStagingBatch(
  storageSlug: string,
  keys: readonly string[],
  signal?: AbortSignal
) {
  return removeStorageObjectsAndConfirm(
    keys.map((key) => ({
      prefix: "_uploads" as const,
      key,
      storageSlug
    })),
    { signal }
  );
}

function incompleteStagingKeys(
  removals: readonly ResolvedStorageRemovalResult[]
) {
  return removals.flatMap((result) => (
    result.status === "failed" || result.status === "unknown"
      ? [result.key]
      : []
  ));
}

async function removeCommittedStagingKeys(
  storageSlug: string,
  keys: readonly string[]
) {
  await withStorageLocationReadLock(async (signal) => {
    if (!keys.length) return;
    const removals = await removeCommittedStagingBatch(
      storageSlug,
      keys,
      signal
    );
    assertStorageRemovalResults(
      removals,
      "Committed Ingestion staging cleanup failed"
    );
  });
}

type IngestionCommitStagingCleanupDependencies = {
  removeImmediately?: (
    keys: readonly string[],
    signal?: AbortSignal
  ) => Promise<readonly string[]>;
  removeRetained?: (keys: readonly string[]) => Promise<void>;
  schedule?: (work: () => Promise<void>) => Promise<void>;
};

/**
 * Retains the exact prepared-object paths from the PostgreSQL boundary until
 * direct removal succeeds or the bounded retry queue accepts ownership.
 */
export class IngestionCommitStagingCleanup {
  readonly #keys: readonly string[];
  readonly #removeImmediately: (
    keys: readonly string[],
    signal?: AbortSignal
  ) => Promise<readonly string[]>;
  readonly #removeRetained: (keys: readonly string[]) => Promise<void>;
  readonly #schedule: (work: () => Promise<void>) => Promise<void>;
  #remainingKeys: string[] = [];
  #scheduled = false;

  constructor(
    storageSlug: string,
    keys: readonly string[],
    dependencies: IngestionCommitStagingCleanupDependencies = {}
  ) {
    this.#keys = [...keys];
    this.#removeImmediately = dependencies.removeImmediately
      ?? (async (immediateKeys, signal) => {
        if (!immediateKeys.length) return [];
        const results = await removeCommittedStagingBatch(
          storageSlug,
          immediateKeys,
          signal
        );
        return incompleteStagingKeys(results);
      });
    this.#removeRetained = dependencies.removeRetained
      ?? ((retainedKeys) => removeCommittedStagingKeys(storageSlug, retainedKeys));
    this.#schedule = dependencies.schedule
      ?? ((work) => ingestionCleanupRetryQueue.enqueue(work));
  }

  markDatabaseCommitted() {
    this.#remainingKeys = [...this.#keys];
  }

  async removeNow(signal?: AbortSignal) {
    const keys = [...this.#remainingKeys];
    if (!keys.length) return 0;
    try {
      this.#remainingKeys = [...await this.#removeImmediately(keys, signal)];
    } catch {
      // A request-level failure has no trustworthy per-object result. Retain
      // the whole exact set so the idempotent retry can preflight it again.
      this.#remainingKeys = keys;
    }
    return this.#remainingKeys.length;
  }

  async scheduleRemainingRemoval() {
    if (!this.#remainingKeys.length || this.#scheduled) return;
    const remainingKeys = [...this.#remainingKeys];
    await this.#schedule(() => this.#removeRetained(remainingKeys));
    this.#scheduled = true;
  }
}
