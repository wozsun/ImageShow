import { fork } from "node:child_process";
import type { PreparationChildCommand, PreparationChildReply } from "./child-protocol.ts";

type ChildRequest = PreparationChildCommand extends infer T ? T extends { id: number } ? Omit<T, "id"> : never : never;

export async function startPreparationChild(signal: AbortSignal) {
  const child = fork(new URL(import.meta.url.endsWith(".ts") ? "./child.ts" : "./child.js", import.meta.url), [], {
    env: { ...process.env, UV_THREADPOOL_SIZE: "1" },
    execArgv: [], windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json"
  });
  let sequence = 0;
  let killTimer: NodeJS.Timeout | undefined;
  let exited = false;
  const waiting = new Map<number, { resolve(value: PreparationChildReply): void; reject(error: unknown): void }>();
  const ready = Promise.withResolvers<PreparationChildReply>();
  const exit = Promise.withResolvers<void>();
  const fail = (error: unknown) => {
    ready.reject(error);
    for (const request of waiting.values()) request.reject(error);
    waiting.clear();
  };
  child.on("message", (reply: PreparationChildReply) => {
    if (reply.id === 0) { ready.resolve(reply); return; }
    const request = waiting.get(reply.id);
    if (!request) return;
    waiting.delete(reply.id);
    if (reply.error) request.reject(Object.assign(new Error(reply.error), { code: reply.code }));
    else request.resolve(reply);
  });
  child.once("error", fail);
  child.once("close", () => {
    exited = true;
    if (killTimer) clearTimeout(killTimer);
    signal.removeEventListener("abort", cancel);
    fail(new Error("预生成子进程已退出"));
    exit.resolve();
  });
  const cancel = () => {
    if (exited) return;
    if (child.connected) child.send({ id: -1, action: "cancel" }, () => undefined);
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), 30_000);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const startupDeadline = setTimeout(() => { fail(new Error("子进程启动超时")); child.kill("SIGKILL"); }, 15_000);
  let identity;
  try { identity = (await ready.promise).identity!; }
  catch (error) { child.kill("SIGKILL"); await exit.promise; throw error; }
  finally { clearTimeout(startupDeadline); }
  return {
    identity,
    async request(command: ChildRequest, timeoutMs = 300_000) {
      signal.throwIfAborted();
      if (exited || !child.connected) throw new Error("预生成子进程不可用");
      const id = ++sequence;
      const promise = new Promise<PreparationChildReply>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        child.send({ ...command, id }, (error) => { if (error) { waiting.delete(id); reject(error); } });
      });
      const timer = setTimeout(() => { fail(new Error("图片操作超过执行时限")); child.kill("SIGKILL"); }, timeoutMs);
      try { return await promise; } finally { clearTimeout(timer); }
    },
    async close() {
      if (!exited && child.connected && !signal.aborted) {
        const id = ++sequence;
        child.send({ id, action: "close" }, () => undefined);
      } else cancel();
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 30_000);
      await exit.promise;
      if (killTimer) clearTimeout(killTimer);
    }
  };
}
