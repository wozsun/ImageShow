import type { ReadablePrefix } from "../objects/keys.ts";

export type MoveCleanupObjectInput = {
  prefix: ReadablePrefix;
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
  /** Do not treat absence as terminal before a possibly late write settles. */
  confirm_absent_after?: string;
  /** Unique ownership of a pre-copy Ingestion commit guard attempt. */
  guard_token?: string;
  /** Exhausted deletion work remains a physical ownership record. */
  retain_exhausted: true;
};
