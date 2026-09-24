import "../support/server-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTagFilter,
  readableFilterSearch,
  resolveTagExpression,
  tagExpressionValues,
  TagFilterError,
  type TagExpression
} from "../../../packages/shared/src/browser/tag-filter.ts";
import { resolveTermSlugMap } from "../../../packages/server/src/vocab/terms.ts";
import {
  createImageFilterPlan,
  imageFilterPlanWithout
} from "../../../packages/server/src/images/filter-plan.ts";
import {
  readyImageFilterOperations,
  type FilterSetSource
} from "../../../packages/server/src/images/ready-cache/derived/filter-operations.ts";
import {
  assessReadyImageFilterWork,
  assessReadyImageStatsWork,
  tryAcquireReadyImageFilterBuildSlot,
  tryAcquireReadyImageStatsBuildSlot,
  READY_IMAGE_DERIVED_WORK_POLICY
} from "../../../packages/server/src/images/ready-cache/derived/work-policy.ts";
import { resolveDirectReadyImageFilterKey } from "../../../packages/server/src/images/ready-cache/indexes/filter-builder.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  readyImageAttributeIndexKey,
  readyImageAttributeIndexSpec
} from "../../../packages/server/src/images/ready-cache/keys.ts";
import {
  normalizeRandomQuery,
  parseRandomQuery
} from "../../../packages/server/src/random/query.ts";
import {
  adminImageListQuery,
  galleryStatsQuery,
  imageListQueryValues,
  listQuery
} from "../../../packages/server/src/routes/validation/images.ts";

test("[Server/标签] 基础任一与全部归一并保留单标签编辑方式", () => {
  const any = parseTagFilter([" B, a,a "]);
  assert.deepEqual(any.expression, { anyOf: [["a"], ["b"]] });
  assert.equal(any.termCount, 2);
  assert.deepEqual(parseTagFilter(["a", "b"]).expression, any.expression);
  assert.deepEqual(parseTagFilter(["all:b,a,a"]).expression, { anyOf: [["a", "b"]] });
  assert.deepEqual(parseTagFilter(["all:b,a", "all:a,b"]).expression, { anyOf: [["a", "b"]] });
  const singleAll = parseTagFilter(["ALL:A"]);
  assert.equal(singleAll.mode, "all");
  assert.deepEqual(singleAll.expression, parseTagFilter(["a"]).expression);
  assert.deepEqual(tagExpressionValues(singleAll.expression), ["a"]);
  assert.deepEqual(tagExpressionValues(singleAll.expression, singleAll.mode), ["all:a"]);
  assert.equal(parseTagFilter([]).expression, null);
});

test("[Server/标签] 列表与统计接受标签分组并统一段数与词项预算", () => {
  const inputs = [
    (tag: string[]) => listQuery.safeParse({ view: "gallery", limit: 60, tag }),
    (tag: string[]) => adminImageListQuery.safeParse({ tag }),
    (tag: string[]) => galleryStatsQuery.safeParse({ tag })
  ];
  const query = imageListQueryValues(new URLSearchParams("tag=a&tag=b"));
  assert.deepEqual(query.tag, ["a", "b"]);
  for (const input of inputs) {
    for (const tag of [["a", "b"], ["all:a,b"], ["all:a,b", "all:b,a"]]) {
      assert.equal(input(tag).success, true, String(tag));
    }
    assert.equal(input(["all:a,b", "c"]).success, true);
    assert.equal(input(Array(9).fill("all:a,b")).success, true);
    assert.equal(input(Array(10).fill("a")).success, false);
    assert.equal(input([Array(33).fill("a").join(",")]).success, true);
    assert.equal(input([""]).success, false);
  }
  assert.throws(() => parseTagFilter(["a", "all:a,b"]), { kind: "mixed" });
  const mixed = parseTagFilter(["a", "all:a,b"], "mixed").expression;
  assert.equal(mixed?.anyOf.length, 2);
});

test("[Server/标签] 词项预算按规范表达式计数并独立约束原始输入", () => {
  assert.equal(parseTagFilter(Array(32).fill("a")).termCount, 1);
  assert.throws(() => parseTagFilter(Array(33).fill("a")), TagFilterError);
  assert.equal(parseTagFilter([Array(33).fill("a").join(",")]).termCount, 1);
  assert.throws(() => parseTagFilter([Array.from({ length: 33 }, (_, i) => `t${i}`).join(",")]), /32/);
  assert.equal(parseTagFilter(["all:a,b", "all:b,a"], "mixed").termCount, 2);
  assert.equal(parseTagFilter(["all:a,b", "all:a,c"], "mixed").termCount, 4);
  assert.equal(parseTagFilter(["a,b", "b,c"], "mixed").termCount, 3);
  assert.equal(parseTagFilter(["😀".repeat(64)]).termCount, 1);
  assert.throws(() => parseTagFilter(["😀".repeat(65)]), TagFilterError);
  const fullLength = [...Array(15).fill("a".repeat(64)), "b".repeat(49)].join(",");
  assert.equal(fullLength.length, 1024);
  assert.equal(parseTagFilter([fullLength]).termCount, 2);
  assert.throws(() => parseTagFilter([fullLength + "b"]), TagFilterError);
  for (const value of ["", " ", "a,", ",a", "all:", "all:a,,b", "!a", ":a", "a,all:b", "a\u0000b"]) {
    assert.throws(() => parseTagFilter([value]), TagFilterError, value);
  }
});

test("[Server/标签] slug 优先于显示名且未知分支使完整条件失败", async () => {
  const terms = await resolveTermSlugMap(async () => [
    { slug: "live", display_name: "现场" },
    { slug: "other", display_name: "live" },
    { slug: "empty", display_name: "空标签" }
  ], ["live", "现场", "empty", "空标签", "missing"]);
  assert.equal(terms.get("live"), "live");
  const resolved = resolveTagExpression(parseTagFilter(["all:现场,live"]).expression, terms);
  assert.deepEqual(resolved, { anyOf: [["live"]] });
  assert.deepEqual(resolveTagExpression(parseTagFilter(["空标签"]).expression, terms), { anyOf: [["empty"]] });
  assert.throws(() => resolveTagExpression(
    parseTagFilter(["live", "all:live,missing"], "mixed").expression,
    terms
  ), { kind: "unknown", term: "missing" });
  assert.throws(() => parseTagFilter(["all:现场,live", "empty"]), { kind: "mixed" });
});

test("[Server/标签] 查询签名统一等价写法并保留全部和分支边界", () => {
  const plan = (values: string[]) => createImageFilterPlan({ tag: parseTagFilter(values, "mixed").expression });
  assert.equal(plan(["a,b"]).signature, plan(["b", "a,a"]).signature);
  assert.equal(plan(["all:a"]).signature, plan(["a"]).signature);
  assert.notEqual(plan(["all:a,b"]).signature, plan(["a,b"]).signature);
  assert.notEqual(plan(["a", "all:a,b"]).signature, plan(["a"]).signature);
  assert.equal(imageFilterPlanWithout(plan(["all:a,b", "c"]), "tag").signature, plan([]).signature);
});

test("[Server/标签] 随机查询接受混合条件并统一未知标签与总词项限制", () => {
  const parse = (search: string) => parseRandomQuery(new URL("https://img.example.com/random?" + search), "redirect");
  const parsed = parse("tag=all:a,b&tag=c&theme=!blocked&author=owner");
  assert.ok(!(parsed instanceof Response));
  const maps = {
    tag: new Map([["a", "a"], ["b", "b"], ["c", "c"]]),
    theme: new Map([["blocked", "blocked"]]),
    author: new Map([["owner", "owner"]])
  };
  const normalized = normalizeRandomQuery(parsed, maps);
  assert.ok(!(normalized instanceof Response));
  assert.deepEqual(normalized.tag, { anyOf: [["a", "b"], ["c"]] });
  assert.deepEqual(normalized.theme, { include: [], exclude: ["blocked"] });
  const unknown = normalizeRandomQuery(parsed, { ...maps, tag: new Map([["c", "c"]]) });
  assert.ok(unknown instanceof Response);
  assert.equal(unknown.status, 404);
  const repeated = Array.from({ length: 32 }, (_, i) => `t${i}`).join(",");
  assert.ok(!(parse(`tag=${repeated}&theme=${repeated}`) instanceof Response));
  const excessive = parse(`tag=${repeated}&theme=${repeated}&author=a`);
  assert.ok(excessive instanceof Response);
  assert.equal(excessive.status, 400);
});

test("[Server/标签] 可读链接保留逻辑标点并往返编码特殊字符", () => {
  const params = new URLSearchParams();
  params.append("tag", "all:a&b,c+d");
  params.append("tag", "#现场%完成");
  const search = readableFilterSearch(params);
  assert.ok(search.startsWith("tag=all:a%26b,c%2Bd&tag="));
  assert.deepEqual([...new URLSearchParams(search)], [...params]);
});

test("[Server/标签] 有限集合运算与图片资格一致且重叠分支只产生一个成员", () => {
  const slugs = ["a", "b", "c", "d"];
  const images = Array.from({ length: 16 }, (_, id) => ({
    id,
    tags: slugs.filter((_, index) => (id & (1 << index)) !== 0)
  }));
  const execute = (expression: TagExpression, withOtherFilters: boolean) => {
    const sets = new Map<string, Set<number>>();
    const source = (key: string, ids: number[]): FilterSetSource => {
      sets.set(key, new Set(ids));
      return { key, count: new Set(ids).size };
    };
    const all = source("all", images.map(({ id }) => id));
    const tags = new Map([...slugs, "empty"].map((slug) => [
      slug, source(slug, images.filter((item) => item.tags.includes(slug)).map(({ id }) => id))
    ]));
    let sequence = 0;
    const execution = readyImageFilterOperations({
      all,
      tagClauses: expression?.anyOf.map((clause) => clause.map((slug) => tags.get(slug)!)) ?? [],
      positive: withOtherFilters ? [[source("axis", images.filter(({ id }) => id % 2 === 0).map(({ id }) => id))]] : [],
      exclusions: withOtherFilters ? [[source("blocked", [2, 4])]] : []
    }, () => `temporary:${sequence++}`);
    for (const operation of execution.operations) {
      const inputs = operation.sources.map(({ key }) => sets.get(key)!);
      const result = operation.kind === "union"
        ? new Set(inputs.flatMap((input) => [...input]))
        : new Set([...inputs[0]!].filter((id) => operation.kind === "intersection"
          ? inputs.slice(1).every((input) => input.has(id))
          : inputs.slice(1).every((input) => !input.has(id))));
      sets.set(operation.result.key, result);
    }
    return [...sets.get(execution.result.key)!].sort((a, b) => a - b);
  };
  for (const values of [[], ["a,b"], ["all:a,b"], ["all:a,b", "c"], ["all:a,b", "all:b,c"], ["empty"], ["all:a,empty"]]) {
    const expression = parseTagFilter(values, "mixed").expression;
    for (const withOtherFilters of [false, true]) {
      const expected = images.filter((item) => (
        (!expression || expression.anyOf.some((clause) => clause.every((tag) => item.tags.includes(tag))))
        && (!withOtherFilters || (item.id % 2 === 0 && item.id !== 2 && item.id !== 4))
      )).map(({ id }) => id);
      assert.deepEqual(execute(expression, withOtherFilters), expected, JSON.stringify({ values, withOtherFilters }));
    }
  }
  assert.equal(assessReadyImageFilterWork({
    itemCount: 16, positive: [[8]], tagClauses: [[8, 8], [8]], exclusions: [[2]]
  }).admitted, true);
  assert.equal(assessReadyImageFilterWork({
    itemCount: 16, positive: [],
    tagClauses: [Array(READY_IMAGE_DERIVED_WORK_POLICY.maxSetOperationOperands + 1).fill(8)],
    exclusions: []
  }).admitted, false);
});

test("[Server/筛选] 完整设备候选复用属性索引，亮度和组合条件保留独立语义", () => {
  for (const device of ["pc", "mb"] as const) {
    const spec = { kind: "device", value: device } as const;
    const key = readyImageAttributeIndexKey(spec);
    assert.deepEqual(readyImageAttributeIndexSpec(key), spec);
    assert.equal(resolveDirectReadyImageFilterKey(createImageFilterPlan({ devices: [device] })), key);
    for (const brightness of ["dark", "light"] as const) {
      assert.equal(resolveDirectReadyImageFilterKey(createImageFilterPlan({ devices: [device], brightnesses: [brightness] })),
        readyImageAttributeIndexKey({ kind: "axis", device, brightness }));
    }
    assert.equal(resolveDirectReadyImageFilterKey(createImageFilterPlan({ devices: [device], tag: { anyOf: [["tag-a"]] } })), null);
  }
  assert.equal(resolveDirectReadyImageFilterKey(createImageFilterPlan({})), READY_IMAGE_ALL_INDEX_KEY);
  assert.equal(resolveDirectReadyImageFilterKey(createImageFilterPlan({ brightnesses: ["light"] })), null);
  for (const value of ["auto", "all", "other", "pc:light", ""]) {
    assert.equal(readyImageAttributeIndexSpec(`imageshow:cache:images:derived:index:device:${value}`), null);
  }
});

test("[Server/筛选] 统计维度与成员工作量在预算内准入，超限拒绝", () => {
  const policy = READY_IMAGE_DERIVED_WORK_POLICY;
  assert.equal(assessReadyImageStatsWork({ dynamicDimensions: policy.maxDynamicStatsDimensions, intersections: [] }).admitted, true);
  assert.equal(assessReadyImageStatsWork({ dynamicDimensions: policy.maxDynamicStatsDimensions + 1, intersections: [] }).admitted, false);
  assert.equal(assessReadyImageStatsWork({ dynamicDimensions: 1, intersections: [{ baseCount: policy.maxCardinalitySourceMembersPerOperation, candidateCount: 1 }] }).admitted, false);
  const count = Math.floor(policy.maxExpectedResultMembers / 2);
  assert.equal(assessReadyImageFilterWork({ itemCount: count * 4, positive: [[count, count]], exclusions: [] }).admitted, true);
  assert.equal(assessReadyImageFilterWork({ itemCount: count * 4, positive: [[count, count], [count, count]], exclusions: [] }).admitted, false);
  assert.equal(assessReadyImageStatsWork({ dynamicDimensions: 1, intersections: [{ baseCount: -1, candidateCount: 1 }] }).admitted, false);
});

test("[Server/筛选] 构建槽位有界，大任务独占且重复释放不扩大并发", () => {
  const policy = READY_IMAGE_DERIVED_WORK_POLICY;
  const small = { operationCount: 1, intersectionDifferenceOperations: 0, totalSourceMembers: 2,
    peakSourceMembers: 2, totalExpectedMembers: 1, peakExpectedMembers: 1, peakOperands: 2 };
  for (const [acquire, limit, large] of [
    [tryAcquireReadyImageFilterBuildSlot, policy.maxConcurrentFilterBuilds, { ...small, totalSourceMembers: policy.largeFilterSourceMembers }],
    [tryAcquireReadyImageStatsBuildSlot, policy.maxConcurrentStatsBuilds, { ...small, totalExpectedMembers: policy.largeStatsExpectedMembers }]
  ] as const) {
    const releases: Array<() => void> = [];
    try {
      for (let index = 0; index < limit; index += 1) {
        const release = acquire(small);
        assert.ok(release);
        releases.push(release);
      }
      assert.equal(acquire(small), null);
      releases[0]!();
      releases[0]!();
      const replacement = acquire(large);
      assert.ok(replacement);
      releases.push(replacement);
      assert.equal(acquire(small), null);
      releases[1]!();
      assert.equal(acquire(large), null, "one large task may remain active alongside smaller tasks");
    } finally {
      releases.forEach((release) => release());
    }
    const restored = acquire(small);
    assert.ok(restored);
    restored();
  }
});
