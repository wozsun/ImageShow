import "../support/server-environment.ts";
import assert from "node:assert/strict";
import {
  randomUUID
} from "node:crypto";
import {
  rm
} from "node:fs/promises";
import {
  join,
  resolve,
  toNamespacedPath
} from "node:path";
import {
  setTimeout as delay
} from "node:timers/promises";
import test, {
  type TestContext
} from "node:test";
import {
  cleanupTestDirectories,
  createTestDirectory,
  sealTestDirectoryRegistrationForInterruption
} from "../support/test-directory.ts";
import {
  createProcessRunner,
  suspendSharedTestInterruptionHandling,
  type ProcessResult,
  type ProcessRunOptions
} from "../support/process-runner.ts";
import {
  Client
} from "pg";

const isolationRoot = resolve(import.meta.dirname, "isolation");
const storageIngestionScenarios = [
  {
    id: "ingestion-raw-lifecycle",
    name: "Raw 准入、转码租约、退休清理与目录游标",
    script: join(isolationRoot, "ingestion-raw-lifecycle.mts")
  },
  {
    id: "storage-maintenance-cancellation",
    name: "存储维护的锁等待、取消和双资源收口",
    script: join(isolationRoot, "storage-maintenance-cancellation.mts")
  },
  {
    id: "ingestion-orphan-lifecycle",
    name: "接入孤儿的引用保护、批次与跨周期清理",
    script: join(isolationRoot, "ingestion-orphan-lifecycle.mts")
  },
  {
    id: "storage-thumbnail-recovery",
    name: "缩略图维修、并发恢复与失败补偿",
    script: join(isolationRoot, "storage-thumbnail-recovery.mts")
  },
  {
    id: "local-io-lifecycle",
    name: "Local 对象读取、复制与目录生命周期",
    script: join(isolationRoot, "local-io-lifecycle.mts")
  },
  {
    id: "ingestion-queue-actions",
    name: "接入队列动作、重放与并发冲突",
    script: join(isolationRoot, "ingestion-queue-actions.mts")
  },
  {
    id: "ingestion-commit-guards",
    name: "接入提交 CAS 与持久对象保护",
    script: join(isolationRoot, "ingestion-commit-guards.mts")
  },
  {
    id: "ingestion-import-queue",
    name: "Import 生命周期、展示顺序与扫描进度",
    script: join(isolationRoot, "ingestion-import-queue.mts")
  },
  {
    id: "ingestion-upload-lifecycle",
    name: "Upload 接管、状态机与结构一致性",
    script: join(isolationRoot, "ingestion-upload-lifecycle.mts")
  },
  {
    id: "ingestion-action-protocol",
    name: "接入动作水位与凭证绑定",
    script: join(isolationRoot, "ingestion-action-protocol.mts")
  },
  {
    id: "ingestion-service-contracts",
    name: "接入服务批处理与 PostgreSQL 结果权威",
    script: join(isolationRoot, "ingestion-service-contracts.mts")
  },
  {
    id: "image-read-consistency",
    name: "图片分页的事务快照、Redis 回源等价和中断边界",
    script: join(isolationRoot, "image-read-consistency.mts")
  },
  {
    id: "public-image-browse",
    name: "公开两档分页、随机环形边界与条件缓存",
    script: join(isolationRoot, "public-image-browse.mts")
  },
  {
    id: "redis-business-commands",
    name: "Redis 业务 Lua 的冷加载、并发、事务与缓存完整性",
    script: join(isolationRoot, "redis-business-commands.mts")
  },
  {
    id: "storage-lock-admission",
    name: "真实 advisory 锁丢失与删除准入取消",
    script: join(isolationRoot, "storage-lock-admission.mts")
  },
  {
    id: "storage-cleanup-recovery",
    name: "持久对象清理的重新采用、迟到发布和取消保护",
    script: join(isolationRoot, "storage-cleanup-recovery.mts")
  },
  {
    id: "storage-migration-recovery",
    name: "存储迁移的完整性、部分失败、取消与提交回执丢失",
    script: join(isolationRoot, "storage-migration-recovery.mts")
  },
  {
    id: "image-classification-consistency",
    name: "分类修改只更新 metadata，失败不改变对象或词表",
    script: join(isolationRoot, "image-classification-consistency.mts")
  },
  {
    id: "trash-purge-recovery",
    name: "回收站的持久删除、取消、选区与故障恢复",
    script: join(isolationRoot, "trash-purge-recovery.mts")
  },
  {
    id: "storage-registry-lifecycle",
    name: "存储注册表热重载、driver 退休与延迟读取",
    script: join(isolationRoot, "storage-registry-lifecycle.mts")
  },
  {
    id: "image-update-consistency",
    name: "图片批量更新的事务、词表和缓存一致性",
    script: join(isolationRoot, "image-update-consistency.mts")
  },
  {
    id: "auth-author-contracts",
    name: "作者身份的权限、事务和公开输出，以及登录会话续期",
    script: join(isolationRoot, "auth-author-contracts.mts")
  },
  {
    id: "config-package-consistency",
    name: "配置包导入的文件、内存与 PostgreSQL 事务一致性及权限",
    script: join(isolationRoot, "config-package-consistency.mts")
  },
  {
    id: "redis-canonical",
    name: "真实 Redis canonical 的创建、可见性与 ready 迁移",
    script: join(isolationRoot, "ingestion-redis-canonical.mts")
  },
  {
    id: "commit-success",
    name: "内容接入提交跨 PostgreSQL、存储与 Redis 完整收口",
    script: join(isolationRoot, "ingestion-commit-success.mts")
  },
  {
    id: "commit-conflict",
    name: "内容接入提交保护不属于本次任务的正式对象",
    script: join(isolationRoot, "ingestion-commit-conflict.mts")
  },
  {
    id: "commit-recovery",
    name: "PostgreSQL 所有者冲突由持久 guard 补偿候选对象",
    script: join(isolationRoot, "ingestion-commit-recovery.mts")
  },
  {
    id: "ready-cache-read-model",
    name: "PostgreSQL ready 真相重建为 Redis 读模型并保持分页一致",
    script: join(isolationRoot, "ready-cache-read-model.mts")
  }
] as const;

const selectedDatabaseScenario = process.env.IMAGESHOW_DATABASE_SCENARIO;
const selectedStorageIngestionScenario = process.env.IMAGESHOW_STORAGE_INGESTION_SCENARIO;
const databaseScenarioIds = new Set([
  "schema-baseline",
  "storage-ingestion",
  "cold-redis",
  "readiness"
]);
const storageIngestionScenarioIds = new Set<string>(storageIngestionScenarios.map(({ id }) => id));
assert.ok(
  !selectedDatabaseScenario
    || databaseScenarioIds.has(selectedDatabaseScenario),
  `未知数据库集成场景：${selectedDatabaseScenario}`
);
assert.ok(
  !selectedStorageIngestionScenario
    || storageIngestionScenarioIds.has(selectedStorageIngestionScenario),
  `未知存储/接入集成场景：${selectedStorageIngestionScenario}`
);

const processRunner = createProcessRunner();
let activeTestInterruption: "SIGINT" | "SIGTERM" | null = null;
const terminateActiveTestProcesses = processRunner.terminateActiveProcesses;
const runProcess = (
  command: string,
  args: string[],
  options: ProcessRunOptions & {
    allowDuringInterrupt?: boolean;
  } = {}
): Promise<ProcessResult> => {
  const { allowDuringInterrupt, ...runOptions } = options;
  if (activeTestInterruption && !allowDuringInterrupt) {
    return Promise.reject(new Error(
      `${command} refused after ${activeTestInterruption}`
    ));
  }
  return processRunner.runProcess(command, args, runOptions);
};
test("[Server/数据库集成] 数据库以单一基线初始化空库并对现有库只读核对 readiness", async (context) => {
  const workspace = resolve(import.meta.dirname, "../../..");
  const container = `imageshow-final-db-${randomUUID()}`;
  const redisContainer = `imageshow-final-redis-${randomUUID()}`;
  const password = `contract-${randomUUID()}`;
  let helperRoot: string | null = null;
  let helperRootPromise: Promise<string> | null = null;
  let helperRemoved = false;
  let containerAttempted = false;
  let redisContainerAttempted = false;
  let cleanupPromise: Promise<void> | null = null;
  let interruptedCleanupPromise: Promise<void> | null = null;
  let handlingSignal = false;
  const processResultText = (result: ProcessResult) => (
    `${result.stderr}\n${result.stdout}`.trim()
  );
  const processNotFound = (result: ProcessResult) => (
    /no such container|not found/i.test(processResultText(result))
  );
  const performResourceCleanup = async () => {
    const errors: unknown[] = [];
    if (containerAttempted) {
      try {
        const removed = await runProcess("docker", ["rm", "--force", container], {
          allowDuringInterrupt: true,
          allowFailure: true,
          timeoutMs: 30_000
        });
        if (removed.code !== 0 && !processNotFound(removed)) {
          throw new Error(
            `无法删除隔离 PostgreSQL 容器 ${container}: ${processResultText(removed)}`
          );
        }
        const inspected = await runProcess(
          "docker",
          ["container", "inspect", container],
          {
            allowDuringInterrupt: true,
            allowFailure: true,
            timeoutMs: 15_000
          }
        );
        if (inspected.code === 0 || !processNotFound(inspected)) {
          throw new Error(
            `无法证明隔离 PostgreSQL 容器 ${container} 已删除: ${processResultText(inspected)}`
          );
        }
        containerAttempted = false;
      } catch (error) {
        errors.push(error);
      }
    }
    if (redisContainerAttempted) {
      try {
        const removed = await runProcess(
          "docker",
          ["rm", "--force", redisContainer],
          {
            allowDuringInterrupt: true,
            allowFailure: true,
            timeoutMs: 30_000
          }
        );
        if (removed.code !== 0 && !processNotFound(removed)) {
          throw new Error(
            `无法删除隔离 Redis 容器 ${redisContainer}: ${processResultText(removed)}`
          );
        }
        const inspected = await runProcess(
          "docker",
          ["container", "inspect", redisContainer],
          {
            allowDuringInterrupt: true,
            allowFailure: true,
            timeoutMs: 15_000
          }
        );
        if (inspected.code === 0 || !processNotFound(inspected)) {
          throw new Error(
            `无法证明隔离 Redis 容器 ${redisContainer} 已删除: ${processResultText(inspected)}`
          );
        }
        redisContainerAttempted = false;
      } catch (error) {
        errors.push(error);
      }
    }
    if (helperRootPromise && !helperRemoved) {
      try {
        helperRoot = await helperRootPromise;
        await rm(helperRoot, { recursive: true, force: true });
        helperRemoved = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "数据库契约测试资源清理失败");
    }
  };
  const cleanupResources = () => {
    cleanupPromise ??= (async () => {
      const terminationErrors: unknown[] = [];
      try {
        await terminateActiveTestProcesses();
      } catch (error) {
        terminationErrors.push(error);
      }
      let lastCleanupErrors: unknown[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await performResourceCleanup();
          lastCleanupErrors = [];
        } catch (error) {
          lastCleanupErrors = [error];
        }
        const resourcesConverged = !containerAttempted
          && !redisContainerAttempted
          && (!helperRootPromise || helperRemoved);
        if (resourcesConverged) {
          if (terminationErrors.length > 0) {
            throw new AggregateError(
              terminationErrors,
              "数据库契约测试进程终止失败"
            );
          }
          return;
        }
        if (attempt === 0) await delay(250);
      }
      throw new AggregateError(
        [...terminationErrors, ...lastCleanupErrors],
        "数据库契约测试资源清理在有界重试后仍失败"
      );
    })();
    return cleanupPromise;
  };
  const cleanupInterruptedResources = () => {
    interruptedCleanupPromise ??= (async () => {
      const errors: unknown[] = [];
      try {
        await cleanupResources();
      } catch (error) {
        errors.push(error);
      }
      try {
        await cleanupTestDirectories();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "数据库契约测试中断资源清理失败");
      }
    })();
    return interruptedCleanupPromise;
  };
  const handleTestSignal = (signal: "SIGINT" | "SIGTERM") => {
    if (handlingSignal) return;
    handlingSignal = true;
    activeTestInterruption = signal;
    sealTestDirectoryRegistrationForInterruption();
    void cleanupInterruptedResources().then(
      () => process.exit(signal === "SIGINT" ? 130 : 143),
      (error) => {
        console.error("数据库契约测试中断清理失败:", error);
        process.exit(1);
      }
    );
  };
  const onSigInt = () => handleTestSignal("SIGINT");
  const onSigTerm = () => handleTestSignal("SIGTERM");
  const onShutdownMessage = (message: unknown) => {
    if (
      typeof message === "object"
      && message !== null
      && "type" in message
      && message.type === "imageshow:shutdown"
      && "signal" in message
      && (message.signal === "SIGINT" || message.signal === "SIGTERM")
    ) {
      handleTestSignal(message.signal);
    }
  };
  // This scenario owns Docker resources that the shared helper runner cannot
  // release. Hand off the suite-level shutdown channel until its cleanup ends.
  const restoreSharedInterruptionHandling = suspendSharedTestInterruptionHandling();
  const inheritedSignalListeners = {
    SIGINT: process.listeners("SIGINT"),
    SIGTERM: process.listeners("SIGTERM")
  };
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);
  process.on("message", onShutdownMessage);
  process.channel?.unref();
  const onTestAbort = () => handleTestSignal("SIGTERM");
  context.signal.addEventListener("abort", onTestAbort, { once: true });
  const restoreSignalListeners = () => {
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    process.off("message", onShutdownMessage);
    context.signal.removeEventListener("abort", onTestAbort);
    for (const listener of inheritedSignalListeners.SIGINT) {
      process.on("SIGINT", listener);
    }
    for (const listener of inheritedSignalListeners.SIGTERM) {
      process.on("SIGTERM", listener);
    }
    restoreSharedInterruptionHandling();
  };
  const failHelperSetup = async (error: unknown): Promise<never> => {
    let cleanupError: unknown;
    try {
      await cleanupResources();
    } catch (caught) {
      cleanupError = caught;
    } finally {
      restoreSignalListeners();
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "数据库契约测试 helper 初始化及清理均失败"
      );
    }
    throw error;
  };

  try {
    helperRootPromise = createTestDirectory("imageshow-final-db-");
    helperRoot = await helperRootPromise;
  } catch (error) {
    await failHelperSetup(error);
  }
  const testRuntimeRoot = helperRoot ?? await failHelperSetup(
    new Error("数据库契约测试 helper 目录未创建")
  );


  const helper = join(isolationRoot, "initialize-schema.mts");
  const coldRedisHelper = join(isolationRoot, "cold-redis.mts");


  let port = 0;
  let redisPort = 0;
  const databaseName = (label: string) => (
    `imageshow_${label}_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  );
  const clientFor = (name: string) => new Client({
    connectionTimeoutMillis: 5_000,
    host: "127.0.0.1",
    lock_timeout: 5_000,
    port,
    query_timeout: 15_000,
    database: name,
    statement_timeout: 15_000,
    user: "postgres",
    password
  });
  const withClient = async <T>(
    name: string,
    work: (client: Client) => Promise<T>
  ) => {
    const client = clientFor(name);
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };
  const createDatabase = async (name: string) => {
    assert.match(name, /^[a-z0-9_]+$/);
    await withClient("postgres", async (client) => {
      await client.query(`CREATE DATABASE "${name}"`);
    });
  };
  const runTsx = (
    script: string,
    args: string[],
    allowFailure = false,
    timeoutMs = 60_000
  ) => runProcess(process.execPath, [
    resolve(workspace, "node_modules/tsx/dist/cli.mjs"),
    script,
    ...args
  ], {
      cwd: workspace,
      allowFailure,
      timeoutMs
  });
  const runTsxScenario = async (
    label: string,
    script: string,
    args: string[],
    timeoutMs: number
  ) => {
    try {
      return await runTsx(script, args, false, timeoutMs);
    } catch (error) {
      throw new Error(`隔离场景失败：${label}`, { cause: error });
    }
  };
  const initializeAs = async (
    name: string,
    user: string,
    userPassword: string,
    allowFailure = false
  ) => runTsx(
    helper,
    [
      "127.0.0.1",
      String(port),
      name,
      user,
      userPassword
    ],
    allowFailure
  );
  const initialize = async (name: string, allowFailure = false) => (
    initializeAs(name, "postgres", password, allowFailure)
  );
  const schemaDump = async (name: string) => {
    const dump = await runProcess("docker", [
      "exec",
      "-e",
      `PGPASSWORD=${password}`,
      container,
      "pg_dump",
      "-U",
      "postgres",
      "--schema-only",
      "--no-owner",
      "--no-privileges",
      name
    ]);
    return dump.stdout
      .replaceAll("\r\n", "\n")
      .split("\n")
      .filter((line) => !/^\\(?:un)?restrict\b/.test(line))
      .join("\n");
  };
  const dataDump = async (name: string) => {
    const dump = await runProcess("docker", [
      "exec",
      "-e",
      `PGPASSWORD=${password}`,
      container,
      "pg_dump",
      "-U",
      "postgres",
      "--data-only",
      "--column-inserts",
      "--no-owner",
      "--no-privileges",
      name
    ]);
    return dump.stdout
      .replaceAll("\r\n", "\n")
      .split("\n")
      .filter((line) => !/^\\(?:un)?restrict\b/.test(line))
      .join("\n");
  };
  const relationCount = (client: Client) => client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname NOT IN ('information_schema')
        AND left(namespace.nspname, 3) <> 'pg_'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`
  ).then((result) => Number(result.rows[0]?.count ?? -1));
  const quoteIdentifier = (value: string) => (
    `"${value.replaceAll('"', '""')}"`
  );
  const constraintName = async (
    client: Client,
    table: string,
    type: "p" | "u" | "f" | "c",
    columns: string[]
  ) => {
    const result = await client.query<{ constraint_name: string }>(
      `SELECT constraint_record.conname AS constraint_name
         FROM pg_constraint constraint_record
         JOIN pg_class relation ON relation.oid=constraint_record.conrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname='public'
          AND relation.relname=$1
          AND constraint_record.contype=$2
          AND ARRAY(
                SELECT attribute.attname
                  FROM unnest(constraint_record.conkey)
                    WITH ORDINALITY AS key(attnum, ordinal)
                  JOIN pg_attribute attribute
                    ON attribute.attrelid=constraint_record.conrelid
                   AND attribute.attnum=key.attnum
                 ORDER BY key.ordinal
              )::text[]=$3::text[]`,
      [table, type, columns]
    );
    assert.equal(result.rowCount, 1, `${table}(${columns.join(",")}) 约束不唯一`);
    return result.rows[0]!.constraint_name;
  };
  const uniqueIndexName = async (
    client: Client,
    table: string,
    columns: string[]
  ) => {
    const result = await client.query<{
      index_name: string;
      predicate: string | null;
    }>(
      `SELECT index_relation.relname AS index_name,
              pg_get_expr(
                index_record.indpred,
                index_record.indrelid,
                true
              ) AS predicate
         FROM pg_index index_record
         JOIN pg_class relation ON relation.oid=index_record.indrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         JOIN pg_class index_relation ON index_relation.oid=index_record.indexrelid
        WHERE namespace.nspname='public'
          AND relation.relname=$1
          AND index_record.indisunique
          AND NOT index_record.indisprimary
          AND ARRAY(
                SELECT attribute.attname
                  FROM unnest(index_record.indkey::smallint[])
                    WITH ORDINALITY AS key(attnum, ordinal)
                  JOIN pg_attribute attribute
                    ON attribute.attrelid=index_record.indrelid
                   AND attribute.attnum=key.attnum
                 WHERE key.ordinal <= index_record.indnkeyatts
                 ORDER BY key.ordinal
              )::text[]=$2::text[]`,
      [table, columns]
    );
    assert.equal(result.rowCount, 1, `${table}(${columns.join(",")}) 唯一索引不唯一`);
    return result.rows[0]!;
  };
  const publishedPort = async (name: string, containerPort: number) => {
    const result = await runProcess("docker", [
      "port", name, `${containerPort}/tcp`
    ]);
    const match = /^127\.0\.0\.1:(\d+)$/.exec(result.stdout.trim());
    assert.ok(match, "隔离容器必须发布到本机动态端口");
    return Number(match[1]);
  };
  const createCurrentDatabase = async (name: string) => {
    await createDatabase(name);
    await initialize(name);
  };
  const runDatabaseScenario = (
    id: string,
    name: string,
    timeout: number,
    work: (context: TestContext) => Promise<void>
  ) => context.test(name, {
    timeout,
    skip: Boolean(
      selectedDatabaseScenario && selectedDatabaseScenario !== id
    )
  }, work);

  try {
    await context.test("准备并等待隔离 PostgreSQL 与 Redis", {
      timeout: 180_000
    }, async () => {
      containerAttempted = true;
      await runProcess("docker", [
      "run",
      "-d",
      "--name",
      container,
      "--tmpfs",
      "/var/lib/postgresql:rw",
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "-p",
      "127.0.0.1::5432",
      "postgres:18"
    ], { timeoutMs: 120_000 });
    redisContainerAttempted = true;
    await runProcess("docker", [
      "run",
      "-d",
      "--name",
      redisContainer,
      "--tmpfs",
      "/data:rw",
      "-p",
      "127.0.0.1::6379",
      "redis:8",
      "--save",
      ""
    ], { timeoutMs: 120_000 });

    port = await publishedPort(container, 5432);
    redisPort = await publishedPort(redisContainer, 6379);

    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        await withClient("postgres", async (client) => {
          await client.query("SELECT 1");
        });
        ready = true;
        break;
      } catch {
        await delay(250);
      }
    }
    assert.equal(ready, true, "隔离 PostgreSQL 未按时就绪");
    let redisReady = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const ping = await runProcess(
        "docker",
        ["exec", redisContainer, "redis-cli", "ping"],
        { allowFailure: true, timeoutMs: 5_000 }
      );
      if (ping.code === 0 && ping.stdout.trim() === "PONG") {
        redisReady = true;
        break;
      }
      await delay(250);
    }
      assert.equal(redisReady, true, "隔离 Redis 未按时就绪");
    });

    await runDatabaseScenario(
      "schema-baseline",
      "空库基线可重复初始化并建立当前结构约束",
      120_000,
      async () => {
    const clean = databaseName("clean");
    let cleanTableNames: string[] = [];
    await createDatabase(clean);
    await initialize(clean);
    await initialize(clean);
    await initialize(clean);
    await withClient(clean, async (client) => {
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE'
          ORDER BY table_name`
      );
      cleanTableNames = tables.rows.map((row) => row.table_name);
      assert.ok(cleanTableNames.length > 0);
      const backgroundChecks = await client.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(constraint_record.oid, true) AS definition
           FROM pg_constraint constraint_record
           JOIN pg_class relation ON relation.oid=constraint_record.conrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='public'
            AND relation.relname='background_job'
            AND constraint_record.conname='background_job_current_type_check'`
      );
      assert.deepEqual(backgroundChecks.rows, [{
        definition: "CHECK (type = ANY (ARRAY['move.cleanup'::text, "
          + "'trash.purge'::text, 'cache.rebuild'::text]))"
      }]);
      const authorColumns = await client.query<{
        column_name: string;
        data_type: string;
      }>(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name='author'
            AND column_name IN ('identity_provider', 'identity_id')
          ORDER BY column_name`
      );
      assert.deepEqual(authorColumns.rows, [
        { column_name: "identity_id", data_type: "text" },
        { column_name: "identity_provider", data_type: "text" }
      ]);
      const purgeColumns = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name='metadata'
            AND column_name='purge_job_id'`
      );
      assert.deepEqual(purgeColumns.rows, [{
        column_name: "purge_job_id",
        data_type: "uuid",
        is_nullable: "YES"
      }]);
      const purgeChecks = await client.query<{
        definition: string;
        validated: boolean;
      }>(
        `SELECT pg_get_constraintdef(constraint_record.oid, true) AS definition,
                constraint_record.convalidated AS validated
           FROM pg_constraint constraint_record
           JOIN pg_class relation ON relation.oid=constraint_record.conrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='public'
            AND relation.relname='metadata'
            AND constraint_record.conname='metadata_purge_job_deleted_check'`
      );
      assert.equal(purgeChecks.rows.length, 1);
      assert.equal(purgeChecks.rows[0]?.validated, true);
      assert.match(
        purgeChecks.rows[0]?.definition ?? "",
        /purge_job_id IS NULL OR status = 'deleted'/i
      );
      const authorChecks = await client.query<{ constraint_name: string }>(
        `SELECT constraint_record.conname AS constraint_name
           FROM pg_constraint constraint_record
           JOIN pg_class relation ON relation.oid=constraint_record.conrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='public'
             AND relation.relname='author'
             AND constraint_record.contype='c'
             AND constraint_record.convalidated
             AND constraint_record.conname LIKE 'author_identity_%'
           ORDER BY constraint_record.conname`
      );
      assert.deepEqual(authorChecks.rows.map((row) => row.constraint_name), [
        "author_identity_id_nonempty_check",
        "author_identity_pair_check",
        "author_identity_provider_token_check"
      ]);
      const authorIdentityIndex = await uniqueIndexName(
        client,
        "author",
        ["identity_provider", "identity_id"]
      );
      assert.match(
        authorIdentityIndex.predicate ?? "",
        /identity_provider IS NOT NULL.*identity_id IS NOT NULL/i
      );

      await client.query(
        `INSERT INTO author(slug, identity_provider, identity_id)
         VALUES('identity-test-future', 'future-provider', '1234567890'),
               ('identity-test-weibo', 'weibo', '1234567890')`
      );
      for (const [slug, provider, identity, expected] of [
        ["identity-test-half", "weibo", null, "author_identity_pair_check"],
        ["identity-test-token", "Bad-Provider", "55", "author_identity_provider_token_check"],
        ["identity-test-empty", "weibo", "", "author_identity_id_nonempty_check"],
        ["identity-test-duplicate", "weibo", "1234567890", "idx_author_identity"]
      ] as const) {
        await assert.rejects(
          client.query(
            `INSERT INTO author(slug, identity_provider, identity_id)
             VALUES($1, $2, $3)`,
            [slug, provider, identity]
          ),
          (error: unknown) => (
            (error as { constraint?: string }).constraint === expected
          )
        );
      }
      await client.query("DELETE FROM author WHERE slug LIKE 'identity-test-%'");
    });
    });

    await runDatabaseScenario(
      "storage-ingestion",
      "Redis、存储与内容接入的具名跨域契约",
      300_000,
      async (storageContext) => {
        for (const scenario of storageIngestionScenarios) {
          await storageContext.test(scenario.name, {
            timeout: 90_000,
            skip: Boolean(
              selectedStorageIngestionScenario
                && selectedStorageIngestionScenario !== scenario.id
            )
          }, async () => {
            const integrationDatabase = databaseName(
              `storage_${scenario.id.replaceAll("-", "_")}`
            );
            await createCurrentDatabase(integrationDatabase);
            await runProcess("docker", [
              "exec",
              redisContainer,
              "redis-cli",
              "FLUSHDB"
            ]);
            const errors: unknown[] = [];
            try {
              await runTsxScenario(scenario.name, scenario.script, [
                "127.0.0.1",
                String(port),
                integrationDatabase,
                "postgres",
                password,
                // Native image I/O uses long paths; keep script entry paths in ordinary form for Node.
                toNamespacedPath(join(testRuntimeRoot, "runtime", scenario.id)),
                "127.0.0.1",
                String(redisPort)
              ], 75_000);
            } catch (error) {
              errors.push(error);
            }
            try {
              await runProcess("docker", [
                "exec",
                redisContainer,
                "redis-cli",
                "FLUSHDB"
              ]);
            } catch (error) {
              errors.push(error);
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) {
              throw new AggregateError(
                errors,
                `${scenario.name} 与 Redis 清理均失败`
              );
            }
          });
        }
      }
    );

    await runDatabaseScenario(
      "cold-redis",
      "Redis 丢失后从 PostgreSQL 正式真相冷启动",
      120_000,
      async () => {
    const coldRedisDatabase = databaseName("coldredis");
    await createDatabase(coldRedisDatabase);
    const coldRedisArgs = [
      "127.0.0.1",
      String(port),
      coldRedisDatabase,
      "postgres",
      password,
      toNamespacedPath(join(testRuntimeRoot, "cold-redis-runtime")),
      "127.0.0.1",
      String(redisPort)
    ];
    await runTsxScenario(
      "冷 Redis 准备",
      coldRedisHelper,
      ["seed", ...coldRedisArgs],
      60_000
    );
    const coldRedisPostgresBefore = await dataDump(coldRedisDatabase);
    const redisSizeBeforeFlush = await runProcess("docker", [
      "exec",
      redisContainer,
      "redis-cli",
      "-n",
      "0",
      "DBSIZE"
    ]);
    assert.ok(Number(redisSizeBeforeFlush.stdout.trim()) > 0);
    const flushed = await runProcess("docker", [
      "exec",
      redisContainer,
      "redis-cli",
      "-n",
      "0",
      "FLUSHDB"
    ]);
    assert.equal(flushed.stdout.trim(), "OK");
    const redisSizeAfterFlush = await runProcess("docker", [
      "exec",
      redisContainer,
      "redis-cli",
      "-n",
      "0",
      "DBSIZE"
    ]);
    assert.equal(redisSizeAfterFlush.stdout.trim(), "0");
    await runTsxScenario(
      "冷 Redis 恢复验证",
      coldRedisHelper,
      ["verify", ...coldRedisArgs],
      60_000
    );
    assert.equal(
      await dataDump(coldRedisDatabase),
      coldRedisPostgresBefore,
      "隔离 Redis FLUSHDB 冷启动不得改写 PostgreSQL 正式图片"
    );
    });

    await runDatabaseScenario(
      "readiness",
      "现有库 readiness 只读校验与失败回滚",
      180_000,
      async () => {
    const normalized = databaseName("normalized");
    await createCurrentDatabase(normalized);
    let currentTableNames: string[] = [];
    await withClient(normalized, async (client) => {
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE'
          ORDER BY table_name`
      );
      currentTableNames = tables.rows.map((row) => row.table_name);
      assert.ok(currentTableNames.length > 0);
      await client.query(`
        INSERT INTO tag(slug, display_name)
        VALUES('current', 'Current data');
        INSERT INTO author(
          slug,
          display_name,
          link,
          identity_provider,
          identity_id
        ) VALUES(
          'current-author',
          'Current author',
          'https://weibo.com/u/1234567890',
          'weibo',
          '1234567890'
        );
      `);
    });
    const normalizedBefore = await Promise.all([
      schemaDump(normalized),
      dataDump(normalized)
    ]);
    await initialize(normalized);
    assert.deepEqual(
      await Promise.all([schemaDump(normalized), dataDump(normalized)]),
      normalizedBefore,
      "已归一化非空库 readiness 不得写入结构或数据"
    );

    const missingPurgeOwner = databaseName("missingpurgeowner");
    await createCurrentDatabase(missingPurgeOwner);
    await withClient(missingPurgeOwner, async (client) => {
      await client.query(`
        ALTER TABLE metadata DROP COLUMN purge_job_id;
        INSERT INTO tag(slug, display_name)
        VALUES('missing-purge-owner-data', 'Must remain unchanged');
      `);
    });
    const missingPurgeOwnerBefore = await Promise.all([
      schemaDump(missingPurgeOwner),
      dataDump(missingPurgeOwner)
    ]);
    const missingPurgeOwnerResult = await initialize(missingPurgeOwner, true);
    assert.notEqual(missingPurgeOwnerResult.code, 0);
    assert.match(
      processResultText(missingPurgeOwnerResult),
      /required columns.*metadata\.purge_job_id/i
    );
    assert.deepEqual(
      await Promise.all([
        schemaDump(missingPurgeOwner),
        dataDump(missingPurgeOwner)
      ]),
      missingPurgeOwnerBefore,
      "缺少当前 purge 归属列时不得自动迁移或改写现有数据"
    );

    const missingAuthorIdentity = databaseName("missingauthoridentity");
    await createCurrentDatabase(missingAuthorIdentity);
    await withClient(missingAuthorIdentity, async (client) => {
      await client.query(`
        ALTER TABLE author
          DROP COLUMN identity_provider,
          DROP COLUMN identity_id;
        INSERT INTO tag(slug, display_name)
        VALUES('readiness-data', 'Must remain unchanged');
      `);
    });
    const missingAuthorIdentityBefore = await Promise.all([
      schemaDump(missingAuthorIdentity),
      dataDump(missingAuthorIdentity)
    ]);
    const missingAuthorIdentityResult = await initialize(
      missingAuthorIdentity,
      true
    );
    assert.notEqual(missingAuthorIdentityResult.code, 0);
    assert.match(
      processResultText(missingAuthorIdentityResult),
      /required columns.*author\.identity_provider.*author\.identity_id/i
    );
    assert.deepEqual(
      await Promise.all([
        schemaDump(missingAuthorIdentity),
        dataDump(missingAuthorIdentity)
      ]),
      missingAuthorIdentityBefore,
      "readiness 失败不得猜测补列或改写现有数据"
    );

    const unsupportedStorage = databaseName("storagetype");
    await createCurrentDatabase(unsupportedStorage);
    await withClient(unsupportedStorage, async (client) => {
      await client.query(`
        ALTER TABLE storage_backend
          DROP CONSTRAINT storage_backend_type_check;
        ALTER TABLE storage_backend
          ADD CONSTRAINT storage_backend_type_check
          CHECK (type IN ('local', 's3', 'unsupported'));
        INSERT INTO storage_backend(slug, display_name, type)
         VALUES('unsupported', 'Unsupported backend', 'unsupported');
      `);
    });
    const unsupportedSchemaBefore = await schemaDump(unsupportedStorage);
    const unsupportedDataBefore = await dataDump(unsupportedStorage);
    const unsupportedStorageResult = await initialize(unsupportedStorage, true);
    assert.notEqual(unsupportedStorageResult.code, 0);
    assert.match(
      processResultText(unsupportedStorageResult),
      /unsupported storage backend types: unsupported/i
    );
    assert.equal(await schemaDump(unsupportedStorage), unsupportedSchemaBefore);
    assert.equal(await dataDump(unsupportedStorage), unsupportedDataBefore);

    const unsupportedAuthorProvider = databaseName("authorprovider");
    await createCurrentDatabase(unsupportedAuthorProvider);
    await withClient(unsupportedAuthorProvider, async (client) => {
      await client.query(
        `INSERT INTO author(slug, identity_provider, identity_id)
         VALUES('future-author', 'future-provider', '1234567890')`
      );
    });
    const unsupportedAuthorBefore = await Promise.all([
      schemaDump(unsupportedAuthorProvider),
      dataDump(unsupportedAuthorProvider)
    ]);
    const unsupportedAuthorResult = await initialize(
      unsupportedAuthorProvider,
      true
    );
    assert.notEqual(unsupportedAuthorResult.code, 0);
    assert.match(
      processResultText(unsupportedAuthorResult),
      /unsupported author identity providers are present/i
    );
    assert.deepEqual(
      await Promise.all([
        schemaDump(unsupportedAuthorProvider),
        dataDump(unsupportedAuthorProvider)
      ]),
      unsupportedAuthorBefore
    );

    const incompatibleAuthorCheck = databaseName("authorcheck");
    await createCurrentDatabase(incompatibleAuthorCheck);
    await withClient(incompatibleAuthorCheck, async (client) => {
      await client.query(`
        ALTER TABLE author
          DROP CONSTRAINT author_identity_provider_token_check;
        ALTER TABLE author
          ADD CONSTRAINT author_identity_provider_token_check
          CHECK (identity_provider IS NULL OR char_length(identity_provider) <= 32);
        ALTER TABLE author
          DROP CONSTRAINT author_identity_pair_check;
        ALTER TABLE author
          ADD CONSTRAINT author_identity_pair_check
          CHECK (
            identity_provider IS NULL
            OR identity_id IS NULL
            OR identity_provider IS NOT NULL
            OR identity_id IS NOT NULL
          );
      `);
    });
    const incompatibleAuthorCheckResult = await initialize(
      incompatibleAuthorCheck,
      true
    );
    assert.notEqual(incompatibleAuthorCheckResult.code, 0);
    assert.match(
      processResultText(incompatibleAuthorCheckResult),
      /required CHECK constraints.*author identity null pairing.*author identity provider token/i
    );

    const incompatibleAuthorIdentityIndex = databaseName("authorindex");
    await createCurrentDatabase(incompatibleAuthorIdentityIndex);
    await withClient(incompatibleAuthorIdentityIndex, async (client) => {
      await client.query(`
        DROP INDEX public.idx_author_identity;
        CREATE UNIQUE INDEX idx_author_identity
          ON author(identity_provider, identity_id)
          WHERE identity_provider IS NOT NULL;
      `);
    });
    const incompatibleAuthorIndexResult = await initialize(
      incompatibleAuthorIdentityIndex,
      true
    );
    assert.notEqual(incompatibleAuthorIndexResult.code, 0);
    assert.match(
      processResultText(incompatibleAuthorIndexResult),
      /required unique indexes.*author\(identity_provider,\s*identity_id\)/i
    );

    const compatibleSuperset = databaseName("superset");
    await createCurrentDatabase(compatibleSuperset);
    await withClient(compatibleSuperset, async (client) => {
      await client.query(`
        CREATE TABLE deployment_owned_marker(
          id integer PRIMARY KEY,
          note text NOT NULL
        );
        INSERT INTO deployment_owned_marker(id, note)
        VALUES(1, 'must remain untouched');
      `);
    });
    const supersetBefore = await Promise.all([
      schemaDump(compatibleSuperset),
      dataDump(compatibleSuperset)
    ]);
    await initialize(compatibleSuperset);
    assert.deepEqual(
      await Promise.all([
        schemaDump(compatibleSuperset),
        dataDump(compatibleSuperset)
      ]),
      supersetBefore,
      "部署方额外对象不得被 readiness 改写"
    );

    const missingPrimaryKey = databaseName("primarykey");
    await createCurrentDatabase(missingPrimaryKey);
    await withClient(missingPrimaryKey, async (client) => {
      const name = await constraintName(
        client,
        "background_job",
        "p",
        ["id"]
      );
      await client.query(
        `ALTER TABLE background_job DROP CONSTRAINT ${quoteIdentifier(name)}`
      );
    });
    const missingPrimaryKeyResult = await initialize(missingPrimaryKey, true);
    assert.notEqual(missingPrimaryKeyResult.code, 0);
    assert.match(
      processResultText(missingPrimaryKeyResult),
      /required primary keys.*background_job\(id\)/i
    );

    const incompatibleUniqueIndex = databaseName("uniqueindex");
    await createCurrentDatabase(incompatibleUniqueIndex);
    await withClient(incompatibleUniqueIndex, async (client) => {
      const activeCacheRebuild = await uniqueIndexName(
        client,
        "background_job",
        ["type"]
      );
      assert.match(activeCacheRebuild.predicate ?? "", /cache\.rebuild/i);
      await client.query(`
        DROP INDEX public.${quoteIdentifier(activeCacheRebuild.index_name)};
        CREATE UNIQUE INDEX incomplete_active_cache_rebuild
          ON background_job(type)
          WHERE type='cache.rebuild' AND status='pending';
      `);
    });
    const incompatibleUniqueResult = await initialize(
      incompatibleUniqueIndex,
      true
    );
    assert.notEqual(incompatibleUniqueResult.code, 0);
    assert.match(
      processResultText(incompatibleUniqueResult),
      /required unique indexes.*background_job\(type\).*cache\.rebuild/i
    );

    const incompatibleForeignKey = databaseName("foreignkey");
    await createCurrentDatabase(incompatibleForeignKey);
    await withClient(incompatibleForeignKey, async (client) => {
      const name = await constraintName(
        client,
        "metadata",
        "f",
        ["author"]
      );
      await client.query(`
        ALTER TABLE metadata DROP CONSTRAINT ${quoteIdentifier(name)};
        ALTER TABLE metadata
          ADD CONSTRAINT incompatible_author_delete
          FOREIGN KEY(author) REFERENCES author(slug) ON DELETE RESTRICT;
      `);
    });
    const incompatibleForeignResult = await initialize(
      incompatibleForeignKey,
      true
    );
    assert.notEqual(incompatibleForeignResult.code, 0);
    assert.match(
      processResultText(incompatibleForeignResult),
      /required foreign keys.*metadata\(author\).*SET NULL/i
    );

    const missingTable = databaseName("missingtable");
    await createCurrentDatabase(missingTable);
    await withClient(missingTable, async (client) => {
      await client.query("DROP TABLE author CASCADE");
    });
    const missingTableResult = await initialize(missingTable, true);
    assert.notEqual(missingTableResult.code, 0);
    assert.match(
      processResultText(missingTableResult),
      /(?:required public tables.*author|relation "author" does not exist)/i
    );

    const missingColumn = databaseName("missingcolumn");
    await createCurrentDatabase(missingColumn);
    await withClient(missingColumn, async (client) => {
      await client.query(
        "ALTER TABLE admin_account DROP COLUMN password_hash CASCADE"
      );
    });
    const missingColumnResult = await initialize(missingColumn, true);
    assert.notEqual(missingColumnResult.code, 0);
    assert.match(
      processResultText(missingColumnResult),
      /required columns.*admin_account\.password_hash/i
    );

    const incompatiblePurgeCheck = databaseName("purgecheck");
    await createCurrentDatabase(incompatiblePurgeCheck);
    await withClient(incompatiblePurgeCheck, async (client) => {
      await client.query(`
        ALTER TABLE metadata
          DROP CONSTRAINT metadata_purge_job_deleted_check;
        ALTER TABLE metadata
          ADD CONSTRAINT metadata_purge_job_deleted_check
          CHECK (purge_job_id IS NULL OR status IN ('ready', 'deleted'));
      `);
    });
    const incompatiblePurgeCheckResult = await initialize(
      incompatiblePurgeCheck,
      true
    );
    assert.notEqual(incompatiblePurgeCheckResult.code, 0);
    assert.match(
      processResultText(incompatiblePurgeCheckResult),
      /required CHECK constraints.*metadata purge job requires deleted status/i
    );

    const incompatibleType = databaseName("columntype");
    await createCurrentDatabase(incompatibleType);
    await withClient(incompatibleType, async (client) => {
      await client.query(
        "ALTER TABLE tag ALTER COLUMN sort_order TYPE BIGINT"
      );
    });
    const incompatibleTypeResult = await initialize(incompatibleType, true);
    assert.notEqual(incompatibleTypeResult.code, 0);
    assert.match(
      processResultText(incompatibleTypeResult),
      /required columns.*tag\.sort_order/i
    );

    const incompatibleTypeModifier = databaseName("typemod");
    await createCurrentDatabase(incompatibleTypeModifier);
    await withClient(incompatibleTypeModifier, async (client) => {
      await client.query(
        "ALTER TABLE metadata ALTER COLUMN image_time TYPE timestamptz(0)"
      );
    });
    const incompatibleModifierResult = await initialize(
      incompatibleTypeModifier,
      true
    );
    assert.notEqual(incompatibleModifierResult.code, 0);
    assert.match(
      processResultText(incompatibleModifierResult),
      /required columns.*metadata\.image_time/i
    );

    const readOnlyDatabase = databaseName("readonly");
    await createCurrentDatabase(readOnlyDatabase);
    await withClient("postgres", async (client) => {
      await client.query(
        `ALTER DATABASE "${readOnlyDatabase}"
           SET default_transaction_read_only=on`
      );
    });
    const readOnlyResult = await initialize(readOnlyDatabase, true);
    assert.notEqual(readOnlyResult.code, 0);
    assert.match(
      processResultText(readOnlyResult),
      /transaction_read_only=on|read-only transaction/i
    );

    const insufficientPrivileges = databaseName("privileges");
    const limitedRole = `imageshow_limited_${randomUUID().replaceAll("-", "")}`;
    const limitedPassword = `limited-${randomUUID()}`;
    await createCurrentDatabase(insufficientPrivileges);
    await withClient(insufficientPrivileges, async (client) => {
      await client.query(
        `CREATE ROLE "${limitedRole}" LOGIN PASSWORD '${limitedPassword}'`
      );
      await client.query(
        `GRANT CONNECT ON DATABASE "${insufficientPrivileges}" TO "${limitedRole}"`
      );
      await client.query(`GRANT USAGE ON SCHEMA public TO "${limitedRole}"`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO "${limitedRole}"`
      );
    });
    const privilegeResult = await initializeAs(
      insufficientPrivileges,
      limitedRole,
      limitedPassword,
      true
    );
    assert.notEqual(privilegeResult.code, 0);
    assert.match(
      processResultText(privilegeResult),
      /lacks required table privileges/i
    );

    const invalidSeed = databaseName("seed");
    await createCurrentDatabase(invalidSeed);
    await withClient(invalidSeed, async (client) => {
      await client.query(`
        DELETE FROM ready_image_revision;
        DELETE FROM storage_backend WHERE slug='local';
      `);
    });
    const invalidSeedResult = await initialize(invalidSeed, true);
    assert.notEqual(invalidSeedResult.code, 0);
    const invalidSeedText = processResultText(invalidSeedResult);
    assert.match(invalidSeedText, /required seed rows/i);
    assert.match(invalidSeedText, /ready_image_revision singleton/i);
    assert.match(invalidSeedText, /storage_backend\.local/i);

    const rollback = databaseName("rollback");
    await createDatabase(rollback);
    await withClient(rollback, async (client) => {
      await client.query(`
        CREATE FUNCTION reject_schema_table() RETURNS event_trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'injected schema failure';
        END;
        $$;
        CREATE EVENT TRIGGER reject_schema_table
          ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
          EXECUTE FUNCTION reject_schema_table()
      `);
    });
    const rollbackResult = await initialize(rollback, true);
    assert.notEqual(rollbackResult.code, 0);
    assert.match(processResultText(rollbackResult), /injected schema failure/i);
    await withClient(rollback, async (client) => {
      assert.equal(await relationCount(client), 0);
      await client.query(`
        DROP EVENT TRIGGER reject_schema_table;
        DROP FUNCTION reject_schema_table();
      `);
    });
    await initialize(rollback);
    await withClient(rollback, async (client) => {
      const recoveredTables = await client.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE'`
      );
      assert.deepEqual(
        recoveredTables.rows.map((row) => row.table_name).sort(),
        currentTableNames,
        "失败启动回滚后必须能由下一次顺序启动恢复"
      );
    });
    });
  } finally {
    if (handlingSignal) {
      // The signal handler exits after this same complete Promise settles.
      // Do not restore the shared owner while directory cleanup is in flight.
      await cleanupInterruptedResources();
    } else {
      try {
        await cleanupResources();
      } finally {
        restoreSignalListeners();
      }
    }
  }
});
