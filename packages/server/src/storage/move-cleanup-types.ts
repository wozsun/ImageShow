import type { StoragePrefix } from "./object-keys.ts";

export type MoveCleanupObjectInput = {
  prefix: StoragePrefix;
  key: string;
  backend: string;
  /**
   * A failed thumbnail repair may own the currently referenced deterministic
   * key. The worker adopts an exact candidate or removes a mismatched one.
   */
  thumbnail_repair?: {
    expected_sha256: string;
    expected_size: number;
  };
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
  /**
   * A write-ahead repair receipt keeps the exact retry bytes only while the
   * job is unresolved. The worker strips this field on successful settlement.
   */
  thumbnail_repair_body_base64?: string;
};
