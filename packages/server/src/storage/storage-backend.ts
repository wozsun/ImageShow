import type { Readable } from "node:stream";
import type { StorageType, StorageConfig } from "../config/settings.js";
import type { ReadablePrefix, StoragePrefix } from "./object-keys.js";
import { LocalBackend } from "./local-backend.js";
import { S3Backend } from "./s3-backend.js";
import { WebdavBackend } from "./webdav-backend.js";

export type OpenedRead = { body: Readable; size: number | undefined; backend: StorageType };

export type MoveFromPrefix = "objects" | "_uploads";
export type MoveToPrefix = "objects" | "thumbs";

export type CopyPrefix = "objects" | "thumbs" | "link";

export type StorageSelfTest = {
  backend: StorageType;
  writable: boolean;
  storage_dir?: string;
  bucket?: string;
  endpoint?: string;
  public_base_url?: string;
};

export interface StorageDriver {
  exists(prefix: StoragePrefix, key: string): Promise<boolean>;
  openRead(prefix: StoragePrefix, key: string): Promise<OpenedRead>;
  readBuffer(prefix: StoragePrefix, key: string): Promise<Buffer>;
  writeBuffer(prefix: StoragePrefix, key: string, body: Buffer, type: string): Promise<void>;
  remove(prefix: StoragePrefix, key: string): Promise<void>;
  move(fromPrefix: MoveFromPrefix, fromKey: string, toPrefix: MoveToPrefix, toKey: string, targetContentType?: string): Promise<void>;
  copy(fromPrefix: CopyPrefix, fromKey: string, toPrefix: CopyPrefix, toKey: string): Promise<void>;
  readObject(prefix: ReadablePrefix, key: string): Promise<Readable>;
  listKeys(prefix: StoragePrefix): Promise<string[]>;

  publicObjectUrl(prefix: ReadablePrefix, key: string): string;
  selfTest(): Promise<StorageSelfTest>;

  pruneEmptyDirs(): Promise<number>;
}

export function driverFor(config: StorageConfig): StorageDriver {
  if (config.type === "s3") return new S3Backend(config);
  if (config.type === "webdav") return new WebdavBackend(config);
  return new LocalBackend();
}
