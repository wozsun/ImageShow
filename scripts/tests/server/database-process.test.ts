import "../support/server-environment.ts";
import assert from "node:assert/strict";
import {
  spawnSync,
  type ChildProcess
} from "node:child_process";
import {
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import {
  resolve
} from "node:path";
import {
  setTimeout as delay
} from "node:timers/promises";
import test from "node:test";
import {
  pathToFileURL
} from "node:url";
import {
  appConfig
} from "../../../packages/shared/src/app-config.ts";
import {
  withRuntimeConfigWriteLease
} from "../../../packages/server/src/config/runtime-config-store.ts";
import {
  ApiError
} from "../../../packages/server/src/core/api-error.ts";
import {
  raceWithAbortSignal
} from "../../../packages/server/src/core/abort.ts";
import {
  acquireAdvisoryLockClient
} from "../../../packages/server/src/core/database/advisory-locks.ts";
import {
  createPublicDatabaseAdmission
} from "../../../packages/server/src/core/database/public-admission.ts";
import {
  createPublicDatabaseReadScope
} from "../../../packages/server/src/core/database/public-fallback.ts";
import {
  withTransactionOnClient
} from "../../../packages/server/src/core/database/transactions.ts";
import {
  WorkerExecutionCoordinator,
  type WorkerExecutionCompletion
} from "../../../packages/server/src/jobs/worker-execution.ts";
import {
  backgroundJobTypes,
  parseBackgroundJobType
} from "../../../packages/server/src/jobs/types.ts";
import {
  forceTerminateProcessTree
} from "../../build/process-tree.mjs";
import {
  spawnSharedTestProcess
} from "../support/process-runner.ts";
import {
  createTestDirectory
} from "../support/test-directory.ts";
import {
  completeVerificationEnvironment,
  scenarioSelectorEnvironmentVariables
} from "../support/verification-environment.ts";

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessId(path: string, maximumAttempts = 250) {
  let lastContent = "";
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    try {
      lastContent = (await readFile(path, "utf8")).trim();
      const pid = Number(lastContent);
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(20);
  }
  throw new Error(
    `helper 未在期限内原子发布有效子进程 PID${lastContent ? `：${lastContent}` : ""}`
  );
}

async function waitForProcessExit(pid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processIsRunning(pid)) return;
    await delay(20);
  }
  throw new Error(`子进程 ${pid} 未在期限内退出`);
}

async function forceTerminatePidTree(pid: number) {
  if (!processIsRunning(pid)) return;
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      encoding: "utf8"
    });
    if (result.status !== 0 && processIsRunning(pid)) {
      throw new Error(result.stderr.trim() || `taskkill 无法终止测试子进程 ${pid}`);
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  await waitForProcessExit(pid);
}

function waitForChildClose(child: ChildProcess, stderr: () => string) {
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose, rejectClose) => {
    const timeout = setTimeout(() => {
      rejectClose(new Error(`中断后测试 owner 未退出：${stderr()}`));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectClose(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveClose({ code, signal });
    });
  });
  // Readiness can fail before the caller reaches its close assertion.
  void closed.catch(() => undefined);
  return closed;
}

async function cleanupInterruptionFixture(options: {
  childPid?: number;
  childPidPath?: string;
  helper?: ChildProcess;
  root: string;
}) {
  const errors: unknown[] = [];
  let childPid = options.childPid;
  if (!childPid && options.helper && options.childPidPath) {
    try {
      childPid = await waitForProcessId(options.childPidPath);
    } catch (error) {
      errors.push(error);
    }
  }
  if (options.helper) {
    try {
      await forceTerminateProcessTree(options.helper);
    } catch (error) {
      errors.push(error);
    }
  }
  if (childPid) {
    try {
      await forceTerminatePidTree(childPid);
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await rm(options.root, { recursive: true, force: true });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "中断回归资源未能全部清理");
  }
}

test("[Server/数据库与进程] 单进程配置写租约覆盖嵌套调用和长 I/O", async () => {
  const order: string[] = [];
  let releaseLongIo: () => void = () => undefined;
  let markLongIoStarted: () => void = () => undefined;
  const longIoGate = new Promise<void>((resolve) => {
    releaseLongIo = resolve;
  });
  const longIoStarted = new Promise<void>((resolve) => {
    markLongIoStarted = resolve;
  });
  const first = withRuntimeConfigWriteLease(async () => {
    order.push("first:start");
    markLongIoStarted();
    await longIoGate;
    await withRuntimeConfigWriteLease(() => {
      order.push("first:nested");
    });
    order.push("first:end");
  });
  await longIoStarted;
  const second = withRuntimeConfigWriteLease(() => {
    order.push("second");
  });
  await delay(10);
  assert.deepEqual(order, ["first:start"]);
  releaseLongIo();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "first:start",
    "first:nested",
    "first:end",
    "second"
  ]);
});
test("[Server/数据库与进程] 共享 abort race 保留调用方 reason 并收口迟到 operation", async () => {
  const completed = await raceWithAbortSignal(
    new AbortController().signal,
    Promise.resolve("completed")
  );
  assert.equal(completed, "completed");

  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  let rejectOperation: (error: Error) => void = () => undefined;
  const operation = new Promise<never>((_resolve, reject) => {
    rejectOperation = reject;
  });
  const raced = raceWithAbortSignal(controller.signal, operation);
  controller.abort(reason);
  await assert.rejects(raced, (error) => error === reason);
  rejectOperation(new Error("late operation failure"));
  await delay(0);
});
test("[Server/数据库与进程] 完整门禁环境不会继承定向场景选择器", () => {
  const sourceEnvironment: NodeJS.ProcessEnv = {
    IMAGESHOW_DATABASE_SCENARIO: "cold-redis",
    IMAGESHOW_STORAGE_INGESTION_SCENARIO: "commit-success",
    IMAGESHOW_WEB_QUEUE_SCENARIO: "handoff-completion",
    IMAGESHOW_UNRELATED_TEST_VALUE: "preserved"
  };
  const completeEnvironment = completeVerificationEnvironment(sourceEnvironment);
  assert.equal(completeEnvironment.IMAGESHOW_UNRELATED_TEST_VALUE, "preserved");
  for (const variable of scenarioSelectorEnvironmentVariables) {
    assert.equal(completeEnvironment[variable], undefined);
    assert.equal(sourceEnvironment[variable] === undefined, false);
  }
});
for (const mode of ["runProcess", "IPC owner"] as const) {
  test(`[Server/数据库与进程] 共享 owner 中断清理 ${mode} 与临时目录`, {
    timeout: 15_000
  }, async () => {
    const root = await createTestDirectory("shared-process-interruption-");
    const helperPath = resolve(root, "owner.mts");
    const childPidPath = resolve(root, "child.pid");
    const ownedDirectory = resolve(root, "owned-directory");
    const processRunnerUrl = pathToFileURL(resolve(
      import.meta.dirname,
      "../support/process-runner.ts"
    )).href;
    const testDirectoryUrl = pathToFileURL(resolve(
      import.meta.dirname,
      "../support/test-directory.ts"
    )).href;
    const childSource = "setInterval(() => undefined, 1_000);";
    const publishPidSource = [
      'const temporaryPath = process.argv[2] + ".tmp";',
      'writeFileSync(temporaryPath, String(pid));',
      "renameSync(temporaryPath, process.argv[2]);"
    ].join("\n");
    const ipcChildPath = resolve(root, "ipc-child.mts");
    const helperSource = [
      'import { mkdirSync, renameSync, writeFileSync } from "node:fs";',
      `import { runProcess, spawnSharedTestProcess } from ${JSON.stringify(processRunnerUrl)};`,
      `import { registerTestDirectory } from ${JSON.stringify(testDirectoryUrl)};`,
      ...(mode === "runProcess" ? [
        "mkdirSync(process.argv[3], { recursive: true });",
        "registerTestDirectory(process.argv[3]);",
        "void runProcess(process.execPath, [",
        `  "-e", ${JSON.stringify(childSource)}`,
        "], {",
        "  allowFailure: true,",
        "  timeoutMs: 60_000,",
        "  onSpawn(pid) {",
        publishPidSource,
        "  }",
        "}).catch(() => undefined);"
      ] : [
        "spawnSharedTestProcess(process.execPath, [",
        `  ${JSON.stringify(ipcChildPath)}, process.argv[2], process.argv[3]`,
        '], { stdio: ["ignore", "ignore", "inherit", "ipc"], windowsHide: true });'
      ]),
      "await new Promise(() => undefined);"
    ].join("\n");
    let helper: ChildProcess | undefined;
    let childPid: number | undefined;
    let helperStderr = "";
    try {
      if (mode === "IPC owner") {
        await writeFile(ipcChildPath, [
          'import { mkdirSync, renameSync, writeFileSync } from "node:fs";',
          `import ${JSON.stringify(processRunnerUrl)};`,
          `import { registerTestDirectory } from ${JSON.stringify(testDirectoryUrl)};`,
          "mkdirSync(process.argv[3], { recursive: true });",
          "registerTestDirectory(process.argv[3]);",
          "const pid = process.pid;",
          publishPidSource,
          childSource
        ].join("\n"));
      }
      await writeFile(helperPath, helperSource);
      helper = spawnSharedTestProcess(process.execPath, [
        "--experimental-strip-types",
        helperPath,
        childPidPath,
        ownedDirectory
      ], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        windowsHide: true
      });
      helper.stderr?.on("data", (chunk: Buffer | string) => {
        helperStderr += String(chunk);
      });
      const closed = waitForChildClose(helper, () => helperStderr);
      childPid = await waitForProcessId(childPidPath);
      await stat(ownedDirectory);
      assert.equal(processIsRunning(childPid), true);
      await new Promise<void>((resolveSend, rejectSend) => {
        helper!.send({ type: "imageshow:shutdown", signal: "SIGTERM" }, (error) => {
          if (error) rejectSend(error);
          else resolveSend();
        });
      });
      assert.deepEqual(await closed, { code: 143, signal: null });
      await waitForProcessExit(childPid);
      await assert.rejects(
        stat(ownedDirectory),
        (error: NodeJS.ErrnoException) => error.code === "ENOENT"
      );
    } finally {
      await cleanupInterruptionFixture({ childPid, childPidPath, helper, root });
    }
  });
}
test("[Server/数据库与进程] 共享 owner 在 helper 空档仍响应中断并清理临时目录", {
  timeout: 15_000
}, async () => {
  const root = await createTestDirectory("idle-process-interruption-");
  const helperPath = resolve(root, "owner.mts");
  const ownedDirectory = resolve(root, "owned-directory");
  const readyPath = resolve(root, "helper.ready");
  const lateRegistrationResultPath = resolve(root, "late-registration-result.txt");
  const lateProcessResultPath = resolve(root, "late-process-result.txt");
  const processRunnerUrl = pathToFileURL(resolve(
    import.meta.dirname,
    "../support/process-runner.ts"
  )).href;
  const testDirectoryUrl = pathToFileURL(resolve(
    import.meta.dirname,
    "../support/test-directory.ts"
  )).href;
  const helperSource = [
    'import { mkdirSync, writeFileSync } from "node:fs";',
    `import { spawnSharedTestProcess } from ${JSON.stringify(processRunnerUrl)};`,
    `import { createTestDirectory, registerTestDirectory } from ${JSON.stringify(testDirectoryUrl)};`,
    "mkdirSync(process.argv[2], { recursive: true });",
    "registerTestDirectory(process.argv[2]);",
    'writeFileSync(process.argv[3], "ready");',
    'process.on("message", (message) => {',
    '  if (message?.type !== "imageshow:shutdown") return;',
    "  try {",
    '    spawnSharedTestProcess(process.execPath, ["-e", "process.exit(0)"]);',
    '    writeFileSync(process.argv[5], "created");',
    "  } catch {",
    '    writeFileSync(process.argv[5], "rejected");',
    "  }",
    '  void createTestDirectory("interrupted-late-owner-").then(',
    '    (directory) => writeFileSync(process.argv[4], "created:" + directory),',
    '    () => writeFileSync(process.argv[4], "rejected")',
    "  );",
    "});",
    "setInterval(() => undefined, 1_000);"
  ].join("\n");
  let helper: ChildProcess | undefined;
  let helperStderr = "";
  try {
    await writeFile(helperPath, helperSource);
    helper = spawnSharedTestProcess(process.execPath, [
      "--experimental-strip-types",
      helperPath,
      ownedDirectory,
      readyPath,
      lateRegistrationResultPath,
      lateProcessResultPath
    ], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true
    });
    helper.stderr?.on("data", (chunk: Buffer | string) => {
      helperStderr += String(chunk);
    });
    const closed = waitForChildClose(helper, () => helperStderr);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        assert.equal((await readFile(readyPath, "utf8")).trim(), "ready");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await delay(20);
      }
    }
    await stat(ownedDirectory);
    await new Promise<void>((resolveSend, rejectSend) => {
      helper!.send({ type: "imageshow:shutdown", signal: "SIGTERM" }, (error) => {
        if (error) rejectSend(error);
        else resolveSend();
      });
    });
    assert.deepEqual(await closed, { code: 143, signal: null });
    assert.equal(
      (await readFile(lateProcessResultPath, "utf8")).trim(),
      "rejected",
      "中断清理开始后必须拒绝新的辅助进程"
    );
    assert.equal(
      (await readFile(lateRegistrationResultPath, "utf8")).trim(),
      "rejected",
      "中断清理开始后必须拒绝新的临时目录"
    );
    await assert.rejects(
      stat(ownedDirectory),
      (error: NodeJS.ErrnoException) => error.code === "ENOENT"
    );
  } finally {
    await cleanupInterruptionFixture({ helper, root });
  }
});
test("[Server/数据库与进程] 后台任务类型只接受当前固定集合", () => {
  assert.deepEqual(backgroundJobTypes, [
    "move.cleanup",
    "trash.purge",
    "cache.rebuild"
  ]);
  for (const type of backgroundJobTypes) {
    assert.equal(parseBackgroundJobType(type), type);
  }
  for (const unsupported of ["unsupported.job", "", null, 1]) {
    assert.throws(
      () => parseBackgroundJobType(unsupported),
      /Unsupported background job type/
    );
  }
});
test("[Server/数据库与进程] Worker 重复停止会中止并排空同一个活动执行", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let completion: WorkerExecutionCompletion<string> | undefined;
  const coordinator = new WorkerExecutionCoordinator<{ id: string }, string>({
    taskTimeoutMs: 10_000,
    leaseRenewalIntervalMs: 10_000,
    renewLease: async () => true,
    execute: async (_job, signal) => {
      markStarted();
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true
        });
      });
    },
    settle: async (_job, result) => {
      completion = result;
    }
  });

  const running = coordinator.claimAndRun(async () => ({ id: "job" }));
  await started;
  const stopReason = new Error("test shutdown");
  coordinator.stop(stopReason);
  coordinator.stop(new Error("duplicate shutdown"));
  assert.equal(await coordinator.drain(1_000), true);
  assert.equal(await running, true);
  assert.equal(coordinator.isAccepting(), false);
  assert.deepEqual(completion, { status: "stopped", reason: stopReason });
  assert.equal(await coordinator.drain(0), true);

  coordinator.start();
  assert.equal(coordinator.isAccepting(), true);
  coordinator.stop();
});
test("[Server/数据库与进程] Worker 不丢弃已经发出的迟到续租失败", async () => {
  for (const scenario of ["lost", "error"] as const) {
    const renewalStarted = Promise.withResolvers<void>();
    const renewalResult = Promise.withResolvers<boolean>();
    const handlerResult = Promise.withResolvers<string>();
    const renewalError = new Error("injected renewal failure");
    let leaseLostCalls = 0;
    const renewalErrors: unknown[] = [];
    let completion: WorkerExecutionCompletion<string> | undefined;
    const coordinator = new WorkerExecutionCoordinator<
      { id: string },
      string
    >({
      taskTimeoutMs: 10_000,
      leaseRenewalIntervalMs: 1,
      renewLease: async () => {
        renewalStarted.resolve();
        return renewalResult.promise;
      },
      execute: async () => handlerResult.promise,
      settle: async (_job, result) => {
        completion = result;
      },
      onLeaseLost: () => {
        leaseLostCalls += 1;
      },
      onLeaseRenewalError: (_job, error) => {
        renewalErrors.push(error);
      }
    });

    const running = coordinator.claimAndRun(async () => ({ id: scenario }));
    await renewalStarted.promise;
    handlerResult.resolve("handled");
    // The handler continuation was registered first, so this microtask runs
    // after run() has stopped new renewals and is awaiting the in-flight one.
    await Promise.resolve();
    if (scenario === "lost") renewalResult.resolve(false);
    else renewalResult.reject(renewalError);

    assert.equal(await running, true);
    assert.equal(completion?.status, "rejected");
    if (completion?.status !== "rejected") assert.fail("expected rejection");
    if (scenario === "lost") {
      assert.equal(
        (completion.error as { code?: string }).code,
        "worker_lease_lost"
      );
      assert.equal(leaseLostCalls, 1);
      assert.deepEqual(renewalErrors, []);
    } else {
      assert.equal(
        (completion.error as { code?: string }).code,
        "worker_lease_renewal_failed"
      );
      assert.equal((completion.error as Error).cause, renewalError);
      assert.equal(leaseLostCalls, 0);
      assert.deepEqual(renewalErrors, [renewalError]);
    }
  }
});
test("[Server/数据库与进程] Worker 停止原因优先于在途续租的迟到结果", async () => {
  const renewalStarted = Promise.withResolvers<void>();
  const renewalResult = Promise.withResolvers<boolean>();
  let leaseLostCalls = 0;
  let completion: WorkerExecutionCompletion<string> | undefined;
  const coordinator = new WorkerExecutionCoordinator<{ id: string }, string>({
    taskTimeoutMs: 10_000,
    leaseRenewalIntervalMs: 1,
    renewLease: async () => {
      renewalStarted.resolve();
      return renewalResult.promise;
    },
    execute: async (_job, signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true
      });
    }),
    settle: async (_job, result) => {
      completion = result;
    },
    onLeaseLost: () => {
      leaseLostCalls += 1;
    }
  });

  const running = coordinator.claimAndRun(async () => ({ id: "stopping" }));
  await renewalStarted.promise;
  const stopReason = new Error("injected worker stop");
  coordinator.stop(stopReason);
  renewalResult.resolve(false);

  assert.equal(await running, true);
  assert.deepEqual(completion, { status: "stopped", reason: stopReason });
  assert.equal(leaseLostCalls, 0);
});
test("[Server/数据库与进程] 公开数据库准入保持 FIFO、总并发、队列上限与等待取消", async () => {
  const config = {
    ...appConfig.publicPgFallback,
    totalConcurrency: 1,
    queueLimit: 4,
    queueTimeoutMs: 30
  };
  const admission = createPublicDatabaseAdmission(config);
  const holder = await admission.acquire(new AbortController().signal);
  const activationOrder: string[] = [];
  const firstLeasePromise = admission.acquire(
    new AbortController().signal
  ).then((lease) => {
    activationOrder.push("first");
    return lease;
  });
  const secondLeasePromise = admission.acquire(
    new AbortController().signal
  ).then((lease) => {
    activationOrder.push("second");
    return lease;
  });
  assert.deepEqual(admission.snapshot(), { active: 1, queued: 2 });
  holder.release();
  const firstLease = await firstLeasePromise;
  await delay(0);
  assert.deepEqual(activationOrder, ["first"]);
  firstLease.release();
  const secondLease = await secondLeasePromise;
  assert.deepEqual(activationOrder, ["first", "second"]);
  secondLease.release();
  assert.equal(admission.snapshot().active, 0);
  assert.equal(admission.snapshot().queued, 0);

  const cancellationAdmission = createPublicDatabaseAdmission(config);
  const cancellationHolder = await cancellationAdmission.acquire(
    new AbortController().signal
  );
  const queuedAbort = new AbortController();
  const abortReason = new Error("queued request disconnected");
  const queued = cancellationAdmission.acquire(queuedAbort.signal);
  const queuedRejected = assert.rejects(
    queued,
    (error) => error === abortReason
  );
  queuedAbort.abort(abortReason);
  await queuedRejected;
  assert.equal(cancellationAdmission.snapshot().queued, 0);
  cancellationHolder.release();

  const boundedAdmission = createPublicDatabaseAdmission({
    ...config,
    queueLimit: 1,
    queueTimeoutMs: 10
  });
  const boundedHolder = await boundedAdmission.acquire(
    new AbortController().signal
  );
  const timedOut = boundedAdmission.acquire(new AbortController().signal);
  const timedOutRejected = assert.rejects(
    timedOut,
    (error: { code?: string; retryAfterSeconds?: number }) =>
      error.code === "public_pg_fallback_queue_timeout"
      && error.retryAfterSeconds === config.retryAfterSeconds
  );
  await assert.rejects(
    boundedAdmission.acquire(new AbortController().signal),
    (error: { code?: string }) =>
      error.code === "public_pg_fallback_queue_full"
  );
  await timedOutRejected;
  boundedHolder.release();
  assert.equal(boundedAdmission.snapshot().queued, 0);
});
test("[Server/数据库与进程] 公开 reader 排队 SQL 在失败、取消和 scope 结束后不再执行", async () => {
  for (const outcome of ["failure", "abort", "close"] as const) {
    const started = Promise.withResolvers<void>();
    const firstQuery = Promise.withResolvers<{ rows: unknown[] }>();
    const calls: string[] = [];
    const releases: boolean[] = [];
    let leaseReleases = 0;
    const controller = new AbortController();
    const failure = new Error(`reader ${outcome}`);
    const scope = createPublicDatabaseReadScope({
      pool: { connect: async () => ({
        query(text: string) {
          calls.push(text);
          started.resolve();
          return firstQuery.promise;
        },
        release(destroy: boolean) { releases.push(destroy); }
      }) } as never,
      admission: {
        acquire: async () => ({ release() { leaseReleases += 1; } }),
        snapshot: () => ({ active: 0, queued: 0 })
      },
      executionTimeoutMs: 1_000,
      retryAfterSeconds: 1
    });
    let results!: Promise<PromiseSettledResult<unknown>[]>;
    const operation = scope(controller.signal, async ({ reader }) => {
      const queries = [reader.query("first"), reader.query("second"), reader.query("third")];
      results = Promise.allSettled(queries);
      await started.promise;
      if (outcome === "close") throw failure;
      return Promise.all(queries);
    });
    const rejected = assert.rejects(operation, (error: { code?: string }) => (
      outcome === "failure"
        ? error.code === "public_pg_fallback_query_failed"
        : error === failure
    ));
    await started.promise;
    if (outcome === "failure") firstQuery.reject(failure);
    if (outcome === "abort") controller.abort(failure);
    await rejected;
    firstQuery.resolve({ rows: [] });
    const settled = await results;
    assert.deepEqual(calls, ["first"], `${outcome} 后排队 SQL 不得启动`);
    assert.equal(settled[1]?.status, "rejected");
    assert.equal(settled[2]?.status, "rejected");
    assert.deepEqual(releases, [true]);
    assert.equal(leaseReleases, 1);
  }
});
test("[Server/数据库与进程] 公开 PostgreSQL 回源在故障、取消和超时后释放资源", async () => {
  class FakePublicClient {
    readonly releases: boolean[] = [];
    readonly execute: () => Promise<unknown>;

    constructor(execute: () => Promise<unknown> = async () => ({
      rows: []
    })) {
      this.execute = execute;
    }

    query() {
      return this.execute();
    }

    release(destroy = false) {
      this.releases.push(destroy);
    }
  }

  const queryErrorClient = new FakePublicClient(async () => {
    throw new Error("connection lost during query");
  });
  let queryErrorLeaseReleases = 0;
  const queryErrorScope = createPublicDatabaseReadScope({
    pool: { connect: async () => queryErrorClient } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          queryErrorLeaseReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1
  } as never);
  await assert.rejects(
    queryErrorScope(
      new AbortController().signal,
      async ({ reader }) => reader.query("broken")
    ),
    (error: { code?: string }) =>
      error.code === "public_pg_fallback_query_failed"
  );
  assert.deepEqual(queryErrorClient.releases, [true]);
  assert.equal(queryErrorLeaseReleases, 1);

  const apiErrorClient = new FakePublicClient();
  let apiErrorLeaseReleases = 0;
  const apiErrorScope = createPublicDatabaseReadScope({
    pool: { connect: async () => apiErrorClient } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          apiErrorLeaseReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1
  } as never);
  const businessError = new ApiError(404, "not_found", "Not found");
  await assert.rejects(
    apiErrorScope(new AbortController().signal, async ({ reader }) => {
      await reader.query("business lookup");
      throw businessError;
    }),
    (error) => error === businessError
  );
  assert.deepEqual(apiErrorClient.releases, [false]);
  assert.equal(apiErrorLeaseReleases, 1);

  const recoveredClient = new FakePublicClient();
  let connectAttempts = 0;
  let recoveryAdmissionReleases = 0;
  const recoveringScope = createPublicDatabaseReadScope({
    pool: {
      connect: async () => {
        connectAttempts += 1;
        if (connectAttempts === 1) throw new Error("database unavailable");
        return recoveredClient;
      }
    } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          recoveryAdmissionReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1
  } as never);
  await assert.rejects(
    recoveringScope(
      new AbortController().signal,
      async ({ reader }) => reader.query("unreachable")
    ),
    (error: { code?: string }) =>
      error.code === "public_pg_fallback_unavailable"
  );
  assert.deepEqual(await recoveringScope(
    new AbortController().signal,
    async ({ reader }) => reader.query("recovered")
  ), { rows: [] });
  assert.deepEqual(recoveredClient.releases, [false]);
  assert.equal(recoveryAdmissionReleases, 2);

  const activeStarted = Promise.withResolvers<void>();
  const activeGate = Promise.withResolvers<never>();
  const activeClient = new FakePublicClient(async () => {
    activeStarted.resolve();
    return activeGate.promise;
  });
  let activeAdmissionReleases = 0;
  const activeScope = createPublicDatabaseReadScope({
    pool: { connect: async () => activeClient } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          activeAdmissionReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1
  } as never);
  const requestAbort = new AbortController();
  const operation = activeScope(
    requestAbort.signal,
    async ({ reader }) => reader.query("active")
  );
  await activeStarted.promise;
  const abortReason = new Error("public request disconnected");
  const operationRejected = assert.rejects(
    operation,
    (error) => error === abortReason
  );
  requestAbort.abort(abortReason);
  await operationRejected;
  assert.deepEqual(activeClient.releases, [true]);
  assert.equal(activeAdmissionReleases, 1);

  const checkoutGate = Promise.withResolvers<FakePublicClient>();
  const checkoutStarted = Promise.withResolvers<void>();
  const checkoutClient = new FakePublicClient();
  let checkoutAdmissionReleases = 0;
  const checkoutScope = createPublicDatabaseReadScope({
    pool: {
      connect: async () => {
        checkoutStarted.resolve();
        return checkoutGate.promise;
      }
    } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          checkoutAdmissionReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1,
  } as never);
  const checkoutAbort = new AbortController();
  const checkoutOperation = checkoutScope(
    checkoutAbort.signal,
    async ({ reader }) => reader.query("unreachable")
  );
  await checkoutStarted.promise;
  const checkoutReason = new Error("disconnect during pool checkout");
  const checkoutRejected = assert.rejects(
    checkoutOperation,
    (error) => error === checkoutReason
  );
  checkoutAbort.abort(checkoutReason);
  await checkoutRejected;
  assert.equal(checkoutAdmissionReleases, 0);
  checkoutGate.resolve(checkoutClient);
  await delay(0);
  await delay(0);
  assert.deepEqual(checkoutClient.releases, [true]);
  assert.equal(checkoutAdmissionReleases, 1);

  const timeoutClient = new FakePublicClient(
    async () => new Promise<never>(() => undefined)
  );
  let timeoutAdmissionReleases = 0;
  const timeoutScope = createPublicDatabaseReadScope({
    pool: { connect: async () => timeoutClient } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          timeoutAdmissionReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 10,
    retryAfterSeconds: 1
  } as never);
  await assert.rejects(
    timeoutScope(
      new AbortController().signal,
      async ({ reader }) => reader.query("slow")
    ),
    (error: { code?: string }) =>
      error.code === "public_pg_fallback_execution_timeout"
  );
  assert.deepEqual(timeoutClient.releases, [true]);
  assert.equal(timeoutAdmissionReleases, 1);

  const storageTimeoutClient = new FakePublicClient();
  let storageAbortObserved = false;
  let storageTimeoutAdmissionReleases = 0;
  const storageTimeoutScope = createPublicDatabaseReadScope({
    pool: { connect: async () => storageTimeoutClient } as never,
    admission: {
      acquire: async () => ({
        release: () => {
          storageTimeoutAdmissionReleases += 1;
        }
      }),
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 10,
    retryAfterSeconds: 1
  } as never);
  await assert.rejects(
    storageTimeoutScope(
      new AbortController().signal,
      async ({ reader }, signal) => {
        await reader.query("resolve storage record");
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            storageAbortObserved = true;
            reject(signal.reason);
          }, { once: true });
        });
      }
    ),
    (error: { code?: string }) =>
      error.code === "public_pg_fallback_execution_timeout"
  );
  assert.equal(storageAbortObserved, true);
  assert.deepEqual(storageTimeoutClient.releases, [true]);
  assert.equal(storageTimeoutAdmissionReleases, 1);
});
test("[Server/数据库与进程] 数据库事务边界只在成功提交并在失败时回滚", async () => {
  const queries: string[] = [];
  const client = {
    query: async (text: string) => {
      queries.push(text);
      return text.startsWith("SELECT pg_current_xact_id")
        ? { rows: [{ transaction_id: "81" }] }
        : { rows: [] };
    }
  } as never;
  let transactionId = "";
  const value = await withTransactionOnClient(
    client,
    async () => "committed",
    { onTransactionId: (current) => {
      transactionId = current;
    } }
  );
  assert.equal(value, "committed");
  assert.equal(transactionId, "81");
  assert.deepEqual(queries, [
    "BEGIN",
    "SELECT pg_current_xact_id()::text AS transaction_id",
    "COMMIT"
  ]);

  queries.length = 0;
  const failure = new Error("transaction body failed");
  await assert.rejects(
    withTransactionOnClient(client, async () => {
      throw failure;
    }),
    (error) => error === failure
  );
  assert.deepEqual(queries, ["BEGIN", "ROLLBACK"]);

  queries.length = 0;
  assert.equal(
    await withTransactionOnClient(
      client,
      async () => "snapshot",
      { mode: "read_only_repeatable_read" }
    ),
    "snapshot"
  );
  assert.deepEqual(queries, [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "COMMIT"
  ]);

  queries.length = 0;
  await assert.rejects(
    withTransactionOnClient(
      client,
      async () => {
        throw failure;
      },
      { mode: "read_only_repeatable_read" }
    ),
    (error) => error === failure
  );
  assert.deepEqual(queries, [
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    "ROLLBACK"
  ]);
});
test("[Server/数据库与进程] advisory lock 连接池等待可取消并释放迟到 client", async () => {
  const controller = new AbortController();
  const reason = new Error("stop while waiting for advisory client");
  let resolveClient!: (client: { release: () => void }) => void;
  const pending = new Promise<{ release: () => void }>((resolve) => {
    resolveClient = resolve;
  });
  let releases = 0;
  const acquiring = acquireAdvisoryLockClient(
    controller.signal,
    () => pending as never
  );
  controller.abort(reason);
  await assert.rejects(acquiring, (error) => error === reason);
  resolveClient({ release: () => {
    releases += 1;
  } });
  await delay(0);
  assert.equal(releases, 1);
});
