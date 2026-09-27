import { connectAdvisoryLockClient } from "./pools.ts";

/** One application host owns startup initialization and runtime workers. */
export async function acquireApplicationHost() {
  const client = await connectAdvisoryLockClient();
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended('imageshow:application-host',0)) AS acquired");
    if (!result.rows[0]?.acquired) throw new Error("另一个应用实例仍在运行；请先停止并等待退出");
    const controller = new AbortController();
    const lost = () => controller.abort(new Error("执行宿主锁连接已失效"));
    client.on("error", lost);
    client.on("end", lost);
    return {
      signal: controller.signal,
      async close() {
        client.off("error", lost);
        client.off("end", lost);
        try { await client.query("SELECT pg_advisory_unlock(hashtextextended('imageshow:application-host',0))"); }
        finally { client.release(); }
      }
    };
  } catch (error) { client.release(); throw error; }
}
