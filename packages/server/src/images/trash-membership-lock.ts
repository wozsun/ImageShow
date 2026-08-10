import type { PoolClient } from "pg";
import { withAdvisoryLock } from "../core/database-advisory-locks.ts";

const trashMembershipLockKey = "imageshow:trash-membership";

export async function lockTrashMembershipForTransaction(client: PoolClient) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    [trashMembershipLockKey]
  );
}

export function withTrashMembershipLock<T>(
  work: (client: PoolClient) => Promise<T>
) {
  return withAdvisoryLock(
    trashMembershipLockKey,
    (_signal, client) => work(client)
  );
}
