import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GalleryStatsDto } from "@imageshow/shared/browser";
import { createPublicFilterDraft, publicDraftFilters, publicFilterChips, resolvePublicFilterTag, createTagSelection } from "../../../packages/web/src/lib/gallery/public-filter-draft.ts";
import { emptyGalleryFilters, galleryFiltersFromSearchParams, galleryRouteSearchParams, galleryStatsSearch, imageBrowseApiSearchParams } from "../../../packages/web/src/lib/gallery/gallery-query.ts";
import { publicFilterOptionState } from "../../../packages/web/src/lib/gallery/public-filter-options.ts";
import { facetSuggestions } from "../../../packages/web/src/lib/ui/facet-input.ts";
import { matchPinyinFacetText } from "../../../packages/web/src/lib/ui/pinyin-facet-input.ts";
import { usePublicFilterStats } from "../../../packages/web/src/hooks/usePublicFilterStats.ts";
import { useRefreshGlint, useRefreshGlintRun } from "../../../packages/web/src/hooks/useRefreshGlint.ts";
import { createConfigStreamHarness } from "../support/web-test-context.ts";
import { MemoryRouter, useNavigate } from "react-router";
import { usePublicFilterDialog } from "../../../packages/web/src/hooks/usePublicFilterDialog.ts";
import { usePageScrollLock } from "../../../packages/web/src/hooks/usePageScrollLock.ts";
import { useImeSearchInput } from "../../../packages/web/src/hooks/useImeSearchInput.ts";
import type { ChangeEvent, CompositionEvent, FocusEvent } from "react";

const facets = {
  themes: [{ slug: "city", display_name: "城市" }],
  tags: [{ slug: "night", display_name: "夜景" }, { slug: "rain", display_name: "雨景" }],
  authors: [{ slug: "artist", display_name: "作者", link: "" }]
};

test("[Web/公开筛选] 草稿分组往返保留或且边界，跨组重复只显示一个已选项", () => {
  const filters = { ...emptyGalleryFilters, device: "auto", theme: "!city", author: "artist", tag: ["all:rain,night", "night"] };
  const draft = createPublicFilterDraft(filters);
  const tag = resolvePublicFilterTag(draft, facets);
  assert.equal(tag.error, null);
  assert.deepEqual(tag.selection.groups.map(g => g.mode), ["all", "any"]);
  assert.equal(tag.selection.activeId, 2);
  const output = publicDraftFilters(draft, tag.selection);
  assert.deepEqual(output.tag, ["all:night,rain", "night"]);
  assert.deepEqual(galleryFiltersFromSearchParams(galleryRouteSearchParams(output), facets.tags), output);
  assert.deepEqual(publicFilterChips(draft, tag.selection, facets).map(c => [c.section, c.label, c.exclude]), [
    ["device", "自动判断", false], ["theme", "城市", true],
    ["tag", "夜景", false], ["tag", "雨景", false], ["author", "作者", false]
  ]);
  const emptyNextGroup = { ...tag.selection, groups: [...tag.selection.groups, { id: 3, mode: "any" as const, selected: [] }], activeId: 3 };
  assert.deepEqual(publicDraftFilters(draft, emptyNextGroup), output);
  assert.deepEqual(filters.tag, ["all:rain,night", "night"], "草稿编辑不改变已应用条件");
});

test("[Web/公开筛选] 目录解析隔离未知标签，清空可恢复，组数和总预算有界", () => {
  const draft = createPublicFilterDraft(emptyGalleryFilters, ["all:夜景,雨景", "night"]);
  assert.match(resolvePublicFilterTag(draft, undefined).error!, /读取标签目录/);
  assert.equal(resolvePublicFilterTag(draft, facets).error, null);
  assert.match(resolvePublicFilterTag(createPublicFilterDraft({ ...emptyGalleryFilters, tag: "missing" }), facets).error!, /missing/);
  assert.equal(resolvePublicFilterTag(createPublicFilterDraft(), undefined).error, null);
  assert.equal(createTagSelection(Array(9).fill("night")).groups.length, 9);
  assert.throws(() => createTagSelection(Array(10).fill("night")), /9 组/);
  assert.throws(() => createTagSelection([Array(33).fill("night").join(",")]), /32/);
  assert.throws(() => publicDraftFilters({ ...createPublicFilterDraft(), theme: { mode: "include", selected: Array.from({length:40}, (_, i) => `theme-${i}-${"x".repeat(25)}`) } }, createTagSelection()), /条件过多/);
});

test("[Web/公开筛选] 首页和弹窗统计与图片列表使用相同规范条件和自动设备投影", () => {
  for (const ua of ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", ""]) {
    const filters = { ...emptyGalleryFilters, device: "auto", theme: "!city,!city", author: "artist", tag: ["night", "all:rain,night"] };
    const stats = new URLSearchParams(galleryStatsSearch(filters, ua));
    const list = imageBrowseApiSearchParams(filters, "latest", { view: "gallery", userAgent: ua, limit: 60 });
    for (const key of ["order", "view", "limit"]) list.delete(key);
    list.sort(); stats.sort();
    assert.equal(list.toString(), stats.toString());
    assert.equal(galleryStatsSearch(filters, ua), galleryStatsSearch({ ...filters, tag: ["all:night,rain", "night"] }, ua));
  }
});

test("[Web/公开筛选] 拼音与首字母高亮复用搜索排序，完整目录不受建议上限截断", () => {
  for (const query of ["ceshi", "cs", "ce试"]) {
    const match = matchPinyinFacetText("测试森林", query);
    assert.ok(match, query);
    assert.deepEqual(match.ranges, [[0, 2]]);
  }
  const options = [{ slug: "cs", display_name: "精确" }, { slug: "forest", display_name: "测试森林" }, ...Array.from({ length: 80 }, (_, i) => ({ slug: `test-${i}`, display_name: `测试${i}` }))];
  const all = facetSuggestions(options, "cs", undefined, matchPinyinFacetText, Infinity);
  assert.equal(all[0].slug, "cs");
  assert.equal(all.length, 82);
  assert.equal(facetSuggestions(options, "cs", undefined, matchPinyinFacetText).length, 50);
  assert.equal(matchPinyinFacetText("森林", "no-match"), null);
});

test("[Web/公开筛选] 零图片选项在更新与失败期间保持禁用，已选项和不限可撤销", () => {
  for (const unverified of [true, false]) {
    assert.equal(publicFilterOptionState({ selected: false, count: 0, unverified }).disabled, true);
    assert.deepEqual(publicFilterOptionState({ selected: true, count: 0, unverified }), { disabled: false, locked: false });
    assert.deepEqual(publicFilterOptionState({ selected: false, count: undefined, unverified, unrestricted: true }), { disabled: false, locked: false });
  }
  assert.equal(publicFilterOptionState({ selected: false, count: undefined, unverified: false }).locked, true);
});

test("[Web/公开筛选] 统计共享查询、取消旧请求，失败仍显示最后数量并锁定新增选择", async (t) => {
  const h = await createConfigStreamHarness(t);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => client.clear());
  let change!: (value: string) => void;
  let observed!: ReturnType<typeof usePublicFilterStats>;
  function Probe({ search }: { search: string }) { observed = usePublicFilterStats(search); return null; }
  function Harness() {
    const [search, setSearch] = h.React.useState(""); change = setSearch;
    return h.React.createElement(h.React.Fragment, null, h.React.createElement(Probe, { search }), h.React.createElement(Probe, { search }));
  }
  await h.render(h.React.createElement(QueryClientProvider, { client }, h.React.createElement(Harness)));
  assert.equal(h.pending.length, 1, "两个消费者共享一次读取");
  const stats: GalleryStatsDto = { matching_images: 4, total_images: 4, devices: [], brightnesses: [], categories: [], themes: [], tags: [], authors: [] };
  await h.respond(0, stats);
  assert.equal(observed.displayData?.matching_images, 4);
  await h.React.act(async () => change("theme=city"));
  assert.equal(observed.displayData?.matching_images, 4);
  assert.equal(observed.availabilityUnverified, true);
  await h.React.act(async () => change("theme=forest"));
  assert.equal(h.pending[1].signal?.aborted, true);
  await h.respond(2, { error: "unavailable" }, 503);
  assert.equal(observed.displayData?.matching_images, 4);
  assert.equal(observed.availabilityUnverified, true);
  await h.React.act(async () => { void observed.refetch(); });
  await h.respond(3, { ...stats, matching_images: 2 });
  assert.equal(observed.displayData?.matching_images, 2);
  assert.equal(observed.availabilityUnverified, false);
  await h.render(null);
});

test("[Web/公开筛选] 刷新光带完成当前周期，减少动态效果及卸载不遗留运行", async (t) => {
  const h = await createConfigStreamHarness(t);
  let setRefreshing!: (value: boolean) => void;
  let setReduced!: (value: boolean) => void;
  let glint!: ReturnType<typeof useRefreshGlint>;
  function Probe() {
    const [refreshing, update] = h.React.useState(true); setRefreshing = update;
    const [reduced, reduce] = h.React.useState(false); setReduced = reduce;
    glint = useRefreshGlint(useRefreshGlintRun(refreshing), refreshing, reduced);
    return null;
  }
  await h.render(h.React.createElement(Probe));
  assert.equal(glint.active, true);
  await h.React.act(async () => glint.finishCycle());
  assert.equal(glint.active, true);
  await h.React.act(async () => setRefreshing(false));
  assert.equal(glint.active, true, "请求完成不截断动画");
  await h.React.act(async () => glint.finishCycle());
  assert.equal(glint.active, false);
  await h.React.act(async () => setRefreshing(true));
  assert.equal(glint.active, true);
  await h.React.act(async () => { setReduced(true); setRefreshing(false); });
  assert.equal(glint.active, false);
  await h.render(null);
});

test("[Web/公开筛选] 输入法组词只改变临时文本，确认后搜索且忽略失焦后的迟到事件", async (t) => {
  const h = await createConfigStreamHarness(t);
  let input!: ReturnType<typeof useImeSearchInput>;
  const published: string[] = [];
  function Probe() {
    const [query, setQuery] = h.React.useState("");
    input = useImeSearchInput(query, value => { published.push(value); setQuery(value); });
    return h.React.createElement("input", { ...input.inputProps });
  }
  await h.render(h.React.createElement(Probe));
  const element = h.document.querySelector("input")!;
  Object.defineProperty(h.document, "activeElement", { configurable: true, get: () => element });
  const change = (value: string, composing: boolean) => {
    element.value = value;
    input.inputProps.onChange({ currentTarget: element, nativeEvent: { isComposing: composing } } as unknown as ChangeEvent<HTMLInputElement>);
  };
  const end = () => input.inputProps.onCompositionEnd({ currentTarget: element } as CompositionEvent<HTMLInputElement>);
  await h.React.act(async () => { input.inputProps.onFocus(); input.inputProps.onCompositionStart(); change("ce'shi", true); });
  assert.equal(input.text, "ce'shi"); assert.deepEqual(published, []);
  await h.React.act(async () => { element.value = "测试"; end(); });
  assert.equal(input.text, "测试"); assert.deepEqual(published, ["测试"]);
  await h.React.act(async () => { input.inputProps.onCompositionStart(); change("sen'lin", true); });
  await h.React.act(async () => input.inputProps.onBlur({ currentTarget: element } as FocusEvent<HTMLInputElement>));
  await h.React.act(async () => { element.value = "森林"; end(); });
  assert.equal(element.value, "测试"); assert.deepEqual(published, ["测试"]);
  await h.React.act(async () => input.reset());
  await h.React.act(async () => change("cs", false));
  assert.equal(input.text, "cs"); assert.deepEqual(published, ["测试", "", "cs"]);
});

test("[Web/公开筛选] 应用等待滚动解锁且只写入一次，取消与路由返回撤销旧草稿", async (t) => {
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  const h = await createConfigStreamHarness(t, { animationFrame: {
    requestAnimationFrame: cb => { frames.set(++serial, cb); return serial; },
    cancelAnimationFrame: id => { frames.delete(id); }
  } });
  Object.assign(h.window, { scrollY: 24, scrollTo() {} });
  let dialog!: ReturnType<typeof usePublicFilterDialog>;
  let navigate!: ReturnType<typeof useNavigate>;
  const applied: unknown[] = [];
  function Probe() {
    navigate = useNavigate();
    dialog = usePublicFilterDialog({ filters: emptyGalleryFilters, ready: true, params: new URLSearchParams(), applyFilters: filters => { applied.push(filters); } });
    usePageScrollLock(Boolean(dialog.session));
    return null;
  }
  const advance = async () => {
    while (frames.size) await h.React.act(async () => {
      const current = [...frames.values()]; frames.clear(); current.forEach(cb => cb(0));
    });
  };
  await h.render(h.React.createElement(MemoryRouter, { initialEntries: ["/gallery"] }, h.React.createElement(Probe)));
  await h.React.act(async () => dialog.open());
  await h.React.act(async () => dialog.applyAfterClose({ ...emptyGalleryFilters, theme: "city" }));
  assert.deepEqual(applied, []); assert.equal(dialog.active, true);
  await advance();
  assert.deepEqual(applied, [{ ...emptyGalleryFilters, theme: "city" }]);
  assert.equal(dialog.active, false);
  await h.React.act(async () => dialog.open());
  await h.React.act(async () => dialog.close());
  await advance(); assert.equal(applied.length, 1);
  await h.React.act(async () => dialog.open());
  const oldApply = dialog.applyAfterClose;
  await h.React.act(async () => dialog.applyAfterClose({ ...emptyGalleryFilters, tag: "night" }));
  await h.React.act(async () => { await navigate("/gallery?theme=forest"); });
  await advance(); assert.equal(applied.length, 1);
  await h.React.act(async () => oldApply({ ...emptyGalleryFilters, author: "artist" }));
  assert.equal(applied.length, 1); assert.equal(dialog.session, null);
  await h.render(null);
  assert.equal(frames.size, 0);
});
