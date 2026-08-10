import type { PoolClient } from "pg";
import { pool } from "./database-pools.ts";

export async function withTransactionOnClient<T>(
  client: PoolClient,
  work: (client: PoolClient) => Promise<T>,
  options: { onTransactionId?: (transactionId: string) => void } = {}
): Promise<T> {
  try {
    await client.query("BEGIN");
    if (options.onTransactionId) {
      const transactionId = String((await client.query(
        "SELECT pg_current_xact_id()::text AS transaction_id"
      )).rows[0]?.transaction_id ?? "");
      if (!transactionId) {
        throw new Error("PostgreSQL did not assign a transaction ID");
      }
      options.onTransactionId(transactionId);
    }
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export type TransactionOutcome = "committed" | "rolled_back" | "unknown";

/** Inspect the immutable outcome of one PostgreSQL transaction receipt. */
export async function inspectTransactionOutcome(
  transactionId: string
): Promise<TransactionOutcome> {
  const status = (await pool.query(
    "SELECT pg_xact_status($1::xid8) AS status",
    [transactionId]
  )).rows[0]?.status;
  if (status === "committed") return "committed";
  if (status === "aborted") return "rolled_back";
  return "unknown";
}

export async function withTransaction<T>(
  work: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    return await withTransactionOnClient(client, work);
  } finally {
    client.release();
  }
}
