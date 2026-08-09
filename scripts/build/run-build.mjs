import { resolve } from "node:path";
import { cleanBuildOutput } from "./clean-build-output.mjs";
import {
  forceTerminateProcessTree,
  releaseFailedProcessTree,
  signalProcessTree,
  spawnManaged
} from "./process-tree.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const windows = process.platform === "win32";
const npmCommand = windows ? (process.env.ComSpec || "cmd.exe") : "npm";
const children = new Map();
let interruptedExitCode = 0;
let interruptFailed = false;

function signalChildren(signal) {
  for (const [child, state] of children) {
    state.cancelFallback = signalProcessTree(
      child,
      signal,
      10_000,
      () => { interruptFailed = true; },
      (error) => state.failForcedShutdown(error)
    );
  }
}

async function forceStopChildren() {
  const active = [...children.keys()];
  const results = await Promise.allSettled(active.map(forceTerminateProcessTree));
  const errors = [];
  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    if (interruptedExitCode) interruptFailed = true;
    releaseFailedProcessTree(active[index]);
    children.get(active[index])?.cancelFallback?.();
    children.delete(active[index]);
    errors.push(result.reason);
  });
  if (errors.length > 0) {
    throw new AggregateError(errors, "build process trees did not terminate");
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (interruptedExitCode) return;
    interruptedExitCode = signal === "SIGINT" ? 130 : 143;
    signalChildren(signal);
  });
}

function ensureNotInterrupted() {
  if (interruptedExitCode) {
    throw new Error(`build interrupted with exit code ${interruptedExitCode}`);
  }
}

function runNpm(label, args) {
  return new Promise((resolveCommand, rejectCommand) => {
    const commandArguments = windows
      ? ["/d", "/s", "/c", "npm", ...args]
      : args;
    const child = spawnManaged(npmCommand, commandArguments, {
      cwd: workspaceRoot,
      stdio: "inherit",
      windowsHide: true
    });
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const state = {
      cancelFallback: null,
      failForcedShutdown(error) {
        interruptFailed = true;
        releaseFailedProcessTree(child);
        state.cancelFallback?.();
        children.delete(child);
        finish(() => rejectCommand(new AggregateError(
          [error],
          `${label} process tree did not terminate after forced fallback`
        )));
      }
    };
    children.set(child, state);
    child.once("error", (error) => {
      children.get(child)?.cancelFallback?.();
      children.delete(child);
      finish(() => rejectCommand(error));
    });
    child.once("close", (code, signal) => {
      children.get(child)?.cancelFallback?.();
      children.delete(child);
      if (code === 0) {
        finish(resolveCommand);
        return;
      }
      finish(() => rejectCommand(new Error(
        `${label} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`
      )));
    });
  });
}

async function main() {
  await cleanBuildOutput();
  ensureNotInterrupted();
  await runNpm("shared build", [
    "run", "build", "--workspace", "@imageshow/shared"
  ]);
  ensureNotInterrupted();

  const builds = [
    runNpm("web build", ["run", "build", "--workspace", "@imageshow/web"]),
    runNpm("server build", ["run", "build", "--workspace", "@imageshow/server"])
  ];
  try {
    await Promise.all(builds);
  } catch (error) {
    await forceStopChildren();
    await Promise.allSettled(builds);
    throw error;
  }
  ensureNotInterrupted();

  await runNpm("server asset assembly", [
    "run", "assemble", "--workspace", "@imageshow/server"
  ]);
}

try {
  await main();
} catch (error) {
  if (interruptedExitCode) {
    process.exitCode = interruptFailed ? 1 : interruptedExitCode;
  } else {
    throw error;
  }
}
