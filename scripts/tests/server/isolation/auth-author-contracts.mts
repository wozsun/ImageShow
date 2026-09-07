import assert from "node:assert/strict";
import type { AdminSession } from "../../../../packages/server/src/users/admin-session.ts";
import type { Hono as HonoApp } from "hono";

import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
const databasePools = runtime.databasePools;
const database = {
  ...databasePools,
  ...await import("../../../../packages/server/src/core/database/advisory-locks.ts")
};
const { ensureSuperAdmin } = await import("../../../../packages/server/src/users/admin-bootstrap.ts");
const bootstrapAccounts = await database.pool.query(
  "SELECT username, password_hash, role FROM admin_account ORDER BY username"
);
assert.equal(bootstrapAccounts.rows.length, 1);
assert.equal(bootstrapAccounts.rows[0].username, "integration-admin");
assert.equal(await ensureSuperAdmin({
  username: "replacement-admin",
  password: "ReplacementAdmin123!"
}), false);
assert.equal(await ensureSuperAdmin({}), false);
assert.deepEqual((await database.pool.query(
  "SELECT username, password_hash, role FROM admin_account ORDER BY username"
)).rows, bootstrapAccounts.rows, "bootstrap must preserve existing administrators and passwords");
const runtimeConfigStore = await import("../../../../packages/server/src/config/runtime-config-store.ts");
const authRoutes = await import("../../../../packages/server/src/routes/auth.ts");
const adminSession = await import("../../../../packages/server/src/users/admin-session.ts");
const { adminSessionKey } = await import("../../../../packages/server/src/users/admin-session-key.ts");
const httpResponses = await import("../../../../packages/server/src/core/http/responses.ts");
const redisClient = await import("../../../../packages/server/src/core/redis/client.ts");
const apiError = await import("../../../../packages/server/src/core/api-error.ts");
const vocabCache = await import("../../../../packages/server/src/vocab/vocab-cache.ts");
const authorMutations = await import("../../../../packages/server/src/authors/mutations.ts");
const authorQuery = await import("../../../../packages/server/src/authors/query.ts");
const adminVocabularyRoutes = await import(
  "../../../../packages/server/src/routes/admin-vocabulary.ts"
);
const { Hono } = await import("hono");
const baselineRuntimeConfig = structuredClone(runtimeConfigStore.getRuntimeConfig());
const authorAdminApi = "/api/admin";
const authorRouteCsrf = "author-route-csrf";
const vocabularyApp = new Hono<{ Variables: { session: AdminSession } }>();
vocabularyApp.onError((error, context) => (
  httpResponses.handleApiError(context, error)
));
vocabularyApp.use(authorAdminApi + "/*", async (context, next) => {
  const role = context.req.header("x-test-role");
  if (role !== "super" && role !== "image") {
    throw new apiError.ApiError(401, "unauthorized", "Authentication required");
  }
  context.set("session", {
    id: "author-route-session",
    username: "route-admin",
    role,
    csrf: authorRouteCsrf
  });
  await next();
});
vocabularyApp.use(authorAdminApi + "/*", async (context, next) => {
  if (context.req.method !== "GET") {
    return adminSession.requireAdminCsrf(context, next);
  }
  await next();
});
adminVocabularyRoutes.registerAdminVocabularyRoutes(vocabularyApp as unknown as HonoApp);
const authorRouteRequest = (path: string, {
  method = "GET",
  role,
  body
}: { method?: string; role?: "super" | "image"; body?: unknown } = {}) => vocabularyApp.request(new Request(
  "http://imageshow.test" + authorAdminApi + "/authors" + path,
  {
    method,
    headers: {
      "content-type": "application/json",
      ...(role ? {
        "x-test-role": role,
        "x-csrf-token": authorRouteCsrf
      } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  }
));

const unauthenticatedAuthors = await authorRouteRequest("");
assert.equal(unauthenticatedAuthors.status, 401);
assert.equal((await unauthenticatedAuthors.json()).code, "unauthorized");
const createdBySuperResponse = await authorRouteRequest("", {
  method: "POST",
  role: "super",
  body: {
    slug: "identity-route-super",
    display_name: "Identity Super",
    link: "https://weibo.com/u/4444444444"
  }
});
assert.equal(
  createdBySuperResponse.status,
  200,
  await createdBySuperResponse.clone().text()
);
const createdBySuper = await createdBySuperResponse.json();
assert.deepEqual(createdBySuper.item, {
  slug: "identity-route-super",
  display_name: "Identity Super",
  link: "https://weibo.com/u/4444444444",
  image_count: 0,
  derived_identity: { provider: "weibo", id: "4444444444" }
});
const createdByImageResponse = await authorRouteRequest("", {
  method: "POST",
  role: "image",
  body: {
    slug: "identity-route-image",
    display_name: "Identity Image",
    link: "https://example.com/author/image"
  }
});
assert.equal(
  createdByImageResponse.status,
  200,
  await createdByImageResponse.clone().text()
);
assert.equal((await createdByImageResponse.json()).item.derived_identity, null);

const internalFieldAttempt = await authorRouteRequest("", {
  method: "POST",
  role: "image",
  body: {
    slug: "identity-route-internal-field",
    display_name: "Rejected",
    link: "https://weibo.com/u/6666666666",
    identity_provider: "weibo",
    identity_id: "6666666666"
  }
});
assert.equal(internalFieldAttempt.status, 400);

const conflictingUpdate = await authorRouteRequest("/identity-route-image", {
  method: "POST",
  role: "image",
  body: {
    display_name: "Must Roll Back",
    link: "https://weibo.com/u/4444444444"
  }
});
const conflictingUpdateText = await conflictingUpdate.text();
assert.equal(conflictingUpdate.status, 409);
assert.match(conflictingUpdateText, /author_identity_exists/);
assert.doesNotMatch(
  conflictingUpdateText,
  /identity_provider|identity_id|derived_identity|4444444444/
);
const unchangedAfterConflict = (await database.pool.query(
  "SELECT display_name, link, identity_provider, identity_id FROM author WHERE slug=$1",
  ["identity-route-image"]
)).rows[0];
assert.deepEqual(unchangedAfterConflict, {
  display_name: "Identity Image",
  link: "https://example.com/author/image",
  identity_provider: null,
  identity_id: null
});

const clearedByImageResponse = await authorRouteRequest("/identity-route-super", {
  method: "POST",
  role: "image",
  body: {
    display_name: "Identity Super Cleared",
    link: "https://example.com/author/super"
  }
});
assert.equal(
  clearedByImageResponse.status,
  200,
  await clearedByImageResponse.clone().text()
);
assert.equal((await clearedByImageResponse.json()).item.derived_identity, null);
const reboundBySuperResponse = await authorRouteRequest("/identity-route-image", {
  method: "POST",
  role: "super",
  body: {
    display_name: "Identity Image Rebound",
    link: "https://weibo.com/u/5555555555"
  }
});
assert.equal(
  reboundBySuperResponse.status,
  200,
  await reboundBySuperResponse.clone().text()
);
const reboundBySuper = await reboundBySuperResponse.json();
assert.deepEqual(reboundBySuper.item.derived_identity, {
  provider: "weibo",
  id: "5555555555"
});
assert.equal(reboundBySuper.item.link, "https://weibo.com/u/5555555555");

const resolvedAuthors = await authorQuery.resolveWeiboAuthorSlugs([
    "5555555555",
    "7777777777",
    "5555555555",
    "invalid"
]);
assert.deepEqual([...resolvedAuthors], [["5555555555", "identity-route-image"]]);

const adminAuthorListResponse = await authorRouteRequest("", { role: "image" });
assert.equal(adminAuthorListResponse.status, 200);
const adminAuthorList = await adminAuthorListResponse.json();
assert.deepEqual(
  adminAuthorList.items.find((item: { slug: string }) => item.slug === "identity-route-image")
    .derived_identity,
  { provider: "weibo", id: "5555555555" }
);
const adminAuthorJson = JSON.stringify(adminAuthorList);
assert.doesNotMatch(adminAuthorJson, /identity_provider|identity_id/);
const publicAuthorVocabulary = await vocabCache.getAuthorVocab();
const ingestionVocabulary = await vocabCache.getIngestionVocabulary();
for (const value of [publicAuthorVocabulary, ingestionVocabulary]) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(
    serialized,
    /identity_provider|identity_id|derived_identity/
  );
}
await authorMutations.deleteAuthor("identity-route-super");
await authorMutations.deleteAuthor("identity-route-image");
  const slidingSessionConfig = structuredClone(baselineRuntimeConfig);
  slidingSessionConfig.security.session_ttl_seconds = 360;
  slidingSessionConfig.altcha.enabled = false;
  await runtimeConfigStore.replaceRuntimeConfig(slidingSessionConfig);
  const authApp = new Hono();
  authApp.onError((error, context) => (
    httpResponses.handleApiError(context, error)
  ));
  authRoutes.registerPublicAuthRoutes(authApp);
  const loginResponse = await authApp.request(new Request(
    "http://imageshow.test/api/admin/auth/login",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "imageshow.test",
        origin: "http://imageshow.test"
      },
      body: JSON.stringify({
        username: "integration-admin",
        password: "IntegrationAdmin123!"
      })
    }
  ));
  assert.equal(loginResponse.status, 200, await loginResponse.clone().text());
  const loginCookie = loginResponse.headers.get("set-cookie") ?? "";
  const sessionId = /imageshow_session=([^;]+)/u.exec(loginCookie)?.[1];
  assert.ok(sessionId);
  assert.match(loginCookie, /Max-Age=360/u);
  const slidingSessionKey = adminSessionKey(sessionId);
  const initialSessionTtl = await redisClient.redis.ttl(slidingSessionKey);
  assert.ok(initialSessionTtl > 350 && initialSessionTtl <= 360);

  const ordinaryAdminApp = new Hono();
  ordinaryAdminApp.get(
    "/ordinary-admin-request",
    adminSession.requireAdminSession,
    (context) => context.json({ ok: true })
  );
  assert.equal(await redisClient.redis.expire(slidingSessionKey, 60), 1);
  const ordinaryResponse = await ordinaryAdminApp.request(new Request(
    "http://imageshow.test/ordinary-admin-request",
    { headers: { cookie: "imageshow_session=" + sessionId } }
  ));
  assert.equal(ordinaryResponse.status, 200);
  assert.equal(ordinaryResponse.headers.get("set-cookie"), null);
  const ordinaryRequestTtl = await redisClient.redis.ttl(slidingSessionKey);
  assert.ok(ordinaryRequestTtl > 55 && ordinaryRequestTtl <= 60);

  const authMe = () => authApp.request(new Request(
    "http://imageshow.test/api/admin/auth/me",
    { headers: { cookie: "imageshow_session=" + sessionId } }
  ));
  const renewedResponse = await authMe();
  assert.equal(renewedResponse.status, 200, await renewedResponse.clone().text());
  assert.equal((await renewedResponse.clone().json()).authenticated, true);
  assert.match(renewedResponse.headers.get("set-cookie") ?? "", /Max-Age=360/u);
  const renewedSessionTtl = await redisClient.redis.ttl(slidingSessionKey);
  assert.ok(renewedSessionTtl > 350 && renewedSessionTtl <= 360);

  const hotSessionConfig = structuredClone(slidingSessionConfig);
  hotSessionConfig.security.session_ttl_seconds = 480;
  await runtimeConfigStore.replaceRuntimeConfig(hotSessionConfig);
  assert.equal(await redisClient.redis.expire(slidingSessionKey, 60), 1);
  const hotRenewalResponse = await authMe();
  assert.equal(hotRenewalResponse.status, 200);
  assert.match(
    hotRenewalResponse.headers.get("set-cookie") ?? "",
    /Max-Age=480/u
  );
  const hotRenewalTtl = await redisClient.redis.ttl(slidingSessionKey);
  assert.ok(hotRenewalTtl > 470 && hotRenewalTtl <= 480);

  assert.equal(await redisClient.redis.del(slidingSessionKey), 1);
  const expiredProbeResponse = await authMe();
  assert.equal(expiredProbeResponse.status, 200);
  assert.equal((await expiredProbeResponse.clone().json()).authenticated, false);
  assert.equal(expiredProbeResponse.headers.get("set-cookie"), null);
  assert.equal(await redisClient.redis.exists(slidingSessionKey), 0);
  await runtimeConfigStore.replaceRuntimeConfig(baselineRuntimeConfig);
});
