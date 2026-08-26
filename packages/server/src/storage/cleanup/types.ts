import type { StoragePrefix } from "../objects/keys.ts";

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
  /** Unique ownership of a pre-copy import guard attempt. */
  guard_token?: string;
  /** Exhausted deletion work remains a physical ownership record. */
  retain_exhausted: true;
};
