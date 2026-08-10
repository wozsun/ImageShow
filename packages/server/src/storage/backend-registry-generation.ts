import { ApiError } from "../core/api-error.ts";

function closedRegistryError() {
  return new ApiError(
    503,
    "storage_registry_closed",
    "Storage backend registry is shutting down"
  );
}

/**
 * Prevent an asynchronously loaded registry snapshot from publishing work
 * after a configuration invalidation. The commit callback intentionally runs
 * in the same synchronous turn as the generation check.
 */
export class StorageBackendRegistryGeneration {
  private value = 0;
  private closed = false;

  get current() {
    return this.value;
  }

  invalidate() {
    this.value += 1;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.invalidate();
  }

  assertOpen() {
    if (this.closed) throw closedRegistryError();
  }

  async commitStable<T, Result>(
    load: () => Promise<T>,
    commit: (value: T) => Result
  ): Promise<Result> {
    while (true) {
      this.assertOpen();
      const generation = this.value;
      const loaded = await load();
      this.assertOpen();
      if (generation !== this.value) continue;
      return commit(loaded);
    }
  }
}
