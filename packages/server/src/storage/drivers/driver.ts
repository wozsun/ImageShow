import type { Readable } from "node:stream";
import type { StorageType } from "@imageshow/shared/browser";
import type { StoragePrefix } from "../objects/keys.ts";
import type {
  StorageKeyListing,
  StorageKeyListOptions
} from "../objects/key-listing.ts";

export type OpenedRead = {
  body: Readable;
  size: number | undefined;
  totalSize: number | undefined;
  contentRange?: string;
  etag?: string;
  /** Provider validator that can guard a native server-side copy. */
  serverCopyValidator?: string;
  lastModified?: string;
  backend: StorageType;
};

export type StorageRequestOptions = {
  signal?: AbortSignal;
};

export type StorageStreamWriteOptions = StorageRequestOptions & {
  /** Expected hexadecimal MD5 when the destination protocol can verify it. */
  expectedMd5?: string;
};

/** Opaque provider-owned locator used only to negotiate a native server copy. */
export type StorageServerCopySource = Readonly<{
  provider: string;
  compatibility: string;
  size: number;
  location: Readonly<Record<string, string>>;
}>;

export type StorageServerCopyOptions = StorageRequestOptions & {
  /** Validator observed while the source bytes were verified. */
  sourceValidator: string;
};

export type StorageObjectReference = Readonly<{
  prefix: StoragePrefix;
  key: string;
}>;

export type StorageRemovalFailure = Readonly<{
  code: string;
  message: string;
}>;

export type StorageRemovalResult =
  | StorageObjectReference & { status: "removed"; error?: never }
  | StorageObjectReference & { status: "missing"; error?: never }
  | StorageObjectReference & {
      status: "failed";
      error: StorageRemovalFailure;
    }
  | StorageObjectReference & {
      status: "unknown";
      error: StorageRemovalFailure;
    };

export type StorageRemoveOptions = StorageRequestOptions & {
  /** S3-compatible providers may omit successful keys from the response. */
  quiet?: boolean;
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
    contentType: string,
    options?: StorageRequestOptions
  ): Promise<void>;
  writeStream(
    prefix: StoragePrefix,
    key: string,
    body: Readable,
    size: number,
    contentType: string,
    options?: StorageStreamWriteOptions
  ): Promise<void>;
  removeObjects(
    objects: readonly StorageObjectReference[],
    options?: StorageRemoveOptions
  ): Promise<StorageRemovalResult[]>;
  copy(
    fromPrefix: StoragePrefix,
    fromKey: string,
    toPrefix: StoragePrefix,
    toKey: string,
    options?: StorageCopyOptions
  ): Promise<void>;
  serverCopySource(
    prefix: StoragePrefix,
    key: string,
    size: number
  ): StorageServerCopySource | undefined;
  supportsServerCopySource(source: StorageServerCopySource): boolean;
  copyFromServerSource(
    source: StorageServerCopySource,
    toPrefix: StoragePrefix,
    toKey: string,
    options: StorageServerCopyOptions
  ): Promise<void>;
  listKeys(
    prefix: StoragePrefix,
    options?: StorageKeyListOptions
  ): StorageKeyListing;
  selfTest(options?: StorageRequestOptions): Promise<StorageSelfTest>;
  pruneEmptyDirs(options?: StoragePruneOptions): Promise<number>;
}
