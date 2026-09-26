import { pool } from "../../core/database/pools.ts";
import { ApiError } from "../../core/api-error.ts";
import { latestPreparationRun } from "./repository.ts";

export async function exportPreparationRecords(signal: AbortSignal) {
  const run = await latestPreparationRun();
  if (!run) throw new ApiError(404, "preparation_missing", "尚无预生成任务");
  let cursor: string | null = null;
  let first = true;
  let cancelled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      signal.throwIfAborted();
      if (first) { controller.enqueue(encoder.encode(`${JSON.stringify({ run })}\n`)); first = false; return; }
      const result = await pool.query(
        "SELECT * FROM image_variant_preparation WHERE run_id=$1 AND ($2::uuid IS NULL OR image_id>$2) ORDER BY image_id LIMIT 100", [run.id, cursor]
      );
      if (cancelled) return;
      signal.throwIfAborted();
      for (const row of result.rows) controller.enqueue(encoder.encode(`${JSON.stringify(row)}\n`));
      cursor = result.rows.at(-1)?.image_id ?? cursor;
      if (result.rows.length < 100) controller.close();
    },
    cancel() { cancelled = true; }
  });
  return { stream, filename: `normalize-preparation-${run.id}.jsonl` };
}
