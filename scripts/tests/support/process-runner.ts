import type {
  ChildProcess,
  SpawnOptions
} from "node:child_process";
import {
  forceTerminateProcessTree,
  releaseFailedProcessTree,
  spawnManaged
} from "../../build/process-tree.mjs";
import {
  cleanupTestDirectories,
  sealTestDirectoryRegistrationForInterruption
} from "./test-directory.ts";

export type ProcessResult = {
  code: number;
  stderr: string;
  stdout: string;
};

export type ProcessRunOptions = {
  allowFailure?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onSpawn?: (pid: number) => void;
  timeoutMs?: number;
};

export type ProcessRunnerOptions = {
  handleProcessInterruption?: boolean;
};

export function createProcessRunner(options: ProcessRunnerOptions = {}) {
  const activeProcesses = new Set<ChildProcess>();
  let interruption: "SIGINT" | "SIGTERM" | null = null;
  let interruptionHandlersInstalled = false;

  const uninstallInterruptionHandlers = () => {
    if (!interruptionHandlersInstalled) return;
    interruptionHandlersInstalled = false;
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    process.off("message", onShutdownMessage);
    if (process.listenerCount("message") === 0) process.channel?.unref();
  };

  const handleInterruption = (signal: "SIGINT" | "SIGTERM") => {
    if (interruption) return;
    interruption = signal;
    // No test callback may acquire a new directory after the cleanup snapshot.
    sealTestDirectoryRegistrationForInterruption();
    void (async () => {
      const errors: unknown[] = [];
      try {
        await terminateActiveProcesses();
      } catch (error) {
        errors.push(error);
      }
      try {
        await cleanupTestDirectories();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "测试共享资源中断清理失败");
      }
    })().then(
      () => process.exit(signal === "SIGINT" ? 130 : 143),
      (error) => {
        console.error("测试共享资源中断清理失败:", error);
        process.exit(1);
      }
    );
  };

  const onSigInt = () => handleInterruption("SIGINT");
  const onSigTerm = () => handleInterruption("SIGTERM");
  const onShutdownMessage = (message: unknown) => {
    if (
      typeof message === "object"
      && message !== null
      && "type" in message
      && message.type === "imageshow:shutdown"
      && "signal" in message
      && (message.signal === "SIGINT" || message.signal === "SIGTERM")
    ) {
      handleInterruption(message.signal);
    }
  };

  const installInterruptionHandlers = () => {
    if (!options.handleProcessInterruption || interruptionHandlersInstalled) return;
    interruptionHandlersInstalled = true;
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
    process.on("message", onShutdownMessage);
    // The IPC channel is only a cooperative shutdown path. It must not keep an
    // otherwise completed test process alive while the owner remains installed.
    process.channel?.unref();
  };

  const releaseActiveProcess = (child: ChildProcess) => {
    activeProcesses.delete(child);
  };

  const spawnProcess = (command: string, args: string[], spawnOptions?: SpawnOptions) => {
    if (interruption) throw new Error(`${command} refused after ${interruption}`);
    const child = spawnManaged(command, args, spawnOptions);
    activeProcesses.add(child);
    installInterruptionHandlers();
    child.once("close", () => releaseActiveProcess(child));
    return child;
  };

  const terminateProcess = async (child: ChildProcess) => {
    if (!child.connected || child.exitCode !== null || child.signalCode !== null) {
      await forceTerminateProcessTree(child);
      return;
    }
    // IPC helpers are resource owners too. Let them close their own detached
    // children and directories before falling back to terminating their tree.
    await new Promise<void>((resolveTermination, rejectTermination) => {
      let settled = false;
      let forcing = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("close", onClose);
        if (error) rejectTermination(error);
        else resolveTermination();
      };
      const onClose = (code: number | null) => {
        const interruptedCode = interruption === "SIGINT" ? 130 : 143;
        finish(!forcing && code !== 0 && code !== interruptedCode
          ? new Error(`IPC helper ${child.pid} exited with ${code} during cleanup`)
          : undefined);
      };
      const force = () => {
        if (settled || forcing) return;
        forcing = true;
        void forceTerminateProcessTree(child).then(() => finish(), finish);
      };
      const timeout = setTimeout(force, 5_000);
      child.once("close", onClose);
      try {
        child.send({ type: "imageshow:shutdown", signal: interruption ?? "SIGTERM" }, (error) => {
          if (error) force();
        });
      } catch {
        force();
      }
    });
  };

  const terminateActiveProcesses = async () => {
    const processes = [...activeProcesses];
    const results = await Promise.allSettled(
      processes.map(terminateProcess)
    );
    const errors = results.flatMap((result) => (
      result.status === "rejected" ? [result.reason] : []
    ));
    results.forEach((result, index) => {
      activeProcesses.delete(processes[index]!);
      if (result.status === "rejected") {
        releaseFailedProcessTree(processes[index]!);
      }
    });
    if (errors.length > 0) {
      throw new AggregateError(errors, "测试子进程树未能全部退出");
    }
  };

  const runProcess = (
    command: string,
    args: string[],
    options: ProcessRunOptions = {}
  ): Promise<ProcessResult> => new Promise((resolveProcess, rejectProcess) => {
    const child = spawnProcess(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeoutMs = options.timeoutMs ?? 60_000;
    const timeout = setTimeout(() => {
      timedOut = true;
      void forceTerminateProcessTree(child).then(
        () => finish(() => rejectProcess(new Error(
          `${command} exceeded ${timeoutMs} ms: ${stderr || stdout}`
        ))),
        (error) => {
          releaseFailedProcessTree(child);
          releaseActiveProcess(child);
          finish(() => rejectProcess(new AggregateError(
            [error],
            `${command} exceeded ${timeoutMs} ms and did not terminate`
          )));
        }
      );
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", (error: Error) => {
      releaseActiveProcess(child);
      finish(() => rejectProcess(error));
    });
    child.on("close", (code: number | null) => {
      finish(() => {
        const exitCode = code ?? -1;
        if (timedOut) {
          rejectProcess(new Error(
            `${command} exceeded ${timeoutMs} ms: ${stderr || stdout}`
          ));
          return;
        }
        if (exitCode !== 0 && !options.allowFailure) {
          rejectProcess(new Error(
            `${command} exited with ${exitCode}: ${stderr || stdout}`
          ));
          return;
        }
        resolveProcess({ code: exitCode, stdout, stderr });
      });
    });
    try {
      if (!child.pid) throw new Error(`${command} did not expose a child PID`);
      options.onSpawn?.(child.pid);
    } catch (error) {
      void forceTerminateProcessTree(child).then(
        () => {
          releaseActiveProcess(child);
          finish(() => rejectProcess(error));
        },
        (terminationError) => {
          releaseFailedProcessTree(child);
          releaseActiveProcess(child);
          finish(() => rejectProcess(new AggregateError(
            [error, terminationError],
            `${command} spawn callback failed and its process tree did not terminate`
          )));
        }
      );
    }
  });

  // The suite owns registered temporary directories even between helper
  // processes, so interruption handling spans the complete module lifetime.
  installInterruptionHandlers();

  return {
    installInterruptionHandlers,
    runProcess,
    spawnProcess,
    terminateActiveProcesses,
    uninstallInterruptionHandlers
  };
}

const sharedProcessRunner = createProcessRunner({ handleProcessInterruption: true });
export const runProcess = sharedProcessRunner.runProcess;
export const spawnSharedTestProcess = sharedProcessRunner.spawnProcess;
export const terminateSharedTestProcesses = sharedProcessRunner.terminateActiveProcesses;
export function suspendSharedTestInterruptionHandling() {
  sharedProcessRunner.uninstallInterruptionHandlers();
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    sharedProcessRunner.installInterruptionHandlers();
  };
}
