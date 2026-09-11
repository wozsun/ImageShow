import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Hono } from "hono";
import type { AdminSession } from "../../../../packages/server/src/users/admin-session.ts";
import { installProperties } from "../../support/property-descriptors.ts";
import { withCommitFault } from "./database-faults.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { createS3HttpFixture } from "../../support/s3-http-fixture.ts";

await runIntegrationScenario(async (runtime) => {
  const s3 = await createS3HttpFixture();
  try {
  const { importConfigPackage } = await import(
    "../../../../packages/server/src/config/config-package.ts"
  );
  const { ApiError } = await import("../../../../packages/server/src/core/api-error.ts");
  const { logger } = await import("../../../../packages/server/src/core/logger.ts");
  const { registerAdvancedConfigRoutes } = await import(
    "../../../../packages/server/src/routes/advanced-config.ts"
  );
  const { handleApiError } = await import(
    "../../../../packages/server/src/core/http/responses.ts"
  );
  const { requireAdminCsrf } = await import(
    "../../../../packages/server/src/users/admin-session.ts"
  );
  const { limitProtectedAdminRequestBody } = await import(
    "../../../../packages/server/src/core/http/request-body-limit.ts"
  );
  const { appConfig } = await import("@imageshow/shared");
  const store = runtime.runtimeConfigStore;
  const baseline = structuredClone(store.getRuntimeConfig());
  const file = join(runtime.dataDirectory, "config.json");
  const persisted = async () => JSON.parse(await readFile(file, "utf8"));
  const backend = async (slug: string) => (await runtime.databasePools.pool.query(
    "SELECT config FROM storage_backend WHERE slug=$1", [slug]
  )).rows[0] ?? null;
  const input = (slug: string, name: string) => ({
    format: "future-format-is-only-a-hint",
    application_version: "99.0.0",
    config: { site: { name } },
    storage_backends: [{
      slug, display_name: slug, enabled: true, is_default: false,
      s3: {
        ...s3.settings,
        capabilities: { content_md5: false }
      }
    }]
  });
  const reset = async (slug: string) => {
    await runtime.databasePools.pool.query("DELETE FROM storage_backend WHERE slug=$1", [slug]);
    runtime.storageRegistry.invalidateStorageBackendRegistry();
    await store.replaceRuntimeConfig(baseline);
  };

  const rejectedPackage = input("probe-success", "Must remain unchanged");
  rejectedPackage.storage_backends.push({
    ...rejectedPackage.storage_backends[0]!, slug: "probe-failure",
    s3: { ...rejectedPackage.storage_backends[0]!.s3, root_path: "/fail" }
  });
  s3.state.putError = (request) => request.key.startsWith("fail/")
    ? { status: 403, code: "AccessDenied", message: "controlled import rejection" } : undefined;
  await assert.rejects(importConfigPackage(rejectedPackage, {}), { name: "AccessDenied" });
  assert.equal(await backend("probe-success"), null);
  assert.equal(await backend("probe-failure"), null);
  assert.deepEqual(store.getRuntimeConfig(), baseline);
  assert.deepEqual(await persisted(), baseline);
  assert.equal(s3.objects.size, 0);
  s3.state.putError = undefined;

  for (const mode of ["success", "rolled_back", "committed", "unknown"] as const) {
    const slug = `package-${mode.replaceAll("_", "-")}`;
    const names: string[] = [];
    const remove = store.onRuntimeConfigChange(() => names.push(store.getRuntimeConfig().site.name));
    try {
      await store.updateRuntimeConfig({ site: { description: "replace with defaults" } });
      names.length = 0;
      const operation = withCommitFault(runtime.databasePools.pool, mode,
        () => importConfigPackage(input(slug, mode), {}), async () => {
          assert.equal(store.getRuntimeConfig().site.name, baseline.site.name);
          assert.deepEqual(names, []);
          assert.equal((await persisted()).site.name, mode);
        });
      if (mode === "rolled_back") {
        await assert.rejects(operation, /controlled commit rollback/);
      } else if (mode === "unknown") {
        await assert.rejects(operation, (error: unknown) => error instanceof ApiError
          && error.status === 503 && error.code === "config_package_outcome_unknown"
          && typeof error.details === "object" && error.details !== null
          && "transaction_id" in error.details
          && typeof error.details.transaction_id === "string");
      } else await operation;
      if (mode === "rolled_back") {
        assert.deepEqual(names, []);
        assert.equal(store.getRuntimeConfig().site.name, baseline.site.name);
        assert.deepEqual(await persisted(), store.getRuntimeConfig());
        assert.equal(await backend(slug), null);
      } else {
        assert.deepEqual(names, [mode]);
        assert.equal(store.getRuntimeConfig().site.name, mode);
        assert.deepEqual(await persisted(), store.getRuntimeConfig());
        assert.equal(store.getRuntimeConfig().site.domain, baseline.site.domain);
        assert.equal(store.getRuntimeConfig().site.description, baseline.site.description);
        assert.equal((await backend(slug))?.config.secret_access_key ?? null,
          mode === "unknown" ? null : s3.settings.secret_access_key);
      }
    } finally { remove(); await reset(slug); }
  }

  for (const phase of ["write", "after-rename", "restore"] as const) {
    const slug = `package-${phase}`;
    const names: string[] = [];
    const remove = store.onRuntimeConfigChange(() => names.push(store.getRuntimeConfig().site.name));
    let injected = false;
    let restoring = false;
    const open = fs.openSync;
    const rename = fs.renameSync;
    const restore = installProperties(fs, {
      openSync(...args: Parameters<typeof fs.openSync>) {
        if (String(args[0]).endsWith(".tmp")
          && ((phase === "write" && !injected) || (phase === "restore" && restoring))) {
          injected = true;
          throw new Error("controlled config file failure");
        }
        return open(...args);
      },
      renameSync(...args: Parameters<typeof fs.renameSync>) {
        const result = rename(...args);
        if (phase === "after-rename" && !injected && String(args[1]) === file) {
          injected = true;
          throw new Error("controlled config durability failure");
        }
        return result;
      }
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(phase === "restore"
        ? withCommitFault(runtime.databasePools.pool, "rolled_back",
            () => importConfigPackage(input(slug, phase), {}), async () => { restoring = true; })
        : importConfigPackage(input(slug, phase), {}), (error: unknown) => phase === "restore"
          ? error instanceof ApiError && error.status === 503
            && error.code === "config_package_file_restore_failed"
            && typeof error.details === "object" && error.details !== null
            && "restore_error" in error.details && typeof error.details.restore_error === "string"
          : error instanceof Error && /controlled config/.test(error.message));
      assert.equal(injected, true);
      assert.deepEqual(names, []);
      assert.deepEqual(store.getRuntimeConfig(), baseline);
      assert.equal(await backend(slug), null);
      if (phase !== "restore") assert.deepEqual(await persisted(), baseline);
      else assert.equal((await persisted()).site.name, phase);
    } finally { restore(); syncBuiltinESMExports(); remove(); await reset(slug); }
  }

  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const importing = withCommitFault(runtime.databasePools.pool, "success",
    () => importConfigPackage(input("package-lease", "Lease Candidate"), {}), async () => {
      reached.resolve(); await gate.promise;
    });
  let reload: Promise<void> | undefined;
  try {
    await reached.promise;
    let settled = false;
    reload = store.reloadRuntimeConfigFromDisk().then(() => { settled = true; });
    await setImmediate();
    assert.equal(settled, false);
    assert.equal(store.getRuntimeConfig().site.name, baseline.site.name);
    gate.resolve();
    await Promise.all([importing, reload]);
    assert.equal(settled, true);
    assert.equal(store.getRuntimeConfig().site.name, "Lease Candidate");
  } finally {
    gate.resolve();
    await Promise.allSettled([importing, reload]);
    await reset("package-lease");
  }

  const logs: string[] = [];
  const restoreLogger = installProperties(logger, {
    error(message: string) { logs.push(message); }
  });
  let followingCalls = 0;
  const removeFailing = store.onRuntimeConfigChange(() => { throw new Error("listener failed"); });
  const removeFollowing = store.onRuntimeConfigChange(() => { followingCalls++; });
  try {
    await store.updateRuntimeConfig({ site: { name: "Listener Isolation" } });
    assert.equal(followingCalls, 1);
    assert.equal(store.getRuntimeConfig().site.name, "Listener Isolation");
    assert.deepEqual(await persisted(), store.getRuntimeConfig());
    assert.ok(logs.includes("runtime_config_listener_failed"));
  } finally { removeFailing(); removeFollowing(); restoreLogger(); await store.replaceRuntimeConfig(baseline); }

  const app = new Hono<{ Variables: { session: AdminSession } }>();
  app.onError((error, context) => handleApiError(context, error));
  app.use("/api/admin/*", async (context, next) => {
    const role = context.req.header("x-test-role");
    if (role === "super" || role === "image") context.set("session", {
      id: "config-route", username: "integration-admin", role, csrf: "config-csrf"
    });
    await next();
  });
  app.use("/api/admin/*", async (context, next) => context.req.method === "GET"
    ? next() : requireAdminCsrf(context, next));
  app.use("/api/admin/*", limitProtectedAdminRequestBody);
  registerAdvancedConfigRoutes(app as unknown as Hono);
  const request = (path: string, body?: unknown, role = "super", csrf = "config-csrf") => app.request(
    `http://imageshow.test/api/admin/advanced-config/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-test-role": role, "x-csrf-token": csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  for (const [path, body] of [
    ["export", undefined], ["preview", { package: {} }],
    ["import", { package: {}, slug_mappings: {} }]
  ] as const) {
    assert.equal((await request(path, body, "image")).status, 403);
    if (body) assert.equal((await request(path, body, "super", "")).status, 403);
  }
  const exported = await request("export");
  assert.equal(exported.status, 200);
  assert.equal(exported.headers.get("cache-control"), "private, no-store");
  const manifest = JSON.parse(await readFile(new URL("../../../../package.json", import.meta.url), "utf8"));
  assert.equal((await exported.json()).application_version, manifest.version);
  const content = "x".repeat(appConfig.configPackage.maxBytes - Buffer.byteLength(JSON.stringify({ content: "" })));
  assert.equal((await request("preview", { package: { content } })).status, 200);
  assert.equal((await request("preview", { package: { content: content + "x" } })).status, 413);
  assert.equal((await request("preview", { package: { storage_backends: Array(101).fill(null) } })).status, 400);
  await importConfigPackage(input("route-existing", "Existing"), {});
  await store.replaceRuntimeConfig(baseline);
  try {
    const response = await request("import", {
      package: input("route-existing", "Must Not Import"),
      slug_mappings: { "route-existing": "bad_slug" }
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "config_slug_mapping_invalid");
    assert.deepEqual(store.getRuntimeConfig(), baseline);
    assert.equal((await backend("route-existing"))?.config.secret_access_key, s3.settings.secret_access_key);
    assert.deepEqual((await backend("route-existing"))?.config.capabilities, { content_md5: true },
      "导入须按本次探測结果保存能力");
  } finally { await reset("route-existing"); }
  const imported = await request("import", {
    package: { config: { site: { name: "Imported Through Route" } } }, slug_mappings: {}
  });
  assert.equal(imported.status, 200);
  assert.equal(store.getRuntimeConfig().site.name, "Imported Through Route");
  } finally { await s3.close(); }
});
