import type { Readable } from "node:stream";
import type { StorageType } from "@imageshow/shared/browser";
import type { StoragePrefix } from "./object-keys.ts";
import type {
  StorageKeyListing,
  StorageKeyListOptions
} from "./key-listing.ts";

export type OpenedRead = {
  body: Readable;
  size: number | undefined;
  totalSize: number | undefined;
  contentRange?: string;
  etag?: string;
  lastModified?: string;
  backend: StorageType;
};

export type CopyPrefix = "media" | "thumbs" | "_uploads";

export type StorageRequestOptions = {
  signal?: AbortSignal;
};

export type StoragePruneOptions = StorageRequestOptions & {
  prefix?: StoragePrefix;
  maxEntries?: number;
};

export type StorageCopyOptions = StorageRequestOptions & {
  /** Stable local atomic-candidate suffix owned by a durable cleanup guard. */
  atomicCandidateToken?: string;
};

export type StorageSelfTest = {
  backend: StorageType;
  writable: boolean;
  storage_dir?: string;
  bucket?: string;
  endpoint?: string;
};

export interface StorageDriver {
  close?(): void | Promise<void>;
  exists(
    prefix: StoragePrefix,
    key: string,
    options?: StorageRequestOptions
  ): Promise<boolean>;
  openRead(
    prefix: StoragePrefix,
    key: string,
    range?: string,
    options?: StorageRequestOptions
  ): Promise<OpenedRead>;
  readBuffer(
    prefix: StoragePrefix,
    key: string,
    options?: StorageRequestOptions
  ): Promise<Buffer>;
  writeBuffer(
    prefix: StoragePrefix,
    key: string,
    body: Buffer,
    type: string,
    options?: StorageRequestOptions
  ): Promise<void>;
  remove(
    prefix: StoragePrefix,
    key: string,
    options?: StorageRequestOptions
  ): Promise<void>;
  copy(
    fromPrefix: CopyPrefix,
    fromKey: string,
    toPrefix: CopyPrefix,
    toKey: string,
    options?: StorageCopyOptions
  ): Promise<void>;
  listKeys(
    prefix: StoragePrefix,
    options?: StorageKeyListOptions
  ): StorageKeyListing;
  selfTest(options?: StorageRequestOptions): Promise<StorageSelfTest>;
  pruneEmptyDirs(options?: StoragePruneOptions): Promise<number>;
}
