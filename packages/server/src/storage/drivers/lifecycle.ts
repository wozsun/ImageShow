import type { Readable } from "node:stream";
import { ApiError } from "../../core/api-error.ts";
import type { StoragePrefix } from "../objects/keys.ts";
import type {
  OpenedRead,
  StorageCopyOptions,
  StorageDriver,
  StorageObjectReference,
  StoragePruneOptions,
  StorageRemoveOptions,
  StorageRequestOptions,
  StorageServerCopyOptions,
  StorageServerCopySource,
  StorageSelfTest,
  StorageStreamWriteOptions
} from "./driver.ts";
import type {
  StorageKeyListing,
  StorageKeyListOptions
} from "../objects/key-listing.ts";

function retiredDriverError() {
  return new ApiError(
    503,
    "storage_driver_retired",
    "Storage backend configuration changed while the operation was pending"
  );
}

/**
 * Retire one physical driver only after every operation that already entered
 * it has settled. Response streams retain their reference through EOF, error
 * or consumer cancellation.
 */
class ManagedStorageDriver implements StorageDriver {
  private readonly driver: StorageDriver;
  private activeReferences = 0;
  private retiring = false;
  private drained: (() => void) | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(driver: StorageDriver) {
    this.driver = driver;
  }

  private retain() {
    if (this.retiring) throw retiredDriverError();
    this.activeReferences += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeReferences -= 1;
      if (this.activeReferences === 0) {
        const drained = this.drained;
        this.drained = null;
        drained?.();
      }
    };
  }

  private async usingReference<T>(work: () => Promise<T>) {
    const release = this.retain();
    try {
      return await work();
    } finally {
      release();
    }
  }

  private retainBody(opened: OpenedRead, release: () => void) {
    const finish = () => {
      opened.body.off("end", finish);
      opened.body.off("error", finish);
      opened.body.off("close", finish);
      release();
    };
    opened.body.once("end", finish);
    opened.body.once("error", finish);
    opened.body.once("close", finish);
    if (opened.body.destroyed || opened.body.readableEnded) finish();
    return opened;
  }

  exists(prefix: StoragePrefix, key: string, options?: StorageRequestOptions) {
    return this.usingReference(() => this.driver.exists(prefix, key, options));
  }

  async openRead(
    prefix: StoragePrefix,
    key: string,
    range?: string,
    options?: StorageRequestOptions
  ) {
    const release = this.retain();
    try {
      return this.retainBody(
        await this.driver.openRead(prefix, key, range, options),
        release
      );
    } catch (error) {
      release();
      throw error;
    }
  }

  readBuffer(prefix: StoragePrefix, key: string, options?: StorageRequestOptions) {
    return this.usingReference(() => this.driver.readBuffer(prefix, key, options));
  }

  writeBuffer(
    prefix: StoragePrefix,
    key: string,
    body: Buffer,
    contentType: string,
    options?: StorageRequestOptions
  ) {
    return this.usingReference(() => (
      this.driver.writeBuffer(prefix, key, body, contentType, options)
    ));
  }

  writeStream(
    prefix: StoragePrefix,
    key: string,
    body: Readable,
    size: number,
    contentType: string,
    options?: StorageStreamWriteOptions
  ) {
    return this.usingReference(() => (
      this.driver.writeStream(prefix, key, body, size, contentType, options)
    ));
  }

  removeObjects(
    objects: readonly StorageObjectReference[],
    options?: StorageRemoveOptions
  ) {
    return this.usingReference(() => (
      this.driver.removeObjects(objects, options)
    ));
  }

  copy(
    fromPrefix: StoragePrefix,
    fromKey: string,
    toPrefix: StoragePrefix,
    toKey: string,
    options?: StorageCopyOptions
  ) {
    return this.usingReference(() => this.driver.copy(
      fromPrefix,
      fromKey,
      toPrefix,
      toKey,
      options
    ));
  }

  serverCopySource(prefix: StoragePrefix, key: string, size: number) {
    return this.driver.serverCopySource(prefix, key, size);
  }

  supportsServerCopySource(source: StorageServerCopySource) {
    return this.driver.supportsServerCopySource(source);
  }

  copyFromServerSource(
    source: StorageServerCopySource,
    toPrefix: StoragePrefix,
    toKey: string,
    options: StorageServerCopyOptions
  ) {
    return this.usingReference(() => this.driver.copyFromServerSource(
      source,
      toPrefix,
      toKey,
      options
    ));
  }

  async *listKeys(
    prefix: StoragePrefix,
    options?: StorageKeyListOptions
  ): StorageKeyListing {
    const release = this.retain();
    try {
      return yield* this.driver.listKeys(prefix, options);
    } finally {
      release();
    }
  }

  selfTest(options?: StorageRequestOptions): Promise<StorageSelfTest> {
    return this.usingReference(() => this.driver.selfTest(options));
  }

  pruneEmptyDirs(options?: StoragePruneOptions) {
    return this.usingReference(() => this.driver.pruneEmptyDirs(options));
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.retiring = true;
    this.closePromise = this.closeAfterDrain();
    return this.closePromise;
  }

  private async closeAfterDrain() {
    if (this.activeReferences > 0) {
      await new Promise<void>((resolve) => { this.drained = resolve; });
    }
    await this.driver.close?.();
  }
}

export function manageStorageDriver(driver: StorageDriver): StorageDriver {
  return new ManagedStorageDriver(driver);
}
