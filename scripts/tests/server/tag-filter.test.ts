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
import { resolveTermMap } from "../../../packages/server/src/core/term-resolve.ts";
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
  READY_IMAGE_DERIVED_WORK_POLICY
} from "../../../packages/server/src/images/ready-cache/derived/work-policy.ts";
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
  assert.equal(any.submittedCount, 3);
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

test("[Server/标签] 基础接口保留重复段并拒绝真正的混合条件", () => {
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
    assert.equal(input(["all:a,b", "c"]).success, false);
    assert.equal(input([""]).success, false);
  }
  assert.throws(() => parseTagFilter(["a", "all:a,b"]), { kind: "mixed" });
  const mixed = parseTagFilter(["a", "all:a,b"], "mixed").expression;
  assert.equal(mixed?.anyOf.length, 2);
});

test("[Server/标签] 输入预算在去重前生效并拒绝空词项与非法格式", () => {
  assert.equal(parseTagFilter(Array(32).fill("a")).submittedCount, 32);
  assert.throws(() => parseTagFilter(Array(33).fill("a")), TagFilterError);
  assert.throws(() => parseTagFilter([Array(33).fill("a").join(",")]), TagFilterError);
  assert.equal(parseTagFilter(["😀".repeat(64)]).submittedCount, 1);
  assert.throws(() => parseTagFilter(["😀".repeat(65)]), TagFilterError);
  const fullLength = [...Array(15).fill("a".repeat(64)), "b".repeat(49)].join(",");
  assert.equal(fullLength.length, 1024);
  assert.equal(parseTagFilter([fullLength]).submittedCount, 16);
  assert.throws(() => parseTagFilter([fullLength + "b"]), TagFilterError);
  for (const value of ["", " ", "a,", ",a", "all:", "all:a,,b", "!a", ":a", "a,all:b", "a\u0000b"]) {
    assert.throws(() => parseTagFilter([value]), TagFilterError, value);
  }
});

test("[Server/标签] slug 优先于显示名且未知分支使完整条件失败", async () => {
  const terms = await resolveTermMap(async () => [
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
  const repeated = Array(32).fill("a").join(",");
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
