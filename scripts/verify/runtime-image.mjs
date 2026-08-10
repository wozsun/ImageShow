import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  forceTerminateProcessTree,
  releaseFailedProcessTree,
  spawnManaged
} from "../build/process-tree.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const { version } = JSON.parse(
  await readFile(resolve(workspaceRoot, "package.json"), "utf8")
);
const suffix = `${process.pid}-${randomBytes(12).toString("hex")}`;
const names = {
  network: `imageshow-verify-${suffix}`,
  postgres: `imageshow-verify-postgres-${suffix}`,
  redis: `imageshow-verify-redis-${suffix}`,
  failedApp: `imageshow-verify-failed-app-${suffix}`,
  normalizer: `imageshow-verify-normalizer-${suffix}`,
  app: `imageshow-verify-app-${suffix}`
};
const stableImageTag = `imageshow:${version}-verify`;
const temporaryImageTag = `${stableImageTag}-${suffix}`;
const databasePassword = randomBytes(24).toString("base64url");
const adminPassword = `Verify-${randomBytes(18).toString("base64url")}`;
const activeChildren = new Set();
const attemptedContainers = new Set();
let attemptedNetwork = false;
let attemptedImage = false;
let runtimeCleanupPromise = null;
let imageCleanupPromise = null;
let cleanupPromise = null;
let interruptedSignal = "";
let signalHandling = false;

function runDocker(
  arguments_,
  {
    allowDuringInterrupt = false,
    allowFailure = false,
    stdio = "pipe",
    timeoutMs = 30_000
  } = {}
) {
  if (interruptedSignal && !allowDuringInterrupt) {
    return Promise.reject(new Error(
      `docker ${arguments_[0]} refused after ${interruptedSignal}`
    ));
  }
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawnManaged("docker", arguments_, {
      cwd: workspaceRoot,
      stdio,
      windowsHide: true
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void forceTerminateProcessTree(child).then(
        () => finish(() => rejectCommand(new Error(
          `docker ${arguments_[0]} exceeded ${timeoutMs} ms`
        ))),
        (error) => {
          releaseFailedProcessTree(child);
          activeChildren.delete(child);
          finish(() => rejectCommand(new AggregateError(
            [error],
            `docker ${arguments_[0]} exceeded ${timeoutMs} ms and its process tree did not terminate`
          )));
        }
      );
    }, timeoutMs);

    const finish = (callback) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timeout);
      callback();
      return true;
    };
    if (child.stdout) child.stdout.on("data", (chunk) => { stdout += chunk; });
    if (child.stderr) child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      activeChildren.delete(child);
      finish(() => rejectCommand(error));
    });
    child.once("close", (code, signal) => {
      activeChildren.delete(child);
      finish(() => {
        const result = {
          code,
          signal,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        };
        if (timedOut) {
          rejectCommand(new Error(
            `docker ${arguments_[0]} exceeded ${timeoutMs} ms`
          ));
          return;
        }
        if (interruptedSignal && !allowDuringInterrupt) {
          rejectCommand(new Error(
            `docker ${arguments_[0]} interrupted with ${interruptedSignal}`
          ));
          return;
        }
        if (code === 0 || allowFailure) {
          resolveCommand(result);
          return;
        }
        rejectCommand(new Error(
          `docker ${arguments_[0]} failed${signal ? ` with ${signal}` : ` with exit code ${code}`}\n`
          + `${stderr || stdout}`
        ));
      });
    });
  });
}

function resultText(result) {
  return `${result.stderr}\n${result.stdout}`.trim();
}

function isNotFound(result) {
  return /no such (?:container|image|network|object)|not found/i.test(
    resultText(result)
  );
}

async function confirmAbsent(
  label,
  inspectArguments,
  { allowDuringInterrupt = false } = {}
) {
  const inspected = await runDocker(inspectArguments, {
    allowDuringInterrupt,
    allowFailure: true
  });
  if (inspected.code === 0) throw new Error(`${label} still exists after cleanup`);
  if (!isNotFound(inspected)) {
    throw new Error(
      `${label} absence could not be proven: ${resultText(inspected)}`
    );
  }
}

async function removeContainer(name) {
  const removed = await runDocker(["rm", "--force", name], {
    allowDuringInterrupt: true,
    allowFailure: true
  });
  if (removed.code !== 0 && !isNotFound(removed)) {
    throw new Error(`failed to remove container ${name}: ${resultText(removed)}`);
  }
  await confirmAbsent(
    `container ${name}`,
    ["container", "inspect", name],
    { allowDuringInterrupt: true }
  );
}

async function terminateActiveChildren() {
  const children = [...activeChildren];
  const results = await Promise.allSettled(
    children.map(forceTerminateProcessTree)
  );
  const errors = results.flatMap((result) => (
    result.status === "rejected" ? [result.reason] : []
  ));
  results.forEach((result, index) => {
    if (result.status !== "rejected") return;
    releaseFailedProcessTree(children[index]);
    activeChildren.delete(children[index]);
  });
  if (errors.length > 0) {
    throw new AggregateError(errors, "failed to terminate active Docker commands");
  }
}

async function performRuntimeCleanup() {
  const errors = [];
  const containerResults = await Promise.allSettled(
    [names.failedApp, names.normalizer, names.app, names.redis, names.postgres]
      .filter((name) => attemptedContainers.has(name))
      .map(async (name) => {
        await removeContainer(name);
        attemptedContainers.delete(name);
      })
  );
  errors.push(...containerResults.flatMap((result) => (
    result.status === "rejected" ? [result.reason] : []
  )));
  if (attemptedNetwork) {
    try {
      const removed = await runDocker(["network", "rm", names.network], {
        allowDuringInterrupt: true,
        allowFailure: true
      });
      if (removed.code !== 0 && !isNotFound(removed)) {
        throw new Error(
          `failed to remove network ${names.network}: ${resultText(removed)}`
        );
      }
      await confirmAbsent(
        `network ${names.network}`,
        ["network", "inspect", names.network],
        { allowDuringInterrupt: true }
      );
      attemptedNetwork = false;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "runtime resource cleanup did not converge");
  }
}

function cleanupRuntimeResources() {
  if (runtimeCleanupPromise) return runtimeCleanupPromise;
  runtimeCleanupPromise = performRuntimeCleanup().finally(() => {
    runtimeCleanupPromise = null;
  });
  return runtimeCleanupPromise;
}

async function performTemporaryImageCleanup() {
  if (!attemptedImage) return;
  const removed = await runDocker(["image", "rm", temporaryImageTag], {
    allowDuringInterrupt: true,
    allowFailure: true
  });
  if (removed.code !== 0 && !isNotFound(removed)) {
    throw new Error(
      `failed to remove temporary image tag ${temporaryImageTag}: ${resultText(removed)}`
    );
  }
  await confirmAbsent(
    `temporary image tag ${temporaryImageTag}`,
    ["image", "inspect", temporaryImageTag],
    { allowDuringInterrupt: true }
  );
  attemptedImage = false;
}

function cleanupTemporaryImage() {
  if (imageCleanupPromise) return imageCleanupPromise;
  imageCleanupPromise = performTemporaryImageCleanup().finally(() => {
    imageCleanupPromise = null;
  });
  return imageCleanupPromise;
}

function cleanup() {
  cleanupPromise ??= (async () => {
    const terminationErrors = [];
    try {
      await terminateActiveChildren();
    } catch (error) {
      terminationErrors.push(error);
    }
    let lastRuntimeErrors = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await cleanupRuntimeResources();
        lastRuntimeErrors = [];
      } catch (error) {
        lastRuntimeErrors = [error];
      }
      if (attemptedContainers.size === 0 && !attemptedNetwork) break;
      if (attempt === 0) await delay(250);
    }
    if (attemptedContainers.size > 0 || attemptedNetwork) {
      const remaining = [
        ...attemptedContainers,
        ...(attemptedNetwork ? [names.network] : [])
      ];
      throw new AggregateError(
        [
          ...terminationErrors,
          ...lastRuntimeErrors,
          new Error(`resources still tracked: ${remaining.join(", ")}`)
        ],
        "runtime-image resource cleanup failed after bounded retry"
      );
    }

    let lastImageErrors = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await cleanupTemporaryImage();
        lastImageErrors = [];
      } catch (error) {
        lastImageErrors = [error];
      }
      if (!attemptedImage) break;
      if (attempt === 0) await delay(250);
    }
    if (!attemptedImage && terminationErrors.length === 0) return;
    throw new AggregateError(
      [...terminationErrors, ...lastImageErrors],
      "runtime-image cleanup failed after bounded retry"
    );
  })();
  return cleanupPromise;
}

/* c8 ignore start -- exercised by manual Ctrl+C/SIGTERM release checks. */
function handleSignal(signal) {
  if (signalHandling) return;
  signalHandling = true;
  interruptedSignal = signal;
  void cleanup().then(
    () => process.exit(signal === "SIGINT" ? 130 : 143),
    (error) => {
      console.error("[runtime-image] signal cleanup failed:", error);
      process.exit(1);
    }
  );
}
/* c8 ignore stop */

function handleShutdownMessage(message) {
  if (
    message?.type === "imageshow:shutdown"
    && (message.signal === "SIGINT" || message.signal === "SIGTERM")
  ) {
    handleSignal(message.signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => handleSignal(signal));
}
process.on("message", handleShutdownMessage);

/*
 * Resource cleanup is deliberately above the probes. A timeout or signal must
 * be able to stop an in-flight Docker CLI before starting exact-name cleanup.
 */

async function waitFor(label, probe, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = "";
  while (Date.now() < deadline) {
    if (interruptedSignal) throw new Error(`interrupted with ${interruptedSignal}`);
    const remainingMs = deadline - Date.now();
    const result = await probe(Math.max(1, Math.min(15_000, remainingMs)));
    if (result.code === 0) return;
    lastResult = result.stderr || result.stdout || `exit code ${result.code}`;
    await delay(Math.min(1_000, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`${label} did not become ready: ${lastResult}`);
}

async function applicationProbe(timeoutMs) {
  const program = [
    "import { request } from 'node:http';",
    "const paths = ['/readyz', '/'];",
    "for (const path of paths) {",
    "  const status = await new Promise((resolve, reject) => {",
    "    const signal = AbortSignal.timeout(5000);",
    "    const outgoing = request({ hostname: '127.0.0.1', port: 5518, path, headers: { Host: 'example.test' }, signal }, (incoming) => {",
    "      incoming.resume();",
    "      incoming.on('end', () => resolve(incoming.statusCode ?? 0));",
    "    });",
    "    outgoing.on('error', reject);",
    "    outgoing.end();",
    "  });",
    "  if (status !== 200) throw new Error(path + ' returned ' + status);",
    "}"
  ].join("\n");
  return runDocker(
    ["exec", names.app, "node", "--input-type=module", "--eval", program],
    { allowFailure: true, timeoutMs }
  );
}

async function healthProbe(timeoutMs) {
  const result = await runDocker([
    "container", "inspect", "--format", "{{.State.Health.Status}}", names.app
  ], { allowFailure: true, timeoutMs });
  if (result.code === 0 && result.stdout === "healthy") return result;
  return {
    ...result,
    code: 1,
    stderr: result.stderr || `health status: ${result.stdout || "missing"}`
  };
}

async function containerImageId() {
  const result = await runDocker([
    "container", "inspect", "--format", "{{.Image}}", names.app
  ]);
  return result.stdout;
}

async function stoppedContainerProbe(name, exitCode, timeoutMs) {
  const result = await runDocker([
    "container", "inspect", "--format",
    "{{.State.Status}} {{.State.ExitCode}}", name
  ], { allowFailure: true, timeoutMs });
  if (result.code === 0 && result.stdout === `exited ${exitCode}`) return result;
  return {
    ...result,
    code: 1,
    stderr: result.stderr
      || `container state: ${result.stdout || "missing"}`
  };
}

async function applicationConnectionCount(databaseName) {
  if (!/^[a-z0-9_]+$/.test(databaseName)) {
    throw new Error(`invalid test database name: ${databaseName}`);
  }
  const sql = [
    "SELECT count(*)::text FROM pg_stat_activity",
    `WHERE datname='${databaseName}'`,
    "AND usename='imageshow' AND pid <> pg_backend_pid();"
  ].join(" ");
  const result = await runDocker([
    "exec", "-e", `PGPASSWORD=${databasePassword}`, names.postgres,
    "psql", "--username", "imageshow", "--dbname", "postgres",
    "--tuples-only", "--no-align", "--command", sql
  ]);
  return Number(result.stdout.trim());
}

async function redisApplicationConnectionCount() {
  const result = await runDocker([
    "exec", names.redis, "redis-cli", "--raw", "CLIENT", "LIST"
  ]);
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line && !/\bcmd=client\|list\b/.test(line))
    .length;
}

function applicationContainerArguments(name, databaseName, imageId) {
  return [
    "run", "--detach", "--name", name,
    "--stop-timeout", "50",
    "--network", names.network,
    "--tmpfs", "/app/data:rw",
    "--env", "SITE_DOMAIN=example.test",
    "--env", "ADMIN_USERNAME=verifyadmin",
    "--env", `ADMIN_PASSWORD=${adminPassword}`,
    "--env", "DATABASE_HOST=postgresql",
    "--env", "DATABASE_PORT=5432",
    "--env", `DATABASE_NAME=${databaseName}`,
    "--env", "DATABASE_USER=imageshow",
    "--env", `DATABASE_PASSWORD=${databasePassword}`,
    "--env", "REDIS_HOST=redis",
    "--env", "REDIS_PORT=6379",
    "--env", "REDIS_DB=0",
    "--env", "LOG_LEVEL=INFO",
    imageId
  ];
}

function normalizationCheckArguments(imageId) {
  return [
    "run", "--rm", "--name", names.normalizer,
    "--network", names.network,
    "--env", "DATABASE_HOST=postgresql",
    "--env", "DATABASE_PORT=5432",
    "--env", "DATABASE_NAME=imageshow",
    "--env", "DATABASE_USER=imageshow",
    "--env", `DATABASE_PASSWORD=${databasePassword}`,
    imageId,
    "npm", "run", "--silent", "database:normalize:v4.8", "--", "--check"
  ];
}

async function schemaShape() {
  const sql = [
    "SELECT count(*)::text FROM information_schema.tables",
    "WHERE table_schema = 'public' AND table_type = 'BASE TABLE';"
  ].join(" ");
  const result = await runDocker([
    "exec", "-e", `PGPASSWORD=${databasePassword}`, names.postgres,
    "psql", "--username", "imageshow", "--dbname", "imageshow",
    "--tuples-only", "--no-align", "--command", sql
  ]);
  return result.stdout.trim();
}

let completed = false;
try {
  await confirmAbsent(
    `temporary image tag ${temporaryImageTag}`,
    ["image", "inspect", temporaryImageTag]
  );
  console.log(`[runtime-image] building ${temporaryImageTag}`);
  attemptedImage = true;
  await runDocker(["build", "--tag", temporaryImageTag, "."], {
    stdio: "inherit",
    timeoutMs: 10 * 60_000
  });
  const image = await runDocker([
    "image", "inspect", "--format", "{{.Id}}", temporaryImageTag
  ]);
  const imageId = image.stdout;
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw new Error(`invalid candidate image ID: ${imageId}`);
  }

  await confirmAbsent(`network ${names.network}`, ["network", "inspect", names.network]);
  for (const name of [
    names.postgres,
    names.redis,
    names.failedApp,
    names.normalizer,
    names.app
  ]) {
    await confirmAbsent(`container ${name}`, ["container", "inspect", name]);
  }

  attemptedNetwork = true;
  await runDocker(["network", "create", names.network]);
  attemptedContainers.add(names.postgres);
  await runDocker([
    "run", "--detach", "--name", names.postgres,
    "--network", names.network, "--network-alias", "postgresql",
    "--tmpfs", "/var/lib/postgresql:rw",
    "--env", "POSTGRES_DB=imageshow",
    "--env", "POSTGRES_USER=imageshow",
    "--env", `POSTGRES_PASSWORD=${databasePassword}`,
    "postgres:18"
  ], { timeoutMs: 3 * 60_000 });
  attemptedContainers.add(names.redis);
  await runDocker([
    "run", "--detach", "--name", names.redis,
    "--network", names.network, "--network-alias", "redis",
    "--tmpfs", "/data:rw",
    "redis:8", "redis-server", "--appendonly", "no"
  ], { timeoutMs: 3 * 60_000 });

  await waitFor("PostgreSQL", (timeoutMs) => runDocker([
    "exec", names.postgres, "pg_isready", "--host", "127.0.0.1",
    "--username", "imageshow", "--dbname", "imageshow"
  ], { allowFailure: true, timeoutMs }));
  await waitFor("Redis", (timeoutMs) => runDocker([
    "exec", names.redis, "redis-cli", "ping"
  ], { allowFailure: true, timeoutMs }));

  await runDocker([
    "exec", "-e", `PGPASSWORD=${databasePassword}`, names.postgres,
    "psql", "--username", "imageshow", "--dbname", "postgres",
    "--command", "CREATE DATABASE imageshow_broken"
  ]);
  await runDocker([
    "exec", "-e", `PGPASSWORD=${databasePassword}`, names.postgres,
    "psql", "--username", "imageshow", "--dbname", "imageshow_broken",
    "--command", "CREATE TABLE unrelated_marker(id integer PRIMARY KEY)"
  ]);
  attemptedContainers.add(names.failedApp);
  await runDocker(applicationContainerArguments(
    names.failedApp,
    "imageshow_broken",
    imageId
  ));
  await waitFor(
    "ImageShow initialization failure",
    (timeoutMs) => stoppedContainerProbe(names.failedApp, 1, timeoutMs),
    30_000
  );
  const failedLogs = await runDocker(["logs", names.failedApp]);
  if (!/application startup failed/.test(resultText(failedLogs))) {
    throw new Error("initialization failure did not enter the shared shutdown path");
  }
  if (!/application resources released/.test(resultText(failedLogs))) {
    throw new Error("initialization failure did not explicitly release resources");
  }
  if (await applicationConnectionCount("imageshow_broken") !== 0) {
    throw new Error("failed ImageShow startup retained PostgreSQL connections");
  }

  attemptedContainers.add(names.app);
  await runDocker(applicationContainerArguments(names.app, "imageshow", imageId));
  const stopTimeout = await runDocker([
    "container", "inspect", "--format", "{{.Config.StopTimeout}}", names.app
  ]);
  if (stopTimeout.stdout !== "50") {
    throw new Error(`unexpected ImageShow stop timeout: ${stopTimeout.stdout}`);
  }

  await waitFor("ImageShow Docker health", healthProbe, 180_000);
  if (await containerImageId() !== imageId) {
    throw new Error("cold-start container does not use the inspected image ID");
  }
  await waitFor("ImageShow HTTP", applicationProbe, 30_000);
  const coldShape = await schemaShape();
  if (coldShape !== "10") {
    throw new Error(`unexpected schema shape before restart: ${coldShape}`);
  }
  if (await applicationConnectionCount("imageshow") < 1) {
    throw new Error("running ImageShow did not hold an expected PostgreSQL connection");
  }
  if (await redisApplicationConnectionCount() < 1) {
    throw new Error("running ImageShow did not hold an expected Redis connection");
  }

  await runDocker([
    "exec", names.app, "node", "--input-type=module", "--eval",
    "process.kill(1, 'SIGTERM'); process.kill(1, 'SIGINT');"
  ], { allowFailure: true });
  await waitFor(
    "ImageShow repeated graceful shutdown",
    (timeoutMs) => stoppedContainerProbe(names.app, 0, timeoutMs),
    60_000
  );
  const stoppedLogs = await runDocker(["logs", names.app]);
  const stoppedLogText = resultText(stoppedLogs);
  if (/application shutdown failed/.test(stoppedLogText)) {
    throw new Error("repeated shutdown signals reported a failure");
  }
  for (const signal of ["SIGTERM", "SIGINT"]) {
    if (!new RegExp(`received ${signal}`).test(stoppedLogText)) {
      throw new Error(`${signal} did not reach the ImageShow shutdown handler`);
    }
  }
  if (!/shutdown already in progress/.test(stoppedLogText)) {
    throw new Error("repeated shutdown did not reuse the active shutdown");
  }
  if (!/application resources released/.test(stoppedLogText)) {
    throw new Error("graceful shutdown did not explicitly release resources");
  }
  if (await applicationConnectionCount("imageshow") !== 0) {
    throw new Error("graceful ImageShow shutdown retained PostgreSQL connections");
  }
  if (await redisApplicationConnectionCount() !== 0) {
    throw new Error("graceful ImageShow shutdown retained Redis connections");
  }
  attemptedContainers.add(names.normalizer);
  const normalizationCheck = await runDocker(
    normalizationCheckArguments(imageId),
    { timeoutMs: 60_000 }
  );
  const normalizationReport = JSON.parse(normalizationCheck.stdout);
  if (
    normalizationReport.mode !== "check"
    || normalizationReport.inspection?.target?.database !== "imageshow"
    || normalizationReport.inspection?.ready_to_apply !== true
    || normalizationReport.inspection?.pending_ddl?.length !== 0
    || normalizationReport.inspection?.blockers?.length !== 0
  ) {
    throw new Error("candidate image normalization --check returned an unexpected report");
  }
  await confirmAbsent(
    `container ${names.normalizer}`,
    ["container", "inspect", names.normalizer]
  );
  attemptedContainers.delete(names.normalizer);
  await runDocker(["start", names.app], { timeoutMs: 60_000 });
  await waitFor("ImageShow Docker health after restart", healthProbe, 180_000);
  if (await containerImageId() !== imageId) {
    throw new Error("restarted container does not use the inspected image ID");
  }
  await waitFor("ImageShow HTTP after restart", applicationProbe, 30_000);
  const restartedShape = await schemaShape();
  if (restartedShape !== "10") {
    throw new Error(`unexpected schema shape after restart: ${restartedShape}`);
  }

  await cleanupRuntimeResources();
  await runDocker(["image", "tag", imageId, stableImageTag]);
  const stableImage = await runDocker([
    "image", "inspect", "--format", "{{.Id}}", stableImageTag
  ]);
  if (stableImage.stdout !== imageId) {
    throw new Error(`stable candidate tag does not resolve to ${imageId}`);
  }
  await cleanupTemporaryImage();
  completed = true;
  console.log(
    `[runtime-image] ${stableImageTag} ${imageId}; Docker health, immutable image ID, `
    + "startup failure cleanup, repeated signals, explicit PostgreSQL/Redis release, "
    + "packaged database normalization check, cold/restart HTTP and schema 10 tables passed"
  );
} catch (error) {
  if (!interruptedSignal) {
    await terminateActiveChildren().catch((terminationError) => {
      console.error("[runtime-image] failed to stop timed-out Docker command:", terminationError);
    });
    const logs = await runDocker(["logs", "--tail", "200", names.app], {
      allowFailure: true,
      timeoutMs: 15_000
    }).catch(() => null);
    if (logs && (logs.stdout || logs.stderr)) {
      console.error("[runtime-image] application logs:\n" + (logs.stdout || logs.stderr));
    }
  }
  throw error;
} finally {
  if (!completed) await cleanup();
}
process.off("message", handleShutdownMessage);
