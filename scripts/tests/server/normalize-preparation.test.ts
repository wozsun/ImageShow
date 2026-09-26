import "../support/server-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { profileFingerprint, variantFingerprint } from "../../../packages/server/src/images/variants/encoding.ts";
import { defaultPreparationProfile, imageVariants, parsePreparationProfile } from "../../../packages/shared/src/browser.ts";
import { registerNormalizePreparationRoutes } from "../../../packages/server/src/routes/normalize-preparation.ts";
import { handleApiError } from "../../../packages/server/src/core/http/responses.ts";

test("[Server/三档预生成] 独立参数、尺寸和体积顺序及质量边界", () => {
  const profile = defaultPreparationProfile();
  assert.deepEqual(parsePreparationProfile(profile), profile);
  for (const variant of imageVariants) {
    for (const [key, invalid] of Object.entries({ quality: [49, 101, 80.5], min_quality: [0, 81], webp_effort: [-1, 7] })) {
      for (const value of invalid) {
        const changed = structuredClone(profile);
        Object.assign(changed[variant], { [key]: value });
        assert.throws(() => parsePreparationProfile(changed));
      }
    }
    const changed = structuredClone(profile);
    changed[variant].quality = 50;
    assert.throws(() => parsePreparationProfile(changed), /最低质量/);
    changed[variant].min_quality = 1;
    assert.equal(parsePreparationProfile(changed)[variant].quality, 50);
  }
  for (const key of ["max_size_kb", "max_long_edge"] as const) {
    const changed = structuredClone(profile);
    changed.small[key] = changed.middle[key] + 1;
    assert.throws(() => parsePreparationProfile(changed));
    changed.small[key] = changed.middle[key] = changed.large[key] = 600;
    assert.equal(parsePreparationProfile(changed).small[key], 600);
  }
  assert.throws(() => parsePreparationProfile({ ...profile, quality_step: 0 }));
  assert.throws(() => parsePreparationProfile({ ...profile, quality_step: 21 }));
  assert.throws(() => parsePreparationProfile({ ...profile, extra: true }));
  const another = defaultPreparationProfile();
  another.large.quality = 100;
  assert.equal(profile.large.quality, 80);
  assert.equal(another.small.quality, 80);
  // PostgreSQL JSONB may reorder object keys at every nesting level.
  const ordered = Object.fromEntries(Object.entries(profile).reverse().map(([key, value]) => [key,
    typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse()) : value]));
  assert.equal(profileFingerprint(ordered as typeof profile), profileFingerprint(profile));
  for (const variant of imageVariants) assert.equal(variantFingerprint(ordered as typeof profile, variant), variantFingerprint(profile, variant));
});

test("[Server/三档预生成] 普通管理员不能绕过页面调用控制、核验、预览与导出", async () => {
  const app = new Hono();
  app.onError((error, context) => handleApiError(context, error));
  app.use("*", async (c, next) => { c.set("session" as never, { role: "image" } as never); await next(); });
  registerNormalizePreparationRoutes(app);
  for (const [path, method] of [["status", "GET"], ["control", "POST"], ["export", "GET"], ["preview/00000000-0000-4000-8000-000000000001/large", "GET"]]) {
    const response = await app.request(`/api/admin/check/normalize-preparation/${path}`, { method });
    assert.equal(response.status, 403);
  }
});
