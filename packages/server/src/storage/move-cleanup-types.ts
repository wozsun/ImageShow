import type { StoragePrefix } from "./object-keys.ts";

export type MoveCleanupObjectInput = {
  prefix: StoragePrefix;
  key: string;
  backend: string;
};

export type CapturedMoveCleanupObject = MoveCleanupObjectInput & {
  /** Physical namespace captured when the object became unreferenced. */
  namespace_identity: string;
};

export type MoveCleanupJobPayload = {
  objects: CapturedMoveCleanupObject[];
  reason: string;
  /** Exhausted deletion work remains a physical ownership record. */
  retain_exhausted: true;
};
