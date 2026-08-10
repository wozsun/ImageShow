import { ApiError } from "../core/api-error.ts";
import type { ReadablePrefix, StoragePrefix } from "./object-keys.ts";
import type {
  CopyPrefix,
  OpenedRead,
  StorageDriver,
  StorageRequestOptions,
  StorageSelfTest
} from "./driver.ts";
import type {
  StorageKeyListing,
  StorageKeyListOptions
} from "./key-listing.ts";

const STORAGE_DRIVER_DRAIN_TIMEOUT_MS = 30_000;
const STORAGE_DRIVER_CLOSE_TIMEOUT_MS = 5_000;

type ManagedStorageDriverOptions = {
  drainTimeoutMs?: number;
  closeTimeoutMs?: number;
};

type CloseResult =
  | { status: "fulfilled" }
  | { status: "rejected"; reason: unknown }
  | { status: "timed_out"; reason: Error };

function retiredDriverError() {
  return new ApiError(
    503,
    "storage_driver_retired",
    "Storage backend configuration changed while the operation was pending"
  );
}

function checkedTimeout(
  value: number | undefined,
  fallback: number,
  description: string
) {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1) {
    throw new RangeError(`${description} must be a positive safe integer`);
  }
  return timeout;
}

async function settleCloseWithin(
  work: () => void | Promise<void>,
  timeoutMs: number,
  description: string
): Promise<CloseResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve().then(work).then(
    () => ({ status: "fulfilled" }) as const,
    (reason) => ({ status: "rejected", reason }) as const
  );
  const timeout = new Promise<CloseResult>((resolve) => {
    timer = setTimeout(() => resolve({
      status: "timed_out",
      reason: new Error(`${description} timed out after ${timeoutMs}ms`)
    }), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Keep one physical driver alive for every operation that already captured it.
 * Stream reads own their lease until EOF, error or consumer cancellation.
 */
class ManagedStorageDriver implements StorageDriver {
  private readonly driver: StorageDriver;
  private readonly drainTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private activeLeases = 0;
  private retiring = false;
  private drained: (() => void) | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(driver: StorageDriver, options: ManagedStorageDriverOptions = {}) {
    this.driver = driver;
    this.drainTimeoutMs = checkedTimeout(
      options.drainTimeoutMs,
      STORAGE_DRIVER_DRAIN_TIMEOUT_MS,
      "Storage driver drain timeout"
    );
    this.closeTimeoutMs = checkedTimeout(
      options.closeTimeoutMs,
      STORAGE_DRIVER_CLOSE_TIMEOUT_MS,
      "Storage driver close timeout"
    );
  }

  private acquireLease() {
    if (this.retiring) throw retiredDriverError();
    this.activeLeases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeLeases -= 1;
      if (this.activeLeases === 0) {
        const drained = this.drained;
        this.drained = null;
        drained?.();
      }
    };
  }

  private async withinLease<T>(work: () => Promise<T>) {
    const release = this.acquireLease();
    try {
      return await work();
    } finally {
      release();
    }
  }

  private bodyWithLease(opened: OpenedRead, release: () => void) {
    const releaseOnLifecycleEnd = () => {
      opened.body.off("end", releaseOnLifecycleEnd);
      opened.body.off("error", releaseOnLifecycleEnd);
      opened.body.off("close", releaseOnLifecycleEnd);
      release();
    };
    opened.body.once("end", releaseOnLifecycleEnd);
    opened.body.once("error", releaseOnLifecycleEnd);
    opened.body.once("close", releaseOnLifecycleEnd);
    if (opened.body.destroyed || opened.body.readableEnded) {
      releaseOnLifecycleEnd();
    }
    return opened;
  }

  exists(prefix: StoragePrefix, key: string, options?: StorageRequestOptions) {
    return this.withinLease(() => this.driver.exists(prefix, key, options));
  }

  async openRead(
    prefix: StoragePrefix,
    key: string,
    range?: string,
    options?: StorageRequestOptions
  ) {
    const release = this.acquireLease();
    try {
      return this.bodyWithLease(
        await this.driver.openRead(prefix, key, range, options),
        release
      );
    } catch (error) {
      release();
      throw error;
    }
  }

  readBuffer(prefix: StoragePrefix, key: string, options?: StorageRequestOptions) {
    return this.withinLease(() => this.driver.readBuffer(prefix, key, options));
  }

  writeBuffer(
    prefix: StoragePrefix,
    key: string,
    body: Buffer,
    type: string,
    options?: StorageRequestOptions
  ) {
    return this.withinLease(() => (
      this.driver.writeBuffer(prefix, key, body, type, options)
    ));
  }

  remove(prefix: StoragePrefix, key: string, options?: StorageRequestOptions) {
    return this.withinLease(() => this.driver.remove(prefix, key, options));
  }

  copy(
    fromPrefix: CopyPrefix,
    fromKey: string,
    toPrefix: CopyPrefix,
    toKey: string,
    options?: StorageRequestOptions
  ) {
    return this.withinLease(() => this.driver.copy(
      fromPrefix,
      fromKey,
      toPrefix,
      toKey,
      options
    ));
  }

  async *listKeys(
    prefix: StoragePrefix,
    options?: StorageKeyListOptions
  ): StorageKeyListing {
    const release = this.acquireLease();
    try {
      return yield* this.driver.listKeys(prefix, options);
    } finally {
      release();
    }
  }

  publicObjectUrl(prefix: ReadablePrefix, key: string) {
    return this.driver.publicObjectUrl(prefix, key);
  }

  selfTest(options?: StorageRequestOptions): Promise<StorageSelfTest> {
    return this.withinLease(() => this.driver.selfTest(options));
  }

  pruneEmptyDirs(options?: StorageRequestOptions) {
    return this.withinLease(() => this.driver.pruneEmptyDirs(options));
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.retiring = true;
    this.closePromise = this.closeAfterDrain();
    return this.closePromise;
  }

  private async closeAfterDrain() {
    const failures: unknown[] = [];
    let drainTimedOut = false;
    if (this.activeLeases > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolve) => { this.drained = resolve; }),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            drainTimedOut = true;
            failures.push(new Error(
              `Storage driver retirement timed out with ${this.activeLeases} active lease(s)`
            ));
            resolve();
          }, this.drainTimeoutMs);
        })
      ]);
      if (timer) clearTimeout(timer);
      this.drained = null;
    }

    if (!drainTimedOut) {
      const graceful = await settleCloseWithin(
        () => this.driver.close?.(),
        this.closeTimeoutMs,
        "Storage driver graceful close"
      );
      if (graceful.status !== "fulfilled") {
        failures.push(graceful.reason);
        await this.forceCloseAfterFailure(failures, true);
      }
    } else {
      await this.forceCloseAfterFailure(failures, false);
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Storage driver retirement failed");
    }
  }

  private async forceCloseAfterFailure(
    failures: unknown[],
    gracefulAlreadyAttempted: boolean
  ) {
    if (!this.driver.forceClose && gracefulAlreadyAttempted) {
      failures.push(new Error(
        "Storage driver does not expose forceClose after graceful close failure"
      ));
      return;
    }
    const forced = await settleCloseWithin(
      () => this.driver.forceClose
        ? this.driver.forceClose()
        : this.driver.close?.(),
      this.closeTimeoutMs,
      "Storage driver force close"
    );
    if (forced.status !== "fulfilled") failures.push(forced.reason);
  }
}

export function manageStorageDriver(
  driver: StorageDriver,
  options?: ManagedStorageDriverOptions
) {
  return new ManagedStorageDriver(driver, options);
}
