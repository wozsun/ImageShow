import "../support/server-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { defaultNormalizeProfile, imageVariants } from "../../../packages/shared/src/browser.ts";

import { normalizeSchema } from "../../../packages/server/src/config/normalize-schema.ts";

test("[Server/三档配置] 独立参数、尺寸和体积顺序及质量边界", () => {
  const profile = { concurrency: 2, ...defaultNormalizeProfile() };
  assert.deepEqual(normalizeSchema.parse(profile), profile);
  for (const variant of imageVariants) {
    for (const [key, invalid] of Object.entries({ quality: [49, 101, 80.5], min_quality: [0, 81] })) {
      for (const value of invalid) {
        const changed = structuredClone(profile);
        Object.assign(changed[variant], { [key]: value });
        assert.throws(() => normalizeSchema.parse(changed));
      }
    }
    const changed = structuredClone(profile);
    changed[variant].quality = 50;
    assert.throws(() => normalizeSchema.parse(changed), /最低质量/);
    changed[variant].min_quality = 1;
    assert.equal(normalizeSchema.parse(changed)[variant].quality, 50);
  }
  for (const key of ["max_size_kb", "max_long_edge"] as const) {
    const changed = structuredClone(profile);
    changed.small[key] = changed.medium[key] + 1;
    assert.throws(() => normalizeSchema.parse(changed));
    changed.small[key] = changed.medium[key] = changed.large[key] = 600;
    assert.equal(normalizeSchema.parse(changed).small[key], 600);
  }
  assert.throws(() => normalizeSchema.parse({ ...profile, quality_step: 0 }));
  assert.throws(() => normalizeSchema.parse({ ...profile, quality_step: 21 }));
  assert.throws(() => normalizeSchema.parse({ ...profile, extra: true }));
  const another = defaultNormalizeProfile();
  another.large.quality = 100;
  assert.equal(profile.large.quality, 80);
  assert.equal(another.small.quality, 80);
  // 配置对象的属性顺序不影响解析结果。
  const ordered = Object.fromEntries(Object.entries(profile).reverse().map(([key, value]) => [key,
    typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).reverse()) : value]));
  assert.deepEqual(normalizeSchema.parse(ordered), profile);
});
