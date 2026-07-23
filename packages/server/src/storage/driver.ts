import type { Readable } from "node:stream";
import type { StorageType } from "@imageshow/shared";
import type { ReadablePrefix, StoragePrefix } from "./object-keys.ts";

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
  openRead(
    prefix: StoragePrefix,
    key: string,
    range?: string
  ): Promise<OpenedRead>;
  readBuffer(prefix: StoragePrefix, key: string): Promise<Buffer>;
  writeBuffer(
    prefix: StoragePrefix,
    key: string,
    body: Buffer,
    type: string
  ): Promise<void>;
  remove(prefix: StoragePrefix, key: string): Promise<void>;
  copy(
    fromPrefix: CopyPrefix,
    fromKey: string,
    toPrefix: CopyPrefix,
    toKey: string
  ): Promise<void>;
  listKeys(prefix: StoragePrefix): Promise<string[]>;
  publicObjectUrl(prefix: ReadablePrefix, key: string): string;
  selfTest(): Promise<StorageSelfTest>;
  pruneEmptyDirs(): Promise<number>;
}
