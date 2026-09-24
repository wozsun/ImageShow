import "../support/server-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { appConfig } from "../../../packages/shared/src/app-config.ts";
import {
  formatLogContext,
  safeLogText,
  safeLogValue
} from "../../../packages/shared/src/browser.ts";
import { configureRuntimeLogger, logger } from "../../../packages/server/src/core/logger.ts";
import { runtimePaths } from "../../../packages/server/src/config/bootstrap-env.ts";
import { handleApiError } from "../../../packages/server/src/core/http/responses.ts";
import { auditAdminMutation } from "../../../packages/server/src/core/audit-log.ts";
import { registerAdminLogRoutes } from "../../../packages/server/src/routes/admin-logs.ts";
import { installProperties } from "../support/property-descriptors.ts";
import { createTestDirectory } from "../support/test-directory.ts";
import { runProcess } from "../support/process-runner.ts";

test("[Server/日志] 脱敏凭据与命名空间并保留恢复定位和异常链", () => {
  const secret = "synthetic-private-value";
  const error = Object.assign(new Error("open failed at C:\\private folder\\source.jpg"), {
    code: "ENOENT",
    path: "C:\\private folder\\source.jpg",
    cause: new SyntaxError(`Unexpected token in ${secret} at position 12 (line 1 column 13)`),
    stack:
      "Error: private message\n    at load (file:///private/app/packages/server/src/read.ts:7:3)"
  });
  const context = {
    image_id: "00000000-0000-7000-8000-000000000001",
    transaction_id: "42",
    source_backend: "local",
    target_backend: "s3",
    candidates: [
      { backend: "s3", prefix: "full", key: "01/example.webp", namespace_identity: secret }
    ],
    session_id: secret,
    password: secret,
    secret_access_key: secret,
    authorization: `Bearer ${secret}`,
    nested: { original: `https://private.invalid/image?signature=${secret}`, request_body: secret },
    endpoint: `https://user:${secret}@store.invalid/private/image?key=${secret}#${secret}`,
    original_error: error
  };
  const text = formatLogContext(context);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes("private folder"), false);
  assert.equal(text.includes("/private/app"), false);
  const result = JSON.parse(text);
  assert.equal(result.image_id, context.image_id);
  assert.equal(result.transaction_id, "42");
  assert.equal(result.endpoint, "[url:https://store.invalid]");
  assert.equal(result.source_backend, "local");
  assert.equal(result.candidates[0].key, "01/example.webp");
  assert.equal(result.original_error.code, "ENOENT");
  assert.equal(result.original_error.cause.name, "SyntaxError");
  assert.equal(result.original_error.cause.position, "position 12 (line 1 column 13)");
  assert.deepEqual(result.original_error.stack, ["load (packages/server/src/read.ts:7:3)"]);
  assert.deepEqual(
    JSON.parse(formatLogContext(result)).original_error.stack,
    result.original_error.stack
  );
  assert.equal(context.session_id, secret);
  assert.equal(
    formatLogContext(new Error(`secret_access_key="${secret}"`)).includes(secret),
    false
  );
  for (const protocol of ["http", "https", "redis", "rediss", "postgres", "postgresql", "s3"]) {
    assert.equal(
      safeLogText(
        `request ${protocol}://user:${secret}@store.invalid/private?token=${secret} failed`
      ),
      `request [url:${protocol}://store.invalid] failed`
    );
  }
});

test("[Server/日志] 启动配置解析与校验失败经过清洗并有界退出", async () => {
  const directory = await createTestDirectory("logging-startup-");
  const invalidConfig = {
    ...appConfig.runtimeDefaults,
    log: { ...appConfig.runtimeDefaults.log, level: "leak-marker" }
  };
  for (const content of ["leak-marker", JSON.stringify(invalidConfig)]) {
    writeFileSync(join(directory, "config.json"), content);
    const result = await runProcess(
      process.execPath,
      [
        resolve("node_modules/tsx/dist/cli.mjs"),
        "--tsconfig",
        resolve("packages/server/tsconfig.check.json"),
        resolve("packages/server/src/index.ts")
      ],
      {
        env: {
          ...process.env,
          NODE_ENV: "development",
          IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: directory
        },
        allowFailure: true,
        timeoutMs: 15_000
      }
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /application startup failed/);
    assert.doesNotMatch(result.stderr, /application shutdown failed/);
    assert.equal((result.stdout + result.stderr).includes("leak-marker"), false);
    assert.equal((result.stdout + result.stderr).includes(directory), false);
    assert.equal(readFileSync(join(directory, "config.json"), "utf8"), content);
  }
});

test("[Server/日志] 循环、控制字符、访问器与大对象保持有界有效 JSON", () => {
  let accessorReads = 0;
  const object: Record<string, unknown> = {
    ok: 1,
    text: "before\n[ERROR] forged\r\u001b[31m\u2028after"
  };
  object.self = object;
  Object.defineProperty(object, "danger", {
    enumerable: true,
    get() {
      accessorReads++;
      throw new Error("synthetic");
    }
  });
  object.toJSON = () => {
    throw new Error("must not serialize source");
  };
  const text = formatLogContext(object);
  assert.equal(accessorReads, 0);
  assert.equal(JSON.parse(text).ok, 1);
  assert.match(text, /circular/);
  assert.doesNotMatch(text, /[\r\n\u001b\u2028]/);
  const large = formatLogContext(Array(100_000).fill("图".repeat(10_000)));
  assert.ok(Buffer.byteLength(large) <= 8_192);
  assert.doesNotThrow(() => JSON.parse(large));
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  assert.doesNotThrow(() => formatLogContext(revoked.proxy));
  const error = new Error("synthetic");
  Object.defineProperty(error, "stack", {
    get() {
      throw new Error("synthetic");
    }
  });
  assert.equal((safeLogValue(error) as Record<string, unknown>).message, "synthetic");
  assert.equal(
    formatLogContext({ name: "SyntaxError", message: "synthetic-private-value" }).includes(
      "synthetic-private-value"
    ),
    false
  );
});

test("[Server/日志] HTTP 日志生成服务端关联号、记录路由模板并统一文件与控制台输出", async (t) => {
  const lines: string[] = [];
  const capture = (chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  };
  const restoreOut = installProperties(process.stdout, { write: capture });
  const restoreErr = installProperties(process.stderr, { write: capture });
  configureRuntimeLogger(() => ({ ...appConfig.runtimeDefaults.log, level: "DEBUG" }));
  t.after(() => {
    restoreOut();
    restoreErr();
    configureRuntimeLogger(() => appConfig.runtimeDefaults.log);
  });
  const app = new Hono();
  app.onError((error, c) => handleApiError(c, error));
  app.use("*", auditAdminMutation);
  app.post("/synthetic/:id", () => {
    throw new Error("password=synthetic-private-value\nforged");
  });
  registerAdminLogRoutes(app);
  const response = await app.request(
    "http://example.invalid/synthetic/private-path?token=synthetic-private-value",
    {
      method: "POST",
      headers: { "x-request-id": "external-id" }
    }
  );
  assert.equal(response.status, 500);
  const requestId = response.headers.get("x-request-id");
  assert.ok(requestId && requestId !== "external-id");
  assert.equal(lines.length, 2);
  const contexts = lines.map((line) => JSON.parse(line.slice(line.indexOf("{"))));
  assert.deepEqual(
    contexts.map((context) => context.request_id),
    [requestId, requestId]
  );
  assert.deepEqual(
    contexts.map((context) => context.route),
    ["/synthetic/:id", "/synthetic/:id"]
  );
  assert.equal(lines.join("").includes("synthetic-private-value"), false);
  assert.equal(lines.join("").includes("private-path"), false);
  assert.equal(
    lines.every((line) => line.split("\n").length === 2),
    true
  );
  assert.ok(
    readFileSync(join(runtimePaths.logDirectory, "app.log"), "utf8").endsWith(lines.at(-1)!)
  );
  lines.length = 0;
  const report = await app.request("http://example.invalid/api/admin/logs/client-errors", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      context: "synthetic.operation",
      error: { name: "SyntaxError", message: "synthetic-private-value" },
      metadata: { token: "synthetic-private-value", image_id: "synthetic-image" }
    })
  });
  assert.equal(report.status, 200);
  assert.equal(lines.join("").includes("synthetic-private-value"), false);
  assert.ok(lines.join("").includes("synthetic-image"));
  configureRuntimeLogger(() => ({ ...appConfig.runtimeDefaults.log, level: "OFF" }));
  lines.length = 0;
  logger.error("synthetic disabled", new Error("not emitted"));
  assert.deepEqual(lines, []);
});
