import { resolve } from "node:path";
import {
  releaseFailedProcessTree,
  signalProcessTree,
  spawnManaged
} from "../build/process-tree.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const windows = process.platform === "win32";
const children = new Map();
let interruptedExitCode = 0;
let interruptedSignal = "";

class CommandFailure extends Error {
  constructor(message, {
    cause,
    childSignal = null,
    cooperativeShutdown = false,
    exitCode,
    forcedShutdown = false
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.childSignal = childSignal;
    this.cooperativeShutdown = cooperativeShutdown;
    this.exitCode = exitCode;
    this.forcedShutdown = forcedShutdown;
  }
}

const phases = {
  source: [
    ["workspace types", "npm", ["run", "check"]],
    ["dead code", "npm", ["run", "knip"]],
    ["semantic colors", "npm", ["run", "check:colors"]],
    ["generated icons", "npm", ["run", "icons:check"]],
    ["dependency and config contract", "node", ["scripts/verify/source-contract.mjs"]],
    ["version contract", "node", ["scripts/verify/version-contract.mjs"]],
    ["Markdown links", "node", ["scripts/verify/markdown-links.mjs"]],
    ["CSS selector inventory", "node", ["scripts/verify/selector-inventory.mjs"]]
  ],
  build: [
    ["production build", "npm", ["run", "build"]],
    ["Web build contract", "npm", ["run", "check:build", "-w", "@imageshow/web"]]
  ],
  runtime: [
    [
      "baseline and server acceptance",
      "node",
      [
        "--env-file-if-exists=.env", "--test", "--test-isolation=none",
        "tests/final-baseline.test.ts", "tests/final-server.test.ts"
      ],
      { cooperativeShutdown: true }
    ],
    [
      "Web acceptance",
      "npm",
      ["run", "test:final:web"]
    ],
    [
      "isolated production image",
      "node",
      ["scripts/verify/runtime-image.mjs"],
      { cooperativeShutdown: true }
    ]
  ]
};

function stopChildren(signal) {
  if (interruptedExitCode) return;
  interruptedExitCode = signal === "SIGINT" ? 130 : 143;
  interruptedSignal = signal;
  for (const [child, state] of children) {
    if (state.cooperativeShutdown && child.connected) {
      try {
        child.send({ type: "imageshow:shutdown", signal }, (error) => {
          if (error && child.exitCode === null && child.signalCode === null) {
            console.error(`[verify] failed to request child cleanup for ${child.pid}:`, error);
          }
        });
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) {
          console.error(`[verify] failed to request child cleanup for ${child.pid}:`, error);
        }
      }
    }
    state.cancelFallback = signalProcessTree(
      child,
      signal,
      state.cooperativeShutdown ? 5 * 60_000 : 10_000,
      () => { state.forcedShutdown = true; },
      (error) => state.failForcedShutdown(error)
    );
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stopChildren(signal));
}

function runCommand(
  label,
  command,
  arguments_,
  { cooperativeShutdown = false } = {}
) {
  return new Promise((resolveCommand, rejectCommand) => {
    console.log(`\n[verify] ${label}`);
    const executable = windows && (command === "npm" || command === "npx")
      ? (process.env.ComSpec || "cmd.exe")
      : command;
    const commandArguments = executable === command
      ? arguments_
      : ["/d", "/s", "/c", command, ...arguments_];
    const child = spawnManaged(executable, commandArguments, {
      cwd: workspaceRoot,
      stdio: cooperativeShutdown
        ? ["inherit", "inherit", "inherit", "ipc"]
        : "inherit",
      windowsHide: true
    });
    let settled = false;
    const finish = (callback) => {
      if (settled) return false;
      settled = true;
      callback();
      return true;
    };
    const state = {
      cancelFallback: null,
      cooperativeShutdown,
      forcedShutdown: false,
      failForcedShutdown(error) {
        releaseFailedProcessTree(child);
        state.cancelFallback?.();
        children.delete(child);
        finish(() => rejectCommand(new CommandFailure(
          `${label} process tree did not terminate after forced fallback`,
          {
            cause: error,
            cooperativeShutdown,
            forcedShutdown: true
          }
        )));
      }
    };
    children.set(child, state);
    child.once("error", (error) => {
      const currentState = children.get(child);
      currentState?.cancelFallback?.();
      children.delete(child);
      finish(() => rejectCommand(new CommandFailure(`${label} could not start`, {
        cause: error,
        cooperativeShutdown,
        forcedShutdown: currentState?.forcedShutdown ?? false
      })));
    });
    child.once("close", (code, signal) => {
      const currentState = children.get(child);
      currentState?.cancelFallback?.();
      children.delete(child);
      if (code === 0 && !currentState?.forcedShutdown) {
        finish(resolveCommand);
        return;
      }
      finish(() => rejectCommand(new CommandFailure(
        currentState?.forcedShutdown
          ? `${label} exceeded its shutdown deadline and required forced termination`
          : `${label} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`,
        {
          childSignal: signal,
          cooperativeShutdown,
          exitCode: code,
          forcedShutdown: currentState?.forcedShutdown ?? false
        }
      )));
    });
  });
}

const mode = process.argv[2];
if (!mode || !["source", "build", "runtime", "release"].includes(mode)) {
  throw new Error("Usage: node scripts/verify/run.mjs <source|build|runtime|release>");
}
if (process.argv.length > 3) throw new Error("verify: unexpected arguments");

const selectedPhases = mode === "release"
  ? ["source", "build", "runtime"]
  : [mode];
try {
  for (const phase of selectedPhases) {
    for (const [label, command, arguments_, options] of phases[phase]) {
      if (interruptedExitCode) break;
      await runCommand(label, command, arguments_, options);
    }
    if (interruptedExitCode) break;
  }

  if (interruptedExitCode) {
    process.exitCode = interruptedExitCode;
  } else {
    console.log(`\n[verify] ${mode} passed`);
  }
} catch (error) {
  if (interruptedExitCode) {
    const normalCooperativeExit = error instanceof CommandFailure
      && error.cooperativeShutdown
      && !error.forcedShutdown
      && (
        error.exitCode === interruptedExitCode
        || error.childSignal === interruptedSignal
      );
    const normalSimpleInterrupt = error instanceof CommandFailure
      && !error.cooperativeShutdown
      && !error.forcedShutdown
      && (error.exitCode !== undefined || error.childSignal !== null);
    if (normalCooperativeExit || normalSimpleInterrupt) {
      process.exitCode = interruptedExitCode;
    } else {
      console.error("[verify] interrupted child did not cleanly converge:", error);
      process.exitCode = 1;
    }
  } else {
    throw error;
  }
}
