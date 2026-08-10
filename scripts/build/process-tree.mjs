import { spawn, spawnSync } from "node:child_process";

const windows = process.platform === "win32";
const closedProcesses = new WeakSet();

export function spawnManaged(command, arguments_, options) {
  const child = spawn(command, arguments_, {
    ...options,
    // A detached Windows child owns a separate console and can surface a
    // black window even when its direct process was requested hidden. taskkill
    // /T already terminates the exact descendant tree, so only POSIX needs a
    // detached process group for negative-PID signalling.
    detached: windows ? false : (options?.detached ?? true),
    windowsHide: options?.windowsHide ?? windows
  });
  child.once("close", () => closedProcesses.add(child));
  return child;
}

function killPosixGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function processHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForProcessClose(child, timeoutMs) {
  if (closedProcesses.has(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.off("close", onClose);
      resolveExit(closedProcesses.has(child));
    }, timeoutMs);
    timeout.unref();
    const onClose = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once("close", onClose);
  });
}

export function signalProcessTree(
  child,
  signal,
  forceAfterMs = 10_000,
  onForcedFallback = () => undefined,
  onForcedFallbackFailure = () => undefined
) {
  if (!windows) killPosixGroup(child, signal);
  // Windows sends terminal Ctrl+C/Ctrl+Break to the attached console tree.
  // Keep the parent alive while resource owners clean up, then force the exact
  // child tree if it did not converge. POSIX gets the same bounded fallback.
  const fallback = setTimeout(() => {
    onForcedFallback();
    void forceTerminateProcessTree(child).catch((error) => {
      console.error(`process-tree: failed to terminate ${child.pid}:`, error);
      onForcedFallbackFailure(error);
    });
  }, forceAfterMs);
  fallback.unref();
  return () => clearTimeout(fallback);
}

export function releaseFailedProcessTree(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (child.connected) {
    try {
      child.disconnect();
    } catch {
      // The channel may close between the connected check and disconnect.
    }
  }
  child.unref();
}

export async function forceTerminateProcessTree(child) {
  if (!child.pid || closedProcesses.has(child)) return;
  if (!windows) {
    killPosixGroup(child, "SIGKILL");
    if (!await waitForProcessClose(child, 5_000)) {
      throw new Error(`process group ${child.pid} did not exit after SIGKILL`);
    }
    return;
  }
  if (processHasExited(child)) {
    if (!await waitForProcessClose(child, 5_000)) {
      throw new Error(`process ${child.pid} exited but its stdio did not close`);
    }
    return;
  }
  const killed = spawnSync("taskkill", [
    "/pid", String(child.pid), "/t", "/f"
  ], {
    windowsHide: true,
    timeout: 5_000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8"
  });
  const closed = await waitForProcessClose(child, 5_000);
  if (closed) return;
  const reason = killed.error?.message
    || killed.stderr?.trim()
    || `taskkill exited with ${killed.status ?? "no status"}`;
  throw new Error(
    `taskkill could not terminate process tree ${child.pid}: ${reason}`
  );
}
