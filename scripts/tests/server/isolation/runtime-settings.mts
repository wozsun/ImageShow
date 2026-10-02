import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { Hono } from "hono";
import type { RuntimeConfig } from "@imageshow/shared/browser";
import type { AdminSession } from "../../../../packages/server/src/core/http/admin-session-context.ts";
import { installProperties } from "../../support/property-descriptors.ts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
  const { registerSettingsRoutes } = await import("../../../../packages/server/src/routes/settings.ts");
  const { handleApiError } = await import("../../../../packages/server/src/core/http/responses.ts");
  const { requireAdminCsrf } = await import("../../../../packages/server/src/users/admin-session.ts");
  const { limitProtectedAdminRequestBody } = await import("../../../../packages/server/src/core/http/request-body-limit.ts");
  const { logger } = await import("../../../../packages/server/src/core/logger.ts");
  const store = runtime.runtimeConfigStore;
  const file = join(runtime.dataDirectory, "config.json");
  const persisted = async (): Promise<RuntimeConfig> => JSON.parse(await readFile(file, "utf8"));
  const app = new Hono<{ Variables: { session: AdminSession } }>();
  app.onError((error, context) => handleApiError(context, error));
  app.use("/api/admin/*", async (context, next) => {
    const role = context.req.header("x-test-role");
    if (role === "super" || role === "image") {
      context.set("session", {
        id: "synthetic-settings-session",
        username: "settings-admin",
        role,
        csrf: "synthetic-settings-csrf"
      });
    }
    await next();
  });
  app.use("/api/admin/*", (context, next) => context.req.method === "GET"
    ? next() : requireAdminCsrf(context, next));
  app.use("/api/admin/*", limitProtectedAdminRequestBody);
  registerSettingsRoutes(app as unknown as Hono);
  const request = (path: string, body?: unknown, role = "super", csrf = "synthetic-settings-csrf") =>
    app.request(`http://settings.example.test/api/admin/settings${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-test-role": role, "x-csrf-token": csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

  const save = (config: unknown, revision = store.runtimeConfigRevision()) => request("", { config, revision });
  const initial = structuredClone(store.getRuntimeConfig());
  for (const role of ["image", ""]) {
    assert.equal((await request("/runtime", undefined, role)).status, 403);
    assert.equal((await request("", initial, role)).status, 403);
    assert.equal((await request("/reload", {}, role)).status, 403);
  }
  assert.equal((await request("", initial, "super", "")).status, 403);
  assert.equal((await request("/reload", {}, "super", "")).status, 403);
  const read = await request("/runtime");
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "private, no-store");
  assert.deepEqual((await read.json()).config, initial);
  const ordinary = await request("", undefined, "image");
  assert.equal(ordinary.status, 200);
  assert.equal("security" in (await ordinary.json()).settings, false);

  const candidate = structuredClone(initial);
  candidate.site.description = "完整配置表单";
  candidate.site.home.enabled = false;
  candidate.site.show.mode = "float";
  candidate.embed = { enabled: true, allowed_origins: ["https://portal.example.test"] };
  candidate.ingestion.commit_concurrency = 12;
  candidate.upload.raw_concurrency = 4;
  candidate.import = { ...candidate.import, keep_original_link: [], auto_import: false, fetch_timeout_seconds: 60 };
  candidate.weibo = { ...candidate.weibo, source_enabled: false, request_delay_seconds: [0, 1] };
  candidate.normalize.large.quality = 79;
  candidate.admin.recent_uploads = 23;
  candidate.security.random_limit_max_requests = 15;
  candidate.altcha.counter_range = [1000, 3000];
  candidate.log.max_files = 8;
  const originalRevision = store.runtimeConfigRevision();
  const saved = await save(candidate, originalRevision);
  assert.equal(saved.status, 200);
  const response = await saved.json();
  assert.deepEqual(response.config, candidate);
  assert.equal(response.settings.admin.image_page_size, candidate.admin.image_page_size);
  assert.deepEqual(await persisted(), candidate);
  assert.deepEqual(store.getRuntimeConfig(), candidate);

  assert.equal(typeof response.revision, "string");
  assert.notEqual(response.revision, originalRevision);
  const stale = await save(initial, originalRevision);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "config_revision_conflict");
  assert.deepEqual(await persisted(), candidate);
  const concurrentRevision = store.runtimeConfigRevision();
  const writes = await Promise.all([
    save(initial, concurrentRevision), save(candidate, concurrentRevision)
  ]);
  assert.deepEqual(writes.map((value) => value.status).sort(), [200, 409]);
  await save(candidate);
  for (const body of [{ config: candidate }, { config: candidate, revision: "invalid" }]) {
    assert.equal((await request("", body)).status, 400);
  }

  for (const invalid of [
    {},
    { site: { title: "incomplete" } },
    { ...candidate, security: { ...candidate.security, random_max_requests: 0 } },
    { ...candidate, weibo: { ...candidate.weibo, request_delay_seconds: [5, 2] } },
    { ...candidate, unknown_group: true }
  ]) {
    assert.equal((await save(invalid)).status, 400);
    assert.deepEqual(store.getRuntimeConfig(), candidate);
    assert.deepEqual(await persisted(), candidate);
  }

  const open = fs.openSync;
  const restoreFs = installProperties(fs, {
    openSync(...args: Parameters<typeof fs.openSync>) {
      if (String(args[0]).endsWith(".tmp")) throw new Error("controlled settings write failure");
      return open(...args);
    }
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await save(initial)).status, 500);
    assert.deepEqual(store.getRuntimeConfig(), candidate);
    assert.deepEqual(await persisted(), candidate);
  } finally {
    restoreFs();
    syncBuiltinESMExports();
  }

  const disk = { ...candidate, site: { ...candidate.site, title: "磁盘标题", unknown_key: true } };
  await writeFile(file, JSON.stringify(disk));
  const reloaded = await request("/reload", {});
  assert.equal(reloaded.status, 200);
  const current = (await reloaded.json()).config;
  assert.equal(current.site.title, "磁盘标题");
  assert.deepEqual(await persisted(), current);
  assert.deepEqual(store.getRuntimeConfig(), current);
  assert.equal("unknown_key" in current.site, false);

  const notifications: string[] = [];
  const logs: string[] = [];
  const restoreLogger = installProperties(logger, { error: (message: string) => { logs.push(message); } });
  const removeFailing = store.onRuntimeConfigChange(() => { throw new Error("listener failed"); });
  const removeFollowing = store.onRuntimeConfigChange(() => {
    notifications.push(store.getRuntimeConfig().site.header_name);
  });
  try {
    await Promise.all([
      store.updateRuntimeConfig({ site: { header_name: "First write" } }),
      store.updateRuntimeConfig({ site: { header_name: "Second write" } })
    ]);
    assert.deepEqual(notifications, ["First write", "Second write"]);
    assert.equal(store.getRuntimeConfig().site.header_name, "Second write");
    assert.deepEqual(await persisted(), store.getRuntimeConfig());
    assert.equal(logs.filter((message) => message === "runtime_config_listener_failed").length, 2);
  } finally {
    removeFailing();
    removeFollowing();
    restoreLogger();
  }
});
