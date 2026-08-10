import type { CapturedMoveCleanupObject } from "./move-cleanup.ts";

export type StorageMigrationImageRecord = {
  id: string;
  object_key: string;
  ext: string;
  storage_slug: string;
  device: string;
  brightness: string;
  theme: string;
  md5: string;
};

export type StorageMigrationResult = "migrated" | "unchanged" | "missing";

export type StorageMigrationState = {
  storage_slug: string;
  object_key: string;
  status: string;
};

export type PreparedImageStorageMigration = {
  image: StorageMigrationImageRecord;
  target: string;
  created: readonly CapturedMoveCleanupObject[];
  sourceCleanup: readonly CapturedMoveCleanupObject[];
  thumbnailSize: number;
};

export type ImageStorageMigrationPreparation =
  | { status: "prepared"; migration: PreparedImageStorageMigration }
  | { status: "unchanged" | "missing" };

export const storageMigrationColumns = [
  "id",
  "object_key",
  "ext",
  "storage_slug",
  "device",
  "brightness",
  "theme",
  "md5"
].join(", ");
