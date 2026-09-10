import "../support/server-environment.ts";
import assert from "node:assert/strict";
import {
  randomUUID
} from "node:crypto";
import {
  rm,
  writeFile
} from "node:fs/promises";
import {
  join,
  resolve,
  toNamespacedPath
} from "node:path";
import {
  pathToFileURL
} from "node:url";
import test from "node:test";
import {
  createTestDirectory
} from "../support/test-directory.ts";
import {
  runProcess
} from "../support/process-runner.ts";
import {
  Hono
} from "hono";
import {
  adminImageListReadStartedAtHeader,
  adminPermissions
} from "../../../packages/shared/src/browser.ts";
import {
  imageUpdateInput,
  adminImageListQuery,
  galleryStatsQuery,
  listQuery
} from "../../../packages/server/src/routes/validation/images.ts";
import {
  parse
} from "../../../packages/server/src/routes/validation/parse.ts";
import {
  normalizePartialContentRange,
  parseSingleByteRange,
  totalSizeFromContentRange
} from "../../../packages/server/src/core/http/byte-range.ts";
import {
  finalizeSecurityHeaders
} from "../../../packages/server/src/core/http/headers.ts";
import {
  readJsonBody
} from "../../../packages/server/src/core/http/json-body.ts";
import {
  limitAdminLoginBody
} from "../../../packages/server/src/core/http/request-body-limit.ts";
import {
  assertSameOrigin,
  requestClientIp,
  requestIsSecure
} from "../../../packages/server/src/core/http/request-security.ts";
import {
  apiSuccessEtag,
  handleApiError,
  privateCacheableApiSuccess
} from "../../../packages/server/src/core/http/responses.ts";
import {
  auditAdminMutation,
  markAdminReadRequest
} from "../../../packages/server/src/core/audit-log.ts";
import {
  logger
} from "../../../packages/server/src/core/logger.ts";
import {
  proxyEtagForUpstream,
  proxyLastModified,
  upstreamIfModifiedSinceForProxy,
  upstreamIfNoneMatchForProxy
} from "../../../packages/server/src/core/http/proxy-validators.ts";
import {
  hashPassword,
  isCurrentPasswordHash,
  verifyPassword
} from "../../../packages/server/src/core/password.ts";
import {
  createPageWindow
} from "../../../packages/server/src/images/page-window.ts";
import {
  presentRandomJsonItems
} from "../../../packages/server/src/random/json-presentation.ts";
import {
  invalidateStorageBackendRegistry
} from "../../../packages/server/src/storage/backends/registry.ts";
import {
  parseReadyImageCacheItem,
  readyImageCacheItemFromRow,
  readyImageIdFromMember,
  readyImageMember,
  readyImageStatFields,
  readyImageThumbKey,
  serializeReadyImageCacheItem
} from "../../../packages/server/src/images/ready-cache/model.ts";
import {
  storageObjectKey
} from "../../../packages/server/src/storage/objects/image-paths.ts";
import {
  adminPermissionsForRole
} from "../../../packages/server/src/users/admin-authorization.ts";
import {
  authorizeAdminSessionCredentialTransition
} from "../../../packages/server/src/users/admin-session.ts";
import {
  closeAdminSessionConnections,
  closeAllAdminSessionConnections,
  registerAdminSessionConnection
} from "../../../packages/server/src/users/admin-session-connections.ts";
import {
  adminSessionKey,
  adminSessionKeyPattern
} from "../../../packages/server/src/users/admin-session-key.ts";
import {
  adminCredentialTransitionVersions,
  adminCredentialVersion,
  parseAdminCredentialVersions
} from "../../../packages/server/src/users/session-credential.ts";
import {
  adminSessionRedisClient,
  invalidateAllAdminSessions,
  invalidateCommittedAdminSessionsByUsername
} from "../../../packages/server/src/users/session-invalidation.ts";
import {
  imageId,
  servingReadyCacheItem
} from "../support/server-test-context.ts";
import {
  initializeRuntimeConfig
} from "../../../packages/server/src/config/runtime-config-store.ts";

test("[Server/HTTP 与鉴权] 主站 Host、图片路径与域名热加载遵循统一边界", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const helperRoot = await createTestDirectory("imageshow-host-boundary-");
  const helperPath = join(helperRoot, "verify-host-boundary.mjs");
  const runtimeConfigStoreUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/src/config/runtime-config-store.ts"
  )).href;
  const siteHostUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/src/config/site-host.ts"
  )).href;
  const httpAppUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/src/http-app.ts"
  )).href;
  const helperSource = `
import assert from "node:assert/strict";
import {
  getRuntimeConfig,
  initializeRuntimeConfig,
  updateRuntimeConfig
} from ${JSON.stringify(runtimeConfigStoreUrl)};
import { imageResourceBaseUrl } from ${JSON.stringify(siteHostUrl)};
import { createHttpApp } from ${JSON.stringify(httpAppUrl)};

initializeRuntimeConfig();
const config = getRuntimeConfig();
assert.equal(config.site.domain, "img.example.com");
assert.equal(imageResourceBaseUrl(), "https://img.example.com/images");

const app = createHttpApp({
  businessGateIsOpen: () => true,
  requireRedis: async () => undefined
});
async function status(host, path, method = "GET") {
  const response = await app.request(new Request(
    "http://internal.test" + path,
    { method, headers: { Host: host } }
  ));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return response.status;
}

assert.equal(await status("img.example.com", "/random", "POST"), 405);
assert.equal(await status("IMG.EXAMPLE.COM", "/api/ping", "OPTIONS"), 204);
for (const path of ["/images/full/example.webp", "/images/thumbs/example.webp"]) {
  assert.equal(await status("img.example.com", path, "OPTIONS"), 204);
}
for (const method of ["GET", "HEAD", "OPTIONS"]) {
  assert.equal(await status("img.example.com", "/images/original/not-a-uuid", method), method === "OPTIONS" ? 204 : 400);
  for (const host of ["unknown.img.example.com", "another.example.com"]) {
    for (const path of ["/", "/api/ping", "/images/original/not-a-uuid"]) {
      assert.equal(await status(host, path, method), 404, host + path + method);
    }
  }
}
for (const path of ["/unknown", "/images", "/images/original/", "/images/original/not-a-uuid/extra"]) {
  for (const method of ["GET", "HEAD", "POST"]) {
    assert.equal(await status("img.example.com", path, method), 404, path + method);
  }
}
assert.equal(await status("img.example.com", "/unknown", "OPTIONS"), 204);
for (const domain of ["img.example.com:5518", "local.example:5518"]) {
  await updateRuntimeConfig({ site: { domain } });
  assert.equal(imageResourceBaseUrl(), "https://" + domain + "/images");
  assert.equal(await status(domain, "/images/original/not-a-uuid"), 400);
  assert.equal(await status(domain.split(":")[0], "/images/original/not-a-uuid"), 404);
}
for (const domain of ["", "example.com"]) {
  await updateRuntimeConfig({ site: { domain } });
  assert.equal(imageResourceBaseUrl(), "/images");
  for (const host of ["localhost:5518", "127.0.0.1:5518", "first.example.com", "second.example.com:8443"]) {
    assert.equal(await status(host, "/api/ping", "OPTIONS"), 204, host);
    assert.equal(await status(host, "/images/original/not-a-uuid"), 400, host);
    const response = await app.request("http://internal.test/api/site-config", { headers: { Host: host } });
    assert.equal(response.status, 200);
    for (const scheme of ["http", "https"]) {
      assert.equal(new URL(imageResourceBaseUrl() + "/thumbs/test.webp", scheme + "://" + host).href,
        scheme + "://" + host + "/images/thumbs/test.webp");
    }
  }
  for (const host of ["", "bad host", "evil.test/path", "user@evil.test", "one.test,two.test", "local.test:0", "local.test:65536"]) {
    assert.equal(await status(host, "/api/ping", "OPTIONS"), 404, host);
  }
  const crossSite = await app.request("http://internal.test/api/ping", {
    method: "OPTIONS", headers: { Host: "localhost:5518", "Sec-Fetch-Site": "cross-site" }
  });
  assert.equal(crossSite.status, 403);
}
await updateRuntimeConfig({ site: { domain: "restored.example.com" } });
assert.equal(await status("localhost:5518", "/api/ping", "OPTIONS"), 404);
assert.equal(await status("restored.example.com", "/api/ping", "OPTIONS"), 204);
assert.equal(imageResourceBaseUrl(), "https://restored.example.com/images");
console.log("host-boundary-ok");
`;
  try {
    await writeFile(helperPath, helperSource);
    const result = await runProcess(process.execPath, [
      resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
      helperPath
    ], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "development",
        IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: toNamespacedPath(helperRoot),
        SITE_DOMAIN: "img.example.com"
      },
      timeoutMs: 30_000
    });
    assert.match(result.stdout, /host-boundary-ok/);
  } finally {
    await rm(helperRoot, { recursive: true, force: true });
  }
});
test("[Server/HTTP 与鉴权] 公开 cursor 与后台数字页使用严格且互斥的查询契约", () => {
  const publicBase = { view: "gallery", limit: "60" };
  const defaultPublicQuery = listQuery.parse({ ...publicBase, cursor: "opaque" });
  assert.equal(defaultPublicQuery.order, "latest");
  for (const order of ["latest", "oldest", "random"]) {
    assert.equal(listQuery.safeParse({ ...publicBase, order }).success, true);
  }
  assert.equal(adminImageListQuery.safeParse({ page: "100", limit: "60" }).success, true);
  const completeFilters = {
    device: "pc",
    brightness: "dark",
    theme: "stage",
    tag: "live",
    author: "alice"
  };
  assert.equal(listQuery.safeParse({ ...publicBase, ...completeFilters }).success, true);
  assert.equal(galleryStatsQuery.safeParse(completeFilters).success, true);
  assert.equal(adminImageListQuery.safeParse(completeFilters).success, true);

  for (const query of [
    { page: "2" },
    { offset: "60" },
    { unexpected: "true" }
  ]) {
    const result = listQuery.safeParse({ ...publicBase, ...query });
    assert.equal(result.success, false);
  }
  for (const query of [
    { cursor: "opaque" },
    { offset: "60" },
    { unexpected: "true" },
    { page: "0" },
    { page: "-1" },
    { page: "1.5" },
    { page: String(Number.MAX_SAFE_INTEGER + 1) }
  ]) {
    const result = adminImageListQuery.safeParse(query);
    assert.equal(result.success, false);
  }

  assert.deepEqual(createPageWindow(1, 60), {
    page: 1,
    limit: 60,
    start: 0,
    endExclusive: 60
  });
  assert.deepEqual(createPageWindow(100, 60), {
    page: 100,
    limit: 60,
    start: 5_940,
    endExclusive: 6_000
  });
  assert.throws(
    () => createPageWindow(Number.MAX_SAFE_INTEGER, 2),
    (error: { status?: number; code?: string }) => (
      error.status === 400 && error.code === "validation_error"
    )
  );
});
test("[Server/HTTP 与鉴权] 可信单跳入口忽略转发 Host 并只接受单值客户端 IP", async () => {
  const app = new Hono();
  app.onError((error, context) => handleApiError(context, error));
  app.get("/inspect", (context) => context.json({
    ip: requestClientIp(context),
    secure: requestIsSecure(context)
  }));
  app.post("/same-origin", (context) => {
    assertSameOrigin(context);
    return context.json({ ok: true });
  });

  const inspect = async (headers: Record<string, string>) => (
    await (await app.request(new Request("http://internal.test/inspect", {
      headers: {
        host: "img.example.com",
        ...headers
      }
    }))).json() as { ip: string; secure: boolean }
  );
  assert.deepEqual(await inspect({
    "x-forwarded-host": "attacker.example",
    "x-forwarded-proto": "https",
    "x-real-ip": "203.0.113.8",
    "x-forwarded-for": "198.51.100.4, 10.0.0.2"
  }), { ip: "203.0.113.8", secure: true });
  assert.deepEqual(await inspect({
    "x-forwarded-for": "198.51.100.4, 10.0.0.2"
  }), { ip: "unknown", secure: false });
  assert.deepEqual(await inspect({
    "x-forwarded-for": "198.51.100.4"
  }), { ip: "198.51.100.4", secure: false });
  assert.deepEqual(await inspect({
    "x-forwarded-proto": "https, http",
    "x-real-ip": "not-an-ip",
    "x-forwarded-for": "2001:db8::7"
  }), { ip: "2001:db8::7", secure: false });

  const sameOriginHeaders = {
    host: "img.example.com",
    origin: "https://img.example.com",
    "x-forwarded-host": "attacker.example",
    "x-forwarded-proto": "https"
  };
  assert.equal((await app.request(new Request(
    "http://internal.test/same-origin",
    { method: "POST", headers: sameOriginHeaders }
  ))).status, 200);
  assert.equal((await app.request(new Request(
    "http://internal.test/same-origin",
    {
      method: "POST",
      headers: {
        ...sameOriginHeaders,
        origin: "https://attacker.example"
      }
    }
  ))).status, 403);
});
test("[Server/HTTP 与鉴权] 写路由集中拒绝无效 JSON、未知字段和空更新且无副作用", async () => {
  const app = new Hono();
  const writes: string[] = [];
  const auditEntries: string[] = [];
  const originalInfo = logger.info;
  const originalWarn = logger.warn;
  logger.info = (message) => auditEntries.push(message);
  logger.warn = (message) => auditEntries.push(message);
  const imageId = randomUUID();
  app.onError((error, context) => handleApiError(context, error));
  app.use("/read", async (context, next) => {
    markAdminReadRequest(context);
    await next();
  });
  app.use("/*", auditAdminMutation);
  app.use("/write", limitAdminLoginBody);
  app.post("/write", async (context) => {
    const input = parse(
      imageUpdateInput,
      await readJsonBody(context)
    );
    writes.push(input.items[0]?.title ?? "");
    return context.json({ ok: true });
  });
  app.post("/read", (context) => context.json({ ok: true }));

  const request = (
    body: string,
    contentType = "application/json; charset=utf-8",
    signal?: AbortSignal
  ) => app.request(new Request("http://imageshow.test/write", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
    signal
  }));
  const expectFailure = async (
    response: Response,
    code: string
  ) => {
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { code?: string }).code, code);
    assert.deepEqual(writes, []);
    assert.deepEqual(auditEntries, []);
  };

  try {
    await expectFailure(await request("not json"), "invalid_json");
    await expectFailure(await request('{"title":"truncated'), "invalid_json");
    await expectFailure(await request(""), "invalid_json");
    await expectFailure(
      await request(JSON.stringify({
        items: [{ id: imageId, title: "wrong media type" }]
      }), "text/plain"),
      "invalid_json"
    );
    await expectFailure(
      await request(JSON.stringify({
        items: [{
          id: imageId,
          title: "value",
          unknown_title: "unknown"
        }]
      })),
      "validation_error"
    );
    await expectFailure(await request('{"items":[]}'), "validation_error");

    const abortController = new AbortController();
    abortController.abort();
    await expectFailure(await request(
      JSON.stringify({
        items: [{ id: imageId, title: "must not commit" }]
      }),
      "application/json",
      abortController.signal
    ), "invalid_json");

    const valid = await request(
      JSON.stringify({ items: [{ id: imageId, title: "committed" }] }),
      "application/vnd.imageshow+json"
    );
    assert.equal(valid.status, 200);
    assert.deepEqual(writes, ["committed"]);
    assert.deepEqual(auditEntries, ["admin action"]);
    const read = await app.request(new Request("http://imageshow.test/read", {
      method: "POST"
    }));
    assert.equal(read.status, 200);
    assert.deepEqual(auditEntries, ["admin action"]);
  } finally {
    logger.info = originalInfo;
    logger.warn = originalWarn;
  }
});
test("[Server/HTTP 与鉴权] 随机 JSON 卡片复用 canonical 字段且不额外读取详情", async () => {
  initializeRuntimeConfig();
  const item = servingReadyCacheItem({
    author: "photographer",
    title: "Random card"
  });
  let storageQueries = 0;
  const reader = {
    query: async () => {
      storageQueries += 1;
      return {
        rows: [{
          slug: "local",
          display_name: "Local",
          type: "local",
          config: {},
          enabled: true,
          is_default: true,
          namespace_identities: []
        }]
      };
    }
  } as never;
  invalidateStorageBackendRegistry();
  try {
    const [presented] = await presentRandomJsonItems(
      [item],
      undefined,
      { reader }
    );
    assert.equal(storageQueries, 1);
    assert.equal(presented.id, item.id);
    assert.equal(presented.title, "Random card");
    assert.equal(presented.author, "photographer");
    assert.equal(presented.diff_original, true);
    assert.match(presented.object_url, /\/full\//);
    assert.match(presented.thumb_url, /\/thumbs\//);
  } finally {
    invalidateStorageBackendRegistry();
  }
});
test("[Server/HTTP 与鉴权] Redis ready 投影、管理员权限和密码验证保留当前安全边界", async () => {
  const item = readyImageCacheItemFromRow({
    id: imageId,
    object_key: storageObjectKey(imageId, "avif"),
    ext: "avif",
    device: "pc",
    brightness: "dark",
    theme: null,
    storage_slug: "local",
    author: "alice",
    tags: ["stage", "concert", "stage"],
    width: 1920,
    height: 1080,
    image_size: 2048,
    cursor_image_time: "2026-08-04T12:00:00.654321Z",
    sort_score: "1785844800654321",
    title: "title",
    description: "description",
    source: "https://example.com/post",
    original: "https://example.com/image.jpg",
    md5: "0123456789abcdef0123456789abcdef",
    cursor_created_at: "2026-08-04T12:00:01.000Z",
    cursor_updated_at: "2026-08-04T12:00:02.000Z"
  });
  assert.deepEqual(item.tags, ["concert", "stage"]);
  assert.deepEqual(parseReadyImageCacheItem(serializeReadyImageCacheItem(item)), item);
  const member = readyImageMember(imageId);
  assert.equal(readyImageIdFromMember(member), imageId);
  assert.equal(readyImageThumbKey(item), storageObjectKey(imageId, "webp"));
  assert.deepEqual(readyImageStatFields(item), [
    "total",
    "device:pc",
    "brightness:dark",
    "axis:pc:dark",
    "theme:~unset",
    "tag:concert",
    "tag:stage",
    "author:alice"
  ]);
  assert.equal(parseReadyImageCacheItem("not-json"), null);

  assert.deepEqual(
    adminPermissionsForRole("super").sort(),
    Object.values(adminPermissions).sort()
  );
  assert.deepEqual(adminPermissionsForRole("image"), []);

  const password = "ImageShow-final-version-password";
  const encoded = await hashPassword(password);
  assert.match(encoded, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
  assert.equal(await verifyPassword(encoded, password), true);
  assert.equal(await verifyPassword(encoded, password + "-wrong"), false);
  assert.equal(isCurrentPasswordHash(encoded), true);
  assert.equal(isCurrentPasswordHash("invalid"), false);

  const malformedHash = "$argon2id$v=19$m=65536,t=3,p=4$"
    + "AAAAAAAAAAAAAAAAAAAAAA$"
    + "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(isCurrentPasswordHash(malformedHash), false);
  assert.equal(await verifyPassword(malformedHash, password), false);
});
test("[Server/HTTP 与鉴权] 管理员会话只接受当前 namespace 和严格的一至两个凭据代际", async () => {
  const initialVersion = adminCredentialVersion("initial-password-hash");
  const firstVersion = adminCredentialVersion("first-password-hash");
  const secondVersion = adminCredentialVersion("second-password-hash");
  const thirdVersion = adminCredentialVersion("third-password-hash");
  assert.equal(firstVersion.length, 43);
  assert.deepEqual(parseAdminCredentialVersions([firstVersion]), [firstVersion]);
  assert.deepEqual(
    parseAdminCredentialVersions([firstVersion, secondVersion]),
    [firstVersion, secondVersion]
  );
  assert.deepEqual(
    adminCredentialTransitionVersions(
      "first-password-hash",
      secondVersion
    ),
    [firstVersion, secondVersion]
  );
  assert.notDeepEqual(
    adminCredentialTransitionVersions(
      "first-password-hash",
      secondVersion
    ),
    [initialVersion, secondVersion],
    "等待行锁后的第二次改密必须使用锁内最新代际"
  );
  for (const invalid of [
    undefined,
    null,
    [],
    ["invalid"],
    [firstVersion, firstVersion],
    [firstVersion, secondVersion, adminCredentialVersion("third")],
    [firstVersion, 7]
  ]) {
    assert.equal(parseAdminCredentialVersions(invalid), null);
  }

  assert.equal(adminSessionKey("session-id"), "imageshow:session:session-id");
  assert.equal(adminSessionKeyPattern, "imageshow:session:*");

  const authenticatedSession = {
    id: "authenticated-session",
    username: "alice",
    csrf: "csrf-token",
    role: "image" as const
  };
  const strictSessionPayload = (credentialVersions: string[]) => JSON.stringify({
    username: authenticatedSession.username,
    csrf: authenticatedSession.csrf,
    role: authenticatedSession.role,
    credential_versions: credentialVersions
  });
  let currentSessionPayload = strictSessionPayload([initialVersion]);
  const replacedSnapshots: string[] = [];
  const transitionStore = {
    async readSession(id: string) {
      assert.equal(id, authenticatedSession.id);
      return currentSessionPayload;
    },
    async replaceSessionSnapshot(
      id: string,
      expectedPayload: string,
      nextPayload: string
    ) {
      assert.equal(id, authenticatedSession.id);
      if (currentSessionPayload !== expectedPayload) return false;
      replacedSnapshots.push(expectedPayload);
      currentSessionPayload = nextPayload;
      return true;
    }
  };
  await authorizeAdminSessionCredentialTransition(
    authenticatedSession,
    adminCredentialTransitionVersions(
      "initial-password-hash",
      firstVersion
    ),
    transitionStore
  );
  assert.deepEqual(
    JSON.parse(currentSessionPayload).credential_versions,
    [initialVersion, firstVersion]
  );
  await authorizeAdminSessionCredentialTransition(
    authenticatedSession,
    adminCredentialTransitionVersions(
      "first-password-hash",
      secondVersion
    ),
    transitionStore
  );
  assert.deepEqual(
    JSON.parse(currentSessionPayload).credential_versions,
    [firstVersion, secondVersion],
    "合法连续改密必须使用行锁后的最新 stale 代际"
  );
  assert.equal(replacedSnapshots.length, 2);

  currentSessionPayload = strictSessionPayload([initialVersion]);
  await assert.rejects(
    authorizeAdminSessionCredentialTransition(
      authenticatedSession,
      adminCredentialTransitionVersions(
        "first-password-hash",
        secondVersion
      ),
      transitionStore
    ),
    (error: unknown) => (
      (error as { code?: string }).code === "unauthorized"
    ),
    "相同明文 reset 或同名重建后，stale 会话不得绑定新行锁代际"
  );
  assert.equal(
    currentSessionPayload,
    strictSessionPayload([initialVersion])
  );

  const snapshotRaceStore = {
    async readSession() {
      return strictSessionPayload([initialVersion]);
    },
    async replaceSessionSnapshot() {
      return false;
    }
  };
  await assert.rejects(
    authorizeAdminSessionCredentialTransition(
      authenticatedSession,
      adminCredentialTransitionVersions(
        "initial-password-hash",
        firstVersion
      ),
      snapshotRaceStore
    ),
    (error: unknown) => (
      (error as { code?: string }).code === "unauthorized"
    ),
    "读取后 payload 变化时必须拒绝盲写"
  );

  const preservedKey = adminSessionKey("preserved");
  const staleKey = adminSessionKey("stale");
  const transitionedKey = adminSessionKey("transitioned");
  const otherUserKey = adminSessionKey("other-user");
  const currentKeys = [preservedKey, staleKey, transitionedKey, otherUserKey];
  const payloads = new Map([
    [preservedKey, JSON.stringify({
      username: "alice",
      credential_versions: [firstVersion]
    })],
    [staleKey, JSON.stringify({
      username: "alice",
      credential_versions: [firstVersion]
    })],
    [transitionedKey, JSON.stringify({
      username: "alice",
      credential_versions: [firstVersion, secondVersion]
    })],
    [otherUserKey, JSON.stringify({
      username: "bob",
      credential_versions: [firstVersion]
    })]
  ]);
  const removed: string[] = [];
  const closedSessionConnections: string[] = [];
  for (const sessionId of ["preserved", "stale", "transitioned", "other-user"]) {
    registerAdminSessionConnection({
      sessionId,
      close: () => closedSessionConnections.push(sessionId)
    });
  }
  const client = {
    async scanSessions(cursor: string, pattern: string, count: number) {
      assert.equal(cursor, "0");
      assert.equal(pattern, adminSessionKeyPattern);
      assert.equal(count, 100);
      return ["0", currentKeys] as [string, string[]];
    },
    async readSessions(keys: string[]) {
      return keys.map((key) => payloads.get(key) ?? null);
    },
    async unlinkSessionsIfUnchanged(
      snapshots: Array<{ key: string; value: string }>
    ) {
      const targets = snapshots.filter(({ key, value }) => (
        payloads.get(key) === value
      ));
      removed.push(...targets.map(({ key }) => key));
      return targets;
    },
    async unlinkSessions(keys: string[]) {
      removed.push(...keys);
      return keys.length;
    }
  };
  assert.equal(await invalidateCommittedAdminSessionsByUsername(
    client,
    "alice",
    {
      operation: "password_change",
      preservedSessionId: "preserved",
      staleCredentialVersion: firstVersion,
      validCredentialVersion: secondVersion
    }
  ), 1);
  assert.deepEqual(removed, [staleKey]);
  assert.deepEqual(closedSessionConnections, ["stale"]);

  removed.length = 0;
  assert.equal(await invalidateAllAdminSessions(client), currentKeys.length);
  assert.deepEqual(removed, currentKeys);
  assert.deepEqual(
    new Set(closedSessionConnections),
    new Set(["stale", "preserved", "transitioned", "other-user"])
  );
  assert.equal(closeAllAdminSessionConnections(), 0);

  const racingKey = adminSessionKey("racing-transition");
  const stalePayload = JSON.stringify({
    username: "alice",
    credential_versions: [firstVersion]
  });
  const transitionedPayload = JSON.stringify({
    username: "alice",
    credential_versions: [firstVersion, secondVersion]
  });
  const racingPayloads = new Map([[racingKey, stalePayload]]);
  const racingRemoved: string[] = [];
  const racingClosed: string[] = [];
  registerAdminSessionConnection({
    sessionId: "racing-transition",
    close: () => racingClosed.push("racing-transition")
  });
  const racingClient = {
    async scanSessions() {
      return ["0", [racingKey]] as [string, string[]];
    },
    async readSessions(keys: string[]) {
      const snapshot = keys.map((key) => racingPayloads.get(key) ?? null);
      racingPayloads.set(racingKey, transitionedPayload);
      return snapshot;
    },
    async unlinkSessionsIfUnchanged(
      snapshots: Array<{ key: string; value: string }>
    ) {
      const targets = snapshots.filter(({ key, value }) => (
        racingPayloads.get(key) === value
      ));
      racingRemoved.push(...targets.map(({ key }) => key));
      return targets;
    },
    async unlinkSessions(keys: string[]) {
      racingRemoved.push(...keys);
      return keys.length;
    }
  };
  assert.equal(await invalidateCommittedAdminSessionsByUsername(
    racingClient,
    "alice",
    {
      operation: "password_change",
      preservedSessionId: "preserved",
      staleCredentialVersion: firstVersion,
      validCredentialVersion: secondVersion
    }
  ), 0);
  assert.deepEqual(racingRemoved, []);
  assert.equal(racingPayloads.get(racingKey), transitionedPayload);
  assert.deepEqual(racingClosed, []);
  assert.equal(
    closeAdminSessionConnections(["racing-transition"]),
    1,
    "条件删除未命中的有效会话连接必须保持打开"
  );

  const delayedKey = adminSessionKey("later-generation");
  const delayedPayload = JSON.stringify({
    username: "alice",
    credential_versions: [secondVersion, thirdVersion]
  });
  let delayedUnlinkCalls = 0;
  const delayedClient = {
    async scanSessions() {
      return ["0", [delayedKey]] as [string, string[]];
    },
    async readSessions() {
      return [delayedPayload];
    },
    async unlinkSessionsIfUnchanged(
      snapshots: Array<{ key: string; value: string }>
    ) {
      delayedUnlinkCalls += 1;
      return snapshots;
    },
    async unlinkSessions(keys: string[]) {
      return keys.length;
    }
  };
  assert.equal(await invalidateCommittedAdminSessionsByUsername(
    delayedClient,
    "alice",
    {
      operation: "password_change",
      preservedSessionId: "preserved",
      staleCredentialVersion: initialVersion,
      validCredentialVersion: firstVersion
    }
  ), 0);
  assert.equal(await invalidateCommittedAdminSessionsByUsername(
    delayedClient,
    "alice",
    {
      operation: "password_reset",
      staleCredentialVersion: initialVersion,
      validCredentialVersion: firstVersion
    }
  ), 0);
  assert.equal(await invalidateCommittedAdminSessionsByUsername(
    delayedClient,
    "alice",
    {
      operation: "account_delete",
      staleCredentialVersion: initialVersion
    }
  ), 0);
  assert.equal(
    delayedUnlinkCalls,
    0,
    "stale 清理不得选择已跨过其代际的新会话或同名重建会话"
  );

  const delexCalls: string[][] = [];
  const adapter = adminSessionRedisClient({
    async scan() {
      return ["0", []] as [string, string[]];
    },
    async mget() {
      return [];
    },
    async unlink() {
      return 0;
    },
    pipeline: () => ({
      call(command: string, ...arguments_: string[]) {
        delexCalls.push([command, ...arguments_]);
      },
      async exec(): Promise<Array<[Error | null, unknown]>> {
        return [[null, 0], [null, 1]];
      }
    })
  });
  assert.deepEqual(await adapter.unlinkSessionsIfUnchanged([
    { key: staleKey, value: stalePayload },
    { key: racingKey, value: transitionedPayload }
  ]), [{ key: racingKey, value: transitionedPayload }]);
  assert.deepEqual(delexCalls, [
    ["DELEX", staleKey, "IFEQ", stalePayload],
    ["DELEX", racingKey, "IFEQ", transitionedPayload]
  ]);
});
test("[Server/HTTP 与鉴权] HTTP 范围、缓存验证器和安全响应头遵循当前协议", async () => {
  assert.deepEqual(parseSingleByteRange("bytes=0-9", 100), { start: 0, end: 9 });
  assert.deepEqual(parseSingleByteRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.deepEqual(parseSingleByteRange("bytes=95-", 100), { start: 95, end: 99 });
  assert.throws(() => parseSingleByteRange("bytes=100-101", 100));
  assert.equal(normalizePartialContentRange("bytes 0-9/100"), "bytes 0-9/100");
  assert.equal(totalSizeFromContentRange("bytes */100"), 100);

  const url = "https://images.example.com/image.jpg";
  const upstreamEtag = '"upstream-v1"';
  const proxyEtag = proxyEtagForUpstream(url, upstreamEtag);
  assert.match(proxyEtag ?? "", /^W\/"imageshow-proxy\./);
  assert.equal(upstreamIfNoneMatchForProxy(url, proxyEtag), upstreamEtag);
  assert.equal(
    upstreamIfNoneMatchForProxy("https://images.example.com/other.jpg", proxyEtag),
    undefined
  );
  assert.equal(proxyLastModified(
    "Mon, 08 Jul 2013 18:06:40 GMT",
    "2026-08-07T10:00:00.500Z",
    Date.parse("2026-08-07T12:00:00Z")
  ), "Fri, 07 Aug 2026 10:00:01 GMT");
  assert.equal(upstreamIfModifiedSinceForProxy(
    "Fri, 07 Aug 2026 11:00:00 GMT",
    "2026-08-07T10:00:00Z",
    Date.parse("2026-08-07T12:00:00Z")
  ), "Fri, 07 Aug 2026 11:00:00 GMT");

  const app = new Hono();
  app.use("*", async (context, next) => {
    await next();
    finalizeSecurityHeaders(context);
  });
  app.get("/", (context) => context.text("ok"));
  app.get("/preferences", (context) => {
    context.header(adminImageListReadStartedAtHeader, "123");
    return privateCacheableApiSuccess(context, {
      preferences: { admin_scheme: "dark" }
    });
  });
  const response = await app.request("http://imageshow.test/");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("permissions-policy"), null);
  const preferences = await app.request("http://imageshow.test/preferences");
  const preferenceEtag = preferences.headers.get("etag");
  assert.equal(preferences.status, 200);
  assert.equal(preferences.headers.get(adminImageListReadStartedAtHeader), "123");
  assert.equal(preferences.headers.get("cache-control"), "private, no-cache");
  assert.match(preferenceEtag ?? "", /^W\//u);
  assert.equal(preferenceEtag, apiSuccessEtag({
    preferences: { admin_scheme: "dark" }
  }), "认证首帧可复用完全相同的偏好表示验证器");
  assert.deepEqual(await preferences.json(), {
    ok: true,
    preferences: { admin_scheme: "dark" }
  });
  const unchangedPreferences = await app.request(
    "http://imageshow.test/preferences",
    { headers: { "If-None-Match": preferenceEtag ?? "" } }
  );
  assert.equal(unchangedPreferences.status, 304);
  assert.equal(
    unchangedPreferences.headers.get(adminImageListReadStartedAtHeader),
    "123"
  );
  assert.equal(unchangedPreferences.headers.get("etag"), preferenceEtag);
  assert.equal(await unchangedPreferences.text(), "");

});
test("[Server/HTTP 与鉴权] 日志尾读循环读取实际字节并区分缺失与 I/O 错误", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const helperRoot = await createTestDirectory("imageshow-log-tail-");
  const helperPath = join(helperRoot, "verify-log-tail.mjs");
  const runtimeConfigStoreUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/src/config/runtime-config-store.ts"
  )).href;
  const logFilesUrl = pathToFileURL(resolve(
    repositoryRoot,
    "packages/server/src/core/log-files.ts"
  )).href;
  const helperSource = `
import assert from "node:assert/strict";
import { mkdir, open, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initializeRuntimeConfig } from ${JSON.stringify(runtimeConfigStoreUrl)};
import { readRecentLogFile } from ${JSON.stringify(logFilesUrl)};

const root = process.env.IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY;
assert.ok(root);
initializeRuntimeConfig();
const logDirectory = join(root, "log");
const logPath = join(logDirectory, "app.log");

const missing = await readRecentLogFile({});
assert.deepEqual(missing.files, []);
assert.equal(missing.content, "");
assert.equal(missing.bytes_read, 0);

await writeFile(logDirectory, "not a directory");
await assert.rejects(
  readRecentLogFile({}),
  (error) => error?.code === "ENOTDIR"
);
await rm(logDirectory, { force: true });
await mkdir(logDirectory, { recursive: true });

const payload = Array.from({ length: 2_048 }, (_, index) =>
  String.fromCharCode(65 + (index % 26))
).join("");
await writeFile(logPath, payload);
const probe = await open(logPath, "r");
const fileHandlePrototype = Object.getPrototypeOf(probe);
const originalRead = fileHandlePrototype.read;
await probe.close();
const originalEmit = fileHandlePrototype.emit;
let closeEvents = 0;
fileHandlePrototype.emit = function (event, ...args) {
  if (event === "close") closeEvents += 1;
  return originalEmit.call(this, event, ...args);
};

let shortReadCalls = 0;
fileHandlePrototype.read = function (buffer, offset, length, position) {
  shortReadCalls += 1;
  return originalRead.call(this, buffer, offset, Math.min(length, 7), position);
};
const closeEventsBeforeShortRead = closeEvents;
try {
  const result = await readRecentLogFile({ file: "app.log", limit: "1000" });
  assert.equal(result.truncated, true);
  assert.equal(result.bytes_read, 1_000);
  assert.equal(result.content, payload.slice(-1_000));
  assert.ok(shortReadCalls > 1);
} finally {
  fileHandlePrototype.read = originalRead;
}
assert.equal(closeEvents, closeEventsBeforeShortRead + 1);

let deletedDuringRead = false;
fileHandlePrototype.read = async function (buffer, offset, length, position) {
  const result = await originalRead.call(
    this,
    buffer,
    offset,
    Math.min(length, 7),
    position
  );
  if (!deletedDuringRead) {
    deletedDuringRead = true;
    await unlink(logPath);
  }
  return result;
};
const closeEventsBeforeDeletedRead = closeEvents;
try {
  const result = await readRecentLogFile({ file: "app.log", limit: "1000" });
  assert.equal(result.content, payload.slice(-1_000));
  assert.equal(result.bytes_read, 1_000);
} finally {
  fileHandlePrototype.read = originalRead;
}
assert.equal(closeEvents, closeEventsBeforeDeletedRead + 1);

await writeFile(logPath, payload);
fileHandlePrototype.read = async function () {
  throw Object.assign(new Error("permission denied"), { code: "EACCES" });
};
const closeEventsBeforeFailedRead = closeEvents;
try {
  await assert.rejects(
    readRecentLogFile({ file: "app.log", limit: "1000" }),
    (error) => error?.code === "EACCES"
  );
} finally {
  fileHandlePrototype.read = originalRead;
}
assert.equal(closeEvents, closeEventsBeforeFailedRead + 1);

const rotatedPath = join(logDirectory, "app.log.1");
await rename(logPath, rotatedPath);
await writeFile(logPath, "new active log");
const closeEventsBeforeRotatedRead = closeEvents;
const rotated = await readRecentLogFile({});
assert.deepEqual(rotated.files.map((file) => file.name), ["app.log", "app.log.1"]);
assert.equal(rotated.selected, "app.log");
assert.equal(rotated.content, "new active log");
assert.equal(closeEvents, closeEventsBeforeRotatedRead + 1);
fileHandlePrototype.emit = originalEmit;
console.log("log-tail-ok");
`;

  try {
    await writeFile(helperPath, helperSource);
    const result = await runProcess(process.execPath, [
      resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
      helperPath
    ], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "development",
        IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: toNamespacedPath(helperRoot)
      },
      timeoutMs: 30_000
    });
    assert.match(result.stdout, /log-tail-ok/);
  } finally {
    await rm(helperRoot, { recursive: true, force: true });
  }
});
