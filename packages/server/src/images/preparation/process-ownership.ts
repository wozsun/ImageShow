import { readFile, stat } from "node:fs/promises";
import { connectAdvisoryLockClient } from "../../core/database/pools.ts";
import type { ProcessIdentity } from "./model.ts";

export async function processIdentity(pid = process.pid): Promise<ProcessIdentity> {
  const [processStat, boot, namespace] = await Promise.all([
    readFile(`/proc/${pid}/stat`, "utf8"),
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    stat("/proc/self/ns/pid", { bigint: true })
  ]);
  // comm may contain spaces and parentheses; fields after the final ')' start at field 3.
  const start = processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19]!;
  return { pid, start, boot: boot.trim(), namespace: String(namespace.ino) };
}

export async function previousProcessExited(identity: ProcessIdentity) {
  const current = await processIdentity();
  if (current.boot !== identity.boot) return true;
  // Managed single-container restart destroys its former PID namespace and descendants.
  // Cross-host/multi-container takeover is outside this deployment contract.
  if (current.namespace !== identity.namespace) return true;
  try { return (await processIdentity(identity.pid)).start !== identity.start; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}

/** The HTTP service and offline CLI are mutually exclusive execution hosts. */
export async function acquireApplicationHost() {
  const client = await connectAdvisoryLockClient();
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended('imageshow:application-host',0)) AS acquired");
    if (!result.rows[0]?.acquired) throw new Error("主服务或离线执行进程仍在运行；请先停止并等待退出");
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
