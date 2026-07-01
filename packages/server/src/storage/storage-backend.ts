// The storage backend contract. Each driver is bound to one resolved
// StorageConfig and handles the actual reads/writes for that backend. Adding a
// new storage backend (another object store, a different local layout, …) means
// implementing StorageDriver and adding one branch to driverFor below — nothing
// else in the app imports the concrete backends directly.
import type { Readable } from "node:stream";
import type { StorageType, StorageConfig } from "../config/settings.js";
import type { ReadablePrefix, StoragePrefix } from "./object-keys.js";
import { LocalBackend } from "./local-backend.js";
import { S3Backend } from "./s3-backend.js";
import { WebdavBackend } from "./webdav-backend.js";

export type OpenedRead = { body: Readable; size: number | undefined; backend: StorageType };

export type MoveFromPrefix = "objects" | "_uploads";
export type MoveToPrefix = "objects";
// copy() re-keys within one backend: an original + its thumbnail on a category/theme move, and
// link-image thumbnails (relocated the same way), always as a backend-native copy (server-side on
// S3/WebDAV). "_uploads" is staging-only and never copied.
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
  writeUploadFromWeb(id: string, body: ReadableStream<Uint8Array>, expectedSize: number): Promise<void>;
  readObject(prefix: ReadablePrefix, key: string): Promise<Readable>;
  listKeys(prefix: StoragePrefix): Promise<string[]>;
  // Direct public URL for a readable object, or "" when the backend has none
  // (local, or S3 without a public_base_url) and the caller must fall back.
  publicObjectUrl(prefix: ReadablePrefix, key: string): string;
  selfTest(): Promise<StorageSelfTest>;
  // Removes directories left empty after files move/delete out of them (e.g. a deleted
  // theme's now-empty device-brightness/theme folder). Returns how many were removed.
  // Object stores have no real directories, so they return 0.
  pruneEmptyDirs(): Promise<number>;
}

// Selects the driver for a resolved config; its `type` field decides which
// implementation runs the operation.
export function driverFor(config: StorageConfig): StorageDriver {
  if (config.type === "s3") return new S3Backend(config);
  if (config.type === "webdav") return new WebdavBackend(config);
  return new LocalBackend();
}
