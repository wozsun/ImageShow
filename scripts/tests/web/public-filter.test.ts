import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseGalleryTagFilter, type GalleryStatsDto } from "@imageshow/shared/browser";
import {
  createPublicFilterDraft,
  publicDraftFilters,
  publicFilterChips,
  groupPublicFilterChips,
  resolvePublicFilterTag,
  createTagSelection
} from "../../../packages/web/src/lib/gallery/public-filter-draft.ts";
import {
  emptyGalleryFilters,
  galleryFiltersFromSearchParams,
  galleryRouteSearchParams,
  galleryStatsSearch,
  imageBrowseApiSearchParams
} from "../../../packages/web/src/lib/gallery/gallery-query.ts";
import { publicFilterOptionState } from "../../../packages/web/src/lib/gallery/public-filter-options.ts";
import { facetSuggestions } from "../../../packages/web/src/lib/ui/facet-input.ts";
import { matchPinyinFacetText } from "../../../packages/web/src/lib/ui/pinyin-facet-input.ts";
import { usePublicFilterStats } from "../../../packages/web/src/hooks/usePublicFilterStats.ts";
import {
  useRefreshGlint,
  useRefreshGlintRun
} from "../../../packages/web/src/hooks/useRefreshGlint.ts";
import { createConfigStreamHarness } from "../support/web-test-context.ts";
import { MemoryRouter, useNavigate } from "react-router";
import { usePublicFilterDialog } from "../../../packages/web/src/hooks/usePublicFilterDialog.ts";
import { usePageScrollLock } from "../../../packages/web/src/hooks/usePageScrollLock.ts";
import { useImeSearchInput } from "../../../packages/web/src/hooks/useImeSearchInput.ts";
import type { ChangeEvent, CompositionEvent, FocusEvent } from "react";
import { gallerySelectorValue } from "../../../packages/web/src/lib/gallery/gallery-selectors.ts";
import { useImageBrowseRoute } from "../../../packages/web/src/hooks/useImageBrowseRoute.ts";
import { PublicFilterErrorState } from "../../../packages/web/src/components/feedback/PublicFilterErrorState.tsx";
import { PublicFilterDialog } from "../../../packages/web/src/components/image/filter/PublicFilterDialog.tsx";
import { HomeCatalog } from "../../../packages/web/src/pages/home/HomeCatalog.tsx";
import { queryKeys } from "../../../packages/web/src/lib/api/query-keys.ts";

const facets = {
  themes: [{ slug: "city", display_name: "城市" }],
  tags: [
    { slug: "night", display_name: "夜景" },
    { slug: "rain", display_name: "雨景" }
  ],
  authors: [{ slug: "artist", display_name: "作者", link: "" }]
};

test("[Web/公开筛选] 主题和作者共享 32 项及字符边界，拒绝混合条件和无效片段", () => {
  const slugs = Array.from({ length: 33 }, (_, index) => `s${index}`);
  for (const field of ["theme", "author"] as const) {
    for (const mode of ["include", "exclude"] as const) {
      const draft = createPublicFilterDraft();
      draft[field] = { mode, selected: slugs.slice(0, 32) };
      const value = publicDraftFilters(draft, createTagSelection())[field];
      assert.equal(value.split(",").length, 32);
      assert.equal(
        galleryFiltersFromSearchParams(new URLSearchParams({ [field]: value }))[field],
        value
      );
      draft[field].selected.push(slugs[32]);
      assert.throws(() => publicDraftFilters(draft, createTagSelection()), /最多选择 32 项/);
    }
    assert.equal(gallerySelectorValue(field, ["b", "a", "b"]), "a,b");
    for (const value of ["a,!b", "a,invalid_slug", "!", "a,", "x".repeat(33)]) {
      assert.throws(() => galleryFiltersFromSearchParams(new URLSearchParams({ [field]: value })), {
        name: "GallerySelectorError",
        field
      });
    }
    assert.throws(
      () =>
        gallerySelectorValue(
          field,
          Array.from({ length: 32 }, (_, i) => `s${String(i).padStart(2, "0")}${"x".repeat(29)}`)
        ),
      /长度限制/
    );
  }
});

test("[Web/公开筛选] 重复标签组按最终表达式占用额度，编辑和统计仍保留组身份", () => {
  const terms = Array.from({ length: 20 }, (_, i) => `t${i}`);
  const groups = [`all:${terms.join(",")}`, `all:${[...terms].reverse().join(",")}`];
  const draft = createPublicFilterDraft({ ...emptyGalleryFilters, tag: groups });
  const output = publicDraftFilters(draft, createTagSelection(groups));
  assert.equal((output.tag as string[]).length, 2);
  assert.equal(parseGalleryTagFilter(output.tag as string[]).termCount, 20);
  const api = imageBrowseApiSearchParams(output, "latest", { view: "gallery" });
  assert.equal(api.getAll("tag").length, 1);
  assert.equal(new URLSearchParams(galleryStatsSearch(output, "", 2)).getAll("tag").length, 2);
  assert.throws(() => createTagSelection([groups[0], "all:" + terms.slice(0, 13).join(",")]), /32/);
});

test("[Web/公开筛选] 取消标签使重复组拆开超额时仍可继续移除，恢复后再统计应用", async (t) => {
  const h = await createConfigStreamHarness(t);
  Object.assign(h.window, {
    scrollY: 0,
    scrollTo() {},
    getComputedStyle: () => ({ paddingRight: "0px", getPropertyValue: () => "16px" })
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } }
  });
  t.after(() => client.clear());
  const options = Array.from({ length: 17 }, (_, i) => ({
    slug: `t${i}`,
    display_name: `标签${i}`,
    image_count: 1
  }));
  const group =
    "all:" +
    options
      .map((option) => option.slug)
      .sort()
      .join(",");
  const filters = { ...emptyGalleryFilters, tag: [group, group] };
  const stats: GalleryStatsDto = {
    total_images: 1,
    matching_images: 1,
    themes: [],
    authors: [],
    tags: options,
    devices: [],
    brightnesses: [],
    categories: [],
    tag_groups: [
      { tag: group, image_count: 1 },
      { tag: group, image_count: 1 }
    ]
  };
  client.setQueryData([...queryKeys.galleryStats, ""], stats);
  client.setQueryData([...queryKeys.galleryStats, galleryStatsSearch(filters, "", 2)], stats);
  await h.render(
    h.React.createElement(
      QueryClientProvider,
      { client },
      h.React.createElement(PublicFilterDialog, {
        filters,
        unresolvedTags: [],
        facets: { themes: [], authors: [], tags: options },
        facetsLoading: false,
        facetsError: null,
        retryVocabulary() {},
        returnFocusRef: { current: null },
        onClose() {},
        onApply() {},
        view: "gallery"
      })
    )
  );
  const card = (slug: string) =>
    h.document.querySelector<HTMLButtonElement>(
      `[data-filter-section="tag"] [data-filter-option="${slug}"]`
    )!;
  const apply = () => h.document.querySelector<HTMLButtonElement>(".public-filter-apply")!;
  await h.React.act(async () => card("t0").click());
  assert.equal(card("t0").getAttribute("aria-pressed"), "false", "不能吞掉取消动作");
  assert.equal(apply().disabled, true);
  assert.match(
    h.document.querySelector('.public-filter-notice[role="alert"]')!.textContent!,
    /去重后最多 32/
  );
  assert.equal(h.pending.length, 0, "暂时超额不得发送无效统计");
  assert.equal(card("t1").disabled, false, "已有选择仍可继续取消");
  await h.React.act(async () => card("t1").click());
  assert.equal(card("t1").getAttribute("aria-pressed"), "false");
  assert.equal(apply().disabled, false);
  assert.equal(h.document.querySelector('.public-filter-notice[role="alert"]'), null);
  assert.equal(h.pending.length, 1);
  const params = new URL(h.pending[0].path, "https://img.example").searchParams;
  assert.equal(parseGalleryTagFilter(params.getAll("tag")).termCount, 32);
  assert.equal(params.get("tag_scope"), "2");
  await h.render(null);
});

test("[Web/公开筛选] 无效链接逐字段恢复，弹窗取消不丢条件且分享保持禁用", async (t) => {
  const h = await createConfigStreamHarness(t);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } }
  });
  t.after(() => client.clear());
  client.setQueryData(queryKeys.galleryFacets, facets);
  let route!: ReturnType<typeof useImageBrowseRoute>;
  let dialog!: ReturnType<typeof usePublicFilterDialog>;
  function Probe() {
    route = useImageBrowseRoute();
    dialog = usePublicFilterDialog(route);
    return route.error
      ? h.React.createElement(PublicFilterErrorState, {
          error: route.error,
          onClear: (field) => route.updateFilter(field, ""),
          onRetry: route.retryVocabulary
        })
      : null;
  }
  const original =
    "theme=city%2C%21forest&author=artist%2C%21other&tag=all%3A&device=pc&brightness=dark";
  await h.render(
    h.React.createElement(
      QueryClientProvider,
      { client },
      h.React.createElement(
        MemoryRouter,
        { initialEntries: ["/gallery?" + original] },
        h.React.createElement(Probe)
      )
    )
  );
  assert.equal(route.ready, false);
  assert.equal(route.getPageUrl("latest"), null);
  assert.equal(route.randomLink.url, null);
  await h.React.act(async () => dialog.open());
  const session = dialog.session!;
  const draft = createPublicFilterDraft(
    session.filters,
    session.unresolvedTags,
    session.unresolvedSelectors
  );
  assert.deepEqual(draft.theme.unresolved, ["city,!forest"]);
  assert.deepEqual(draft.author.unresolved, ["artist,!other"]);
  assert.throws(() => publicDraftFilters(draft, createTagSelection()), /不能同时/);
  await h.React.act(async () => dialog.close());
  assert.equal(route.params.toString(), original);
  for (const field of ["theme", "author", "tag"] as const) {
    const button = [...h.document.querySelectorAll("button")].find(
      (button) =>
        button.textContent === `清空${{ theme: "主题", author: "作者", tag: "标签" }[field]}条件`
    )!;
    assert.ok(button);
    await h.React.act(async () => button.click());
    if (field !== "tag") assert.equal(route.ready, false);
  }
  assert.equal(route.ready, true);
  assert.equal(route.params.toString(), "device=pc&brightness=dark");
  assert.ok(route.getPageUrl("latest"));
  assert.ok(route.randomLink.url);
  assert.equal(h.pending.length, 0);
  await h.React.act(async () => route.updateFilter("theme", "city,!forest"));
  await h.React.act(async () => route.clearFilters());
  assert.equal(route.ready, true);
  assert.equal(route.params.toString(), "");
});

test("[Web/公开筛选] 弹窗可逐项清除损坏条件，所有错误解除前不能应用或统计", async (t) => {
  const h = await createConfigStreamHarness(t);
  Object.assign(h.window, {
    scrollY: 0,
    scrollTo() {},
    getComputedStyle: () => ({ paddingRight: "0px", getPropertyValue: () => "16px" })
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } }
  });
  t.after(() => client.clear());
  await h.render(
    h.React.createElement(
      QueryClientProvider,
      { client },
      h.React.createElement(PublicFilterDialog, {
        filters: { ...emptyGalleryFilters, device: "pc" },
        unresolvedTags: ["all:"],
        unresolvedSelectors: { theme: ["city,!forest"], author: ["artist,!other"] },
        facets,
        facetsLoading: false,
        facetsError: null,
        retryVocabulary() {},
        returnFocusRef: { current: null },
        onClose() {},
        onApply() {},
        view: "gallery"
      })
    )
  );
  const apply = () => h.document.querySelector<HTMLButtonElement>(".public-filter-apply")!;
  const clear = async (label: string) =>
    h.React.act(async () => {
      const button = [...h.document.querySelectorAll("button")].find(
        (button) => button.textContent === `清除${label}条件`
      )!;
      assert.ok(button);
      button.click();
    });
  assert.equal(apply().disabled, true);
  await clear("主题");
  assert.equal(apply().disabled, true);
  assert.match(h.document.body.textContent!, /artist,!other/);
  await clear("作者");
  assert.equal(apply().disabled, true);
  assert.equal(h.pending.filter((request) => request.path.includes("device=pc")).length, 0);
  await clear("标签");
  assert.equal(apply().disabled, false);
  assert.equal(h.pending.filter((request) => request.path.includes("device=pc")).length, 1);
  await h.render(null);
});

test("[Web/首页] 第 33 个主题或作者被拒绝，移除已有项后可以重新选择", async (t) => {
  const h = await createConfigStreamHarness(t);
  const options = Array.from({ length: 33 }, (_, i) => ({
    slug: `s${i}`,
    display_name: `选项${i}`,
    image_count: 1
  }));
  const stats: GalleryStatsDto = {
    total_images: 33,
    matching_images: 33,
    themes: options,
    authors: options.map((option) => ({ ...option, link: "" })),
    tags: [],
    devices: [],
    brightnesses: [],
    categories: []
  };
  let selected = emptyGalleryFilters;
  function Probe() {
    const [filters, change] = h.React.useState({
      ...emptyGalleryFilters,
      theme: options
        .slice(0, 32)
        .map((o) => o.slug)
        .join(","),
      author: options
        .slice(0, 32)
        .map((o) => o.slug)
        .join(",")
    });
    selected = filters;
    return h.React.createElement(HomeCatalog, {
      catalogRef: { current: null },
      armed: false,
      filters,
      stats,
      isPending: false,
      isError: false,
      isRefreshing: false,
      availabilityUnverified: false,
      onFiltersChange: change,
      tagMode: "any",
      onTagModeChange() {},
      onRetry() {},
      onCatalogIntent() {}
    });
  }
  await h.render(h.React.createElement(Probe));
  for (const field of ["theme", "author"] as const) {
    const buttons = () => [
      ...h.document.querySelectorAll<HTMLButtonElement>(`.home-${field}-options button`)
    ];
    await h.React.act(async () => buttons()[32].click());
    assert.equal(selected[field].split(",").length, 32);
    assert.match(h.document.body.textContent!, /最多选择 32 项/);
    assert.equal(buttons()[32].getAttribute("aria-pressed"), "false");
    await h.React.act(async () => buttons()[0].click());
    await h.React.act(async () => buttons()[32].click());
    assert.equal(buttons()[32].getAttribute("aria-pressed"), "true");
    assert.equal(selected[field].split(",").length, 32);
    assert.equal(h.document.querySelector('[role="alert"]'), null);
  }
});

test("[Web/公开筛选] 弹窗拒绝第 33 项且保留当前可应用的包含或排除条件", async (t) => {
  for (const field of ["theme", "author"] as const)
    for (const exclude of [false, true]) {
      await t.test(`${field}/${exclude ? "exclude" : "include"}`, async (t) => {
        const h = await createConfigStreamHarness(t);
        Object.assign(h.window, {
          scrollY: 0,
          scrollTo() {},
          getComputedStyle: () => ({ paddingRight: "0px", getPropertyValue: () => "16px" })
        });
        const client = new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: Infinity } }
        });
        t.after(() => client.clear());
        const options = Array.from({ length: 33 }, (_, i) => ({
          slug: `s${i}`,
          display_name: `选项${i}`,
          image_count: 1,
          link: ""
        }));
        const filters = {
          ...emptyGalleryFilters,
          [field]: options
            .slice(0, 32)
            .map((o) => `${exclude ? "!" : ""}${o.slug}`)
            .join(",")
        };
        const stats: GalleryStatsDto = {
          total_images: 33,
          matching_images: 1,
          themes: options,
          authors: options,
          tags: [],
          devices: [],
          brightnesses: [],
          categories: []
        };
        client.setQueryData([...queryKeys.galleryStats, ""], stats);
        client.setQueryData([...queryKeys.galleryStats, galleryStatsSearch(filters)], stats);
        await h.render(
          h.React.createElement(
            QueryClientProvider,
            { client },
            h.React.createElement(PublicFilterDialog, {
              filters,
              unresolvedTags: [],
              facets: { themes: options, authors: options, tags: [] },
              facetsLoading: false,
              facetsError: null,
              retryVocabulary() {},
              returnFocusRef: { current: null },
              onClose() {},
              onApply() {},
              view: "gallery"
            })
          )
        );
        const card = () =>
          h.document.querySelector<HTMLButtonElement>(
            `[data-filter-section="${field}"] [data-filter-option="s32"]`
          )!;
        assert.notEqual(card().getAttribute("aria-disabled"), "true");
        await h.React.act(async () => card().click());
        assert.equal(card().getAttribute("aria-pressed"), "false");
        assert.match(h.document.body.textContent!, /最多选择 32 项/);
        assert.equal(
          h.document.querySelector(".public-filter-selected-count b")?.textContent,
          "32"
        );
        assert.equal(
          h.document.querySelector<HTMLButtonElement>(".public-filter-apply")!.disabled,
          false
        );
        assert.equal(h.pending.length, 0, "被拒绝的选择不能产生无效统计请求");
        await h.render(null);
      });
    }
});

test("[Web/公开筛选] 草稿分组往返保留或且边界，跨组重复只显示一个已选项", () => {
  const filters = {
    ...emptyGalleryFilters,
    device: "auto",
    theme: "!city",
    author: "artist",
    tag: ["all:rain,night", "night"]
  };
  const draft = createPublicFilterDraft(filters);
  const tag = resolvePublicFilterTag(draft, facets);
  assert.equal(tag.error, null);
  assert.deepEqual(
    tag.selection.groups.map((g) => g.mode),
    ["all", "any"]
  );
  assert.equal(tag.selection.activeId, 2);
  const output = publicDraftFilters(draft, tag.selection);
  assert.deepEqual(output.tag, ["all:night,rain", "night"]);
  assert.deepEqual(
    galleryFiltersFromSearchParams(galleryRouteSearchParams(output), facets.tags),
    output
  );
  assert.deepEqual(
    publicFilterChips(draft, tag.selection, facets).map((c) => [c.section, c.label, c.exclude]),
    [
      ["device", "自动判断", false],
      ["theme", "城市", true],
      ["tag", "夜景", false],
      ["tag", "雨景", false],
      ["author", "作者", false]
    ]
  );
  const emptyNextGroup = {
    ...tag.selection,
    groups: [...tag.selection.groups, { id: 3, mode: "any" as const, selected: [] }],
    activeId: 3
  };
  assert.deepEqual(publicDraftFilters(draft, emptyNextGroup), output);
  assert.deepEqual(filters.tag, ["all:rain,night", "night"], "草稿编辑不改变已应用条件");
});

test("[Web/公开筛选] 目录解析隔离未知标签，清空可恢复，组数和总预算有界", () => {
  const draft = createPublicFilterDraft(emptyGalleryFilters, ["all:夜景,雨景", "night"]);
  assert.match(resolvePublicFilterTag(draft, undefined).error!, /读取标签目录/);
  assert.equal(resolvePublicFilterTag(draft, facets).error, null);
  assert.match(
    resolvePublicFilterTag(
      createPublicFilterDraft({ ...emptyGalleryFilters, tag: "missing" }),
      facets
    ).error!,
    /missing/
  );
  assert.equal(resolvePublicFilterTag(createPublicFilterDraft(), undefined).error, null);
  assert.equal(createTagSelection(Array(9).fill("night")).groups.length, 9);
  assert.throws(() => createTagSelection(Array(10).fill("night")), /9 组/);
  assert.throws(
    () => createTagSelection([Array.from({ length: 33 }, (_, i) => `night-${i}`).join(",")]),
    /32/
  );
  assert.throws(
    () =>
      publicDraftFilters(
        {
          ...createPublicFilterDraft(),
          theme: { mode: "include", selected: Array.from({ length: 40 }, (_, i) => `theme-${i}`) }
        },
        createTagSelection()
      ),
    /最多选择 32 项/
  );
});

test("[Web/公开筛选] 统计与列表匹配语义相同，统计保留组边界和当前且组", () => {
  for (const ua of [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    ""
  ]) {
    const filters = {
      ...emptyGalleryFilters,
      device: "auto",
      theme: "!city,!city",
      author: "artist",
      tag: ["night", "all:rain,night"]
    };
    const stats = new URLSearchParams(galleryStatsSearch(filters, ua));
    const list = imageBrowseApiSearchParams(filters, "latest", {
      view: "gallery",
      userAgent: ua,
      limit: 60
    });
    for (const key of ["order", "view", "limit"]) list.delete(key);
    assert.deepEqual(
      parseGalleryTagFilter(list.getAll("tag")).expression,
      parseGalleryTagFilter(stats.getAll("tag")).expression
    );
    assert.deepEqual(stats.getAll("tag"), filters.tag);
    list.delete("tag");
    stats.delete("tag");
    list.sort();
    stats.sort();
    assert.equal(list.toString(), stats.toString());
    assert.equal(new URLSearchParams(galleryStatsSearch(filters, ua, 2)).get("tag_scope"), "2");
    assert.equal(
      new URLSearchParams(galleryStatsSearch({ ...filters, tag: "all:night" }, ua)).get(
        "tag_scope"
      ),
      "1"
    );
    assert.equal(
      new URLSearchParams(galleryStatsSearch({ ...filters, tag: "all:night" }, ua, null)).get(
        "tag_scope"
      ),
      null
    );
  }
});

test("[Web/公开筛选] 已选栏按非空组展示或且，跨组重复标签去重计数", () => {
  const draft = createPublicFilterDraft({
    ...emptyGalleryFilters,
    theme: "!city",
    tag: ["night,rain", "all:night,rain"]
  });
  const selection = resolvePublicFilterTag(draft, facets).selection;
  const chips = publicFilterChips(draft, selection, facets);
  assert.equal(chips.filter((chip) => chip.section === "tag").length, 2);
  assert.deepEqual(
    groupPublicFilterChips(chips, selection)
      .filter((chip) => chip.section === "tag")
      .map((chip) => [chip.groupId, chip.label]),
    [
      [1, "夜景 / 雨景"],
      [2, "夜景 & 雨景"]
    ]
  );
  const withEmptyGroup = {
    ...selection,
    groups: [...selection.groups, { id: 3, mode: "any" as const, selected: [] }],
    activeId: 3
  };
  assert.deepEqual(
    groupPublicFilterChips(chips, withEmptyGroup),
    groupPublicFilterChips(chips, selection)
  );
});

test("[Web/公开筛选] 拼音与首字母高亮复用搜索排序，完整目录不受建议上限截断", () => {
  for (const query of ["ceshi", "cs", "ce试"]) {
    const match = matchPinyinFacetText("测试森林", query);
    assert.ok(match, query);
    assert.deepEqual(match.ranges, [[0, 2]]);
  }
  const options = [
    { slug: "cs", display_name: "精确" },
    { slug: "forest", display_name: "测试森林" },
    ...Array.from({ length: 80 }, (_, i) => ({ slug: `test-${i}`, display_name: `测试${i}` }))
  ];
  const all = facetSuggestions(options, "cs", undefined, matchPinyinFacetText, Infinity);
  assert.equal(all[0].slug, "cs");
  assert.equal(all.length, 82);
  assert.equal(facetSuggestions(options, "cs", undefined, matchPinyinFacetText).length, 50);
  assert.equal(matchPinyinFacetText("森林", "no-match"), null);
});

test("[Web/公开筛选] 零图片选项在更新与失败期间保持禁用，已选项和不限可撤销", () => {
  for (const unverified of [true, false]) {
    assert.equal(publicFilterOptionState({ selected: false, count: 0, unverified }).disabled, true);
    assert.deepEqual(publicFilterOptionState({ selected: true, count: 0, unverified }), {
      disabled: false,
      locked: false
    });
    assert.deepEqual(
      publicFilterOptionState({
        selected: false,
        count: undefined,
        unverified,
        unrestricted: true
      }),
      { disabled: false, locked: false }
    );
  }
  assert.equal(
    publicFilterOptionState({ selected: false, count: undefined, unverified: false }).locked,
    true
  );
});

test("[Web/公开筛选] 统计共享查询、取消旧请求，失败仍显示最后数量并锁定新增选择", async (t) => {
  const h = await createConfigStreamHarness(t);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => client.clear());
  let change!: (value: string) => void;
  let observed!: ReturnType<typeof usePublicFilterStats>;
  function Probe({ search }: { search: string }) {
    observed = usePublicFilterStats(search);
    return null;
  }
  function Harness() {
    const [search, setSearch] = h.React.useState("");
    change = setSearch;
    return h.React.createElement(
      h.React.Fragment,
      null,
      h.React.createElement(Probe, { search }),
      h.React.createElement(Probe, { search })
    );
  }
  await h.render(
    h.React.createElement(QueryClientProvider, { client }, h.React.createElement(Harness))
  );
  assert.equal(h.pending.length, 1, "两个消费者共享一次读取");
  const stats: GalleryStatsDto = {
    matching_images: 4,
    total_images: 4,
    devices: [],
    brightnesses: [],
    categories: [],
    themes: [],
    tags: [],
    authors: []
  };
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
  await h.React.act(async () => {
    void observed.refetch();
  });
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
    const [refreshing, update] = h.React.useState(true);
    setRefreshing = update;
    const [reduced, reduce] = h.React.useState(false);
    setReduced = reduce;
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
  await h.React.act(async () => {
    setReduced(true);
    setRefreshing(false);
  });
  assert.equal(glint.active, false);
  await h.render(null);
});

test("[Web/公开筛选] 输入法组词只改变临时文本，确认后搜索且忽略失焦后的迟到事件", async (t) => {
  const h = await createConfigStreamHarness(t);
  let input!: ReturnType<typeof useImeSearchInput>;
  const published: string[] = [];
  function Probe() {
    const [query, setQuery] = h.React.useState("");
    input = useImeSearchInput(query, (value) => {
      published.push(value);
      setQuery(value);
    });
    return h.React.createElement("input", { ...input.inputProps });
  }
  await h.render(h.React.createElement(Probe));
  const element = h.document.querySelector("input")!;
  Object.defineProperty(h.document, "activeElement", { configurable: true, get: () => element });
  const change = (value: string, composing: boolean) => {
    element.value = value;
    input.inputProps.onChange({
      currentTarget: element,
      nativeEvent: { isComposing: composing }
    } as unknown as ChangeEvent<HTMLInputElement>);
  };
  const end = () =>
    input.inputProps.onCompositionEnd({
      currentTarget: element
    } as CompositionEvent<HTMLInputElement>);
  await h.React.act(async () => {
    input.inputProps.onFocus();
    input.inputProps.onCompositionStart();
    change("ce'shi", true);
  });
  assert.equal(input.text, "ce'shi");
  assert.deepEqual(published, []);
  await h.React.act(async () => {
    element.value = "测试";
    end();
  });
  assert.equal(input.text, "测试");
  assert.deepEqual(published, ["测试"]);
  await h.React.act(async () => {
    input.inputProps.onCompositionStart();
    change("sen'lin", true);
  });
  await h.React.act(async () =>
    input.inputProps.onBlur({ currentTarget: element } as FocusEvent<HTMLInputElement>)
  );
  await h.React.act(async () => {
    element.value = "森林";
    end();
  });
  assert.equal(element.value, "测试");
  assert.deepEqual(published, ["测试"]);
  await h.React.act(async () => input.reset());
  await h.React.act(async () => change("cs", false));
  assert.equal(input.text, "cs");
  assert.deepEqual(published, ["测试", "", "cs"]);
});

test("[Web/公开筛选] 应用等待滚动解锁且只写入一次，取消与路由返回撤销旧草稿", async (t) => {
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  const h = await createConfigStreamHarness(t, {
    animationFrame: {
      requestAnimationFrame: (cb) => {
        frames.set(++serial, cb);
        return serial;
      },
      cancelAnimationFrame: (id) => {
        frames.delete(id);
      }
    }
  });
  Object.assign(h.window, { scrollY: 24, scrollTo() {} });
  let dialog!: ReturnType<typeof usePublicFilterDialog>;
  let navigate!: ReturnType<typeof useNavigate>;
  const applied: unknown[] = [];
  function Probe() {
    navigate = useNavigate();
    dialog = usePublicFilterDialog({
      filters: emptyGalleryFilters,
      ready: true,
      params: new URLSearchParams(),
      unresolvedSelectors: {},
      applyFilters: (filters) => {
        applied.push(filters);
      }
    });
    usePageScrollLock(Boolean(dialog.session));
    return null;
  }
  const advance = async () => {
    while (frames.size)
      await h.React.act(async () => {
        const current = [...frames.values()];
        frames.clear();
        current.forEach((cb) => cb(0));
      });
  };
  await h.render(
    h.React.createElement(
      MemoryRouter,
      { initialEntries: ["/gallery"] },
      h.React.createElement(Probe)
    )
  );
  await h.React.act(async () => dialog.open());
  await h.React.act(async () => dialog.applyAfterClose({ ...emptyGalleryFilters, theme: "city" }));
  assert.deepEqual(applied, []);
  assert.equal(dialog.active, true);
  await advance();
  assert.deepEqual(applied, [{ ...emptyGalleryFilters, theme: "city" }]);
  assert.equal(dialog.active, false);
  await h.React.act(async () => dialog.open());
  await h.React.act(async () => dialog.close());
  await advance();
  assert.equal(applied.length, 1);
  await h.React.act(async () => dialog.open());
  const oldApply = dialog.applyAfterClose;
  await h.React.act(async () => dialog.applyAfterClose({ ...emptyGalleryFilters, tag: "night" }));
  await h.React.act(async () => {
    await navigate("/gallery?theme=forest");
  });
  await advance();
  assert.equal(applied.length, 1);
  await h.React.act(async () => oldApply({ ...emptyGalleryFilters, author: "artist" }));
  assert.equal(applied.length, 1);
  assert.equal(dialog.session, null);
  await h.render(null);
  assert.equal(frames.size, 0);
});
