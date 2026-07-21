import type { Readable } from "node:stream";
import { ApiError } from "../core/api-error.ts";
import type { StorageType, StorageConfig } from "./backend-config.ts";
import type { ReadablePrefix, StoragePrefix } from "./object-keys.ts";
import { LocalBackend } from "./local-backend.ts";
import { S3Backend } from "./s3-backend.ts";
import { WebdavBackend } from "./webdav-backend.ts";

export type OpenedRead = {
  body: Readable;
  size: number | undefined;
  totalSize: number | undefined;
  contentRange?: string;
  etag?: string;
  lastModified?: string;
  backend: StorageType;
};

export type CopyPrefix = "media" | "thumbs" | "link" | "_uploads";

export type StorageSelfTest = {
  backend: StorageType;
  writable: boolean;
  storage_dir?: string;
  bucket?: string;
  endpoint?: string;
  public_base_url?: string;
};

export interface StorageDriver {
  close?(): void | Promise<void>;
  exists(prefix: StoragePrefix, key: string): Promise<boolean>;
  openRead(prefix: StoragePrefix, key: string, range?: string): Promise<OpenedRead>;
  readBuffer(prefix: StoragePrefix, key: string): Promise<Buffer>;
  writeBuffer(prefix: StoragePrefix, key: string, body: Buffer, type: string): Promise<void>;
  remove(prefix: StoragePrefix, key: string): Promise<void>;
  copy(fromPrefix: CopyPrefix, fromKey: string, toPrefix: CopyPrefix, toKey: string): Promise<void>;
  listKeys(prefix: StoragePrefix): Promise<string[]>;

  publicObjectUrl(prefix: ReadablePrefix, key: string): string;
  selfTest(): Promise<StorageSelfTest>;

  pruneEmptyDirs(): Promise<number>;
}

export function isStorageNotFoundError(error: unknown) {
  return error instanceof ApiError && error.status === 404;
}

export function createStorageDriver(config: StorageConfig): StorageDriver {
  if (config.type === "s3") return new S3Backend(config);
  if (config.type === "webdav") return new WebdavBackend(config);
  return new LocalBackend();
}
