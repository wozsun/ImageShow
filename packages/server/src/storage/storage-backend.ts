// The storage backend contract. Each driver is bound to one resolved
// StorageConfig and handles the actual reads/writes for that backend. Adding a
// new storage backend (another object store, a different local layout, …) means
// implementing StorageDriver and adding one branch to driverFor below — nothing
// else in the app imports the concrete backends directly.
import type { Readable } from "node:stream";
import type { StorageBackend, StorageConfig } from "../config/settings.js";
import type { ReadablePrefix, StoragePrefix } from "./object-keys.js";
import { LocalBackend } from "./local-backend.js";
import { S3Backend } from "./s3-backend.js";

export type OpenedRead = { body: Readable; size: number | undefined; backend: StorageBackend };

export type MoveFromPrefix = "objects" | "_uploads" | "trash";
export type MoveToPrefix = "objects" | "trash";
export type CopyPrefix = "objects" | "thumbs" | "trash";

// The upload-session fields a backend needs to mint an upload target.
export type UploadTargetRow = {
  id: string;
  staging_object_key: string;
  expected_size: number;
  expires_at: Date | string;
  storage_backend: StorageBackend;
  content_md5_hex?: string;
};

export type UploadTarget = {
  upload_url: string;
  upload_headers: Record<string, string>;
  backend: string;
};

export type StorageSelfTest = {
  backend: StorageBackend;
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
  stat(prefix: StoragePrefix, key: string): Promise<{ size: number }>;
  writeUploadFromWeb(id: string, body: ReadableStream<Uint8Array>, expectedSize: number): Promise<void>;
  readObject(prefix: ReadablePrefix, key: string): Promise<Readable>;
  listKeys(prefix: StoragePrefix): Promise<string[]>;
  // Direct public URL for a readable object, or "" when the backend has none
  // (local, or S3 without a public_base_url) and the caller must fall back.
  publicObjectUrl(prefix: ReadablePrefix, key: string): string;
  createUploadTarget(row: UploadTargetRow): Promise<UploadTarget>;
  selfTest(): Promise<StorageSelfTest>;
}

// Selects the driver for a resolved config; its `backend` field decides which
// implementation runs the operation.
export function driverFor(config: StorageConfig): StorageDriver {
  return config.backend === "s3" ? new S3Backend(config) : new LocalBackend();
}
