import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { registerHooks } from "node:module";
import { appConfig } from "../../../../packages/shared/src/app-config.ts";
import { adminPermissions, type ImageGroupDto } from "../../../../packages/shared/src/browser.ts";
import { queryKeys } from "../../../../packages/web/src/lib/api/query-keys.ts";
import { clearCsrfToken } from "../../../../packages/web/src/lib/api/client.ts";
import { createConfigStreamHarness, adminImageListItem, editableImage } from "../../support/web-test-context.ts";
import { dispatchDomEvent, inputText } from "../../support/dom-events.ts";
import { installProperties } from "../../support/property-descriptors.ts";

async function groupPage(t: TestContext, role: "image" | "super", detail = false, initialGroups: ImageGroupDto[] | null = [
  { slug: "a", display_name: "A", image_count: 3, sort_order: 0 }
]) {
  const h = await createConfigStreamHarness(t);
  const preferenceStorage = new Map<string, string>();
  t.after(installProperties(h.window, { localStorage: {
    getItem: (key: string) => preferenceStorage.get(key) ?? null,
    setItem: (key: string, value: string) => { preferenceStorage.set(key, value); }
  } }));
  h.window.scrollTo = () => {};
  t.after(installProperties(HTMLElement.prototype, { scrollTo() {} }));
  t.after(installProperties(globalThis, {
    getComputedStyle: () => ({ overflowY: "auto", getPropertyValue: () => "", animationName: "none", animationDuration: "0s" })
  }));
  Object.assign(h.window, { location: new URL("https://img.example/admin/groups") });
  const css = registerHooks({
    load(url, context, next) {
      return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context);
    }
  });
  const { GroupAdmin } = await import("../../../../packages/web/src/pages/admin/groups/GroupAdmin.tsx");
  const { GroupDetail } = await import("../../../../packages/web/src/pages/admin/groups/GroupDetail.tsx");
  await import("../../../../packages/web/src/pages/admin/images/ImageIdInputDialog.tsx");
  await import("../../../../packages/web/src/components/image/editor/image-editor-capability.ts");
  css.deregister();
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { MemoryRouter, Routes, Route, useLocation } = await import("react-router");
  const { AuthSessionProvider } = await import("../../../../packages/web/src/hooks/useAuthSession.tsx");
  const { AdminPreferencesProvider } = await import("../../../../packages/web/src/hooks/useAdminPreferences.tsx");
  const { ActionFeedbackProvider } = await import("../../../../packages/web/src/components/feedback/ActionFeedbackRegion.tsx");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  t.after(() => { client.clear(); clearCsrfToken(); });
  const items = initialGroups ?? [];
  if (initialGroups) client.setQueryData(queryKeys.groups, { items });
  client.setQueryData(queryKeys.settings, { settings: appConfig.runtimeDefaults });
  client.setQueryData(queryKeys.me, {
    authenticated: true, username: "group-tester", role,
    permissions: role === "super" ? Object.values(adminPermissions) : [],
    preferences: {}, csrf: "group-test"
  });
  for (const key of [queryKeys.adminImages, queryKeys.publicImages, queryKeys.galleryFacets]) client.setQueryData(key, {});
  client.setQueryData(queryKeys.ingestionVocabulary, { themes: [], tags: [], authors: [] });
  client.setQueryData(queryKeys.storageOptions, { backends: [] });
  let pathname = "";
  function Location() { pathname = useLocation().pathname; return null; }
  await h.render(h.React.createElement(QueryClientProvider, { client },
    h.React.createElement(MemoryRouter, { initialEntries: [detail ? "/admin/groups/a" : "/admin/groups"] },
      h.React.createElement(AuthSessionProvider, null,
        h.React.createElement(AdminPreferencesProvider, {
          username: "group-tester", serverPreferences: { group_view_mode: "list" },
          serverPreferencesEtag: "initial", serverPreferencesUpdatedAt: Date.now()
        }, h.React.createElement(ActionFeedbackProvider, null,
          h.React.createElement(Location),
          h.React.createElement(Routes, null,
            h.React.createElement(Route, { path: "/admin/groups", element: h.React.createElement(GroupAdmin) }),
            h.React.createElement(Route, { path: "/admin/groups/:slug", element: detail ? h.React.createElement(GroupDetail) : h.React.createElement("p", null, "detail") })
          )
        ))))));
  const node = <T extends Element = HTMLElement>(selector: string) => {
    const element = h.document.querySelector<T>(selector);
    assert.ok(element, selector);
    return element;
  };
  const emit = async (element: EventTarget, event: string, properties: Record<string, unknown> = {}) => {
    await h.React.act(async () => { dispatchDomEvent(h.window, element, event, properties); });
    await h.flush();
  };
  const edit = async (selector: string, value: string) => h.React.act(async () => {
    inputText(h.window, node<HTMLInputElement>(selector), value);
  });
  const settle = () => h.React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)); });
  const resolvePreview = async (ids: string[]) => {
    const index = h.pending.length - 1;
    assert.equal(h.pending[index]!.path, "/api/admin/images/snapshot");
    assert.deepEqual(JSON.parse(String(h.pending[index]!.body)), { ids, mark_group: "a" });
    const removing = h.document.querySelector('.import-source-head h2')?.textContent?.includes("移出分组");
    await h.respond(index, { items: ids.map((id) => ({ ...editableImage(id), in_group: Boolean(removing) })) });
    await settle();
    assert.ok(node(".image-editor-modal"));
    assert.equal(h.document.querySelector(".import-source-textarea"), null);
    for (const input of h.document.querySelectorAll<HTMLInputElement>(".image-editor-modal input, .image-editor-modal textarea")) {
      assert.ok(input.hasAttribute("disabled") || input.getAttribute("aria-disabled") === "true", input.outerHTML);
    }
  };
  const confirmMembership = () => emit(node(".image-editor-modal .workflow-submit-button"), "click");
  return { ...h, client, items, node, emit, edit, settle, resolvePreview, confirmMembership, pathname: () => pathname };
}

test("[Web/分组] 分组读取失败可重试，不存在时不读取图片并提供返回入口", async (t) => {
  const h = await groupPage(t, "image", true, null);
  assert.equal(h.pending.length, 1);
  assert.equal(h.pending[0]!.path, "/api/admin/groups");
  assert.ok(h.document.body.textContent?.includes("加载中"));
  await h.respond(0, { ok: false, code: "forbidden", error: "Permission denied" }, 403);
  assert.ok(h.document.querySelector(".query-error-state"));
  assert.equal(h.document.querySelector(".group-missing-state"), null);
  assert.equal(h.pending.length, 1);
  await h.emit(h.node(".query-error-state button"), "click");
  await h.respond(1, { items: [] });
  assert.ok(h.node(".group-missing-state").textContent?.includes("分组不存在或已删除"));
  assert.equal(h.document.querySelector(".group-random-link, .image-list-controls, .admin-image-grid, .admin-pagination"), null);
  assert.equal(h.pending.length, 2, "missing groups never issue an image list request");
  await h.emit(h.node(".group-missing-state a"), "click", { button: 0 });
  assert.equal(h.pathname(), "/admin/groups");
});

test("[Web/分组] 成员操作 404 只刷新分组并显示已删除状态", async (t) => {
  for (const entry of ["toolbar", "card", "id"] as const) {
    await t.test(entry, async (t) => {
      const h = await groupPage(t, "image", true);
      const item = adminImageListItem({ title: "member" });
      await h.respond(0, { items: [item], total: 1 });
      if (entry === "id") {
        await h.emit(h.node('[aria-label="加入分组"]'), "click");
        await h.edit('[aria-label="图片 ID"]', item.id);
        await h.emit(h.node(".import-source-submit-button"), "click");
        await h.resolvePreview([item.id]);
        await h.confirmMembership();
      } else {
        if (entry === "toolbar") await h.emit(h.node(".admin-image-card-detail"), "click", { shiftKey: true });
        await h.emit(h.node(entry === "toolbar" ? '[aria-label="移出分组"]' : '[aria-label="移出分组：member"]'), "click");
        await h.emit(h.node('[aria-label="确认移出"]'), "click");
      }
      const mutation = h.pending.length - 1;
      await h.respond(mutation, { ok: false, code: "not_found", error: "分组不存在" }, 404);
      assert.equal(h.pending[mutation + 1]!.path, "/api/admin/groups");
      await h.respond(mutation + 1, { items: [] });
      assert.ok(h.node(".group-missing-state").textContent?.includes("分组不存在或已删除"));
      assert.equal(h.document.body.textContent?.includes("结果未确认"), false);
      assert.equal(h.pending.length, mutation + 2, "404 does not trigger an unknown-write reconciliation read");
      assert.equal(h.document.querySelector(".image-editor-modal"), null);
    });
  }
});

test("[Web/分组] 图片管理员可创建、改名与排序，不能删除且空白行导航", async (t) => {
  const h = await groupPage(t, "image");
  assert.equal(h.document.querySelector('[aria-label="删除分组 a"]'), null);
  await h.edit('[aria-label="分组 a 显示名"]', "新的显示名");
  await h.emit(h.node('[aria-label="保存分组 a"]'), "click");
  assert.equal(h.pending[0]!.path, "/api/admin/groups/a");
  assert.deepEqual(JSON.parse(String(h.pending[0]!.body)), { display_name: "新的显示名" });
  await h.respond(0, { ok: true });
  assert.equal(h.pending[1]!.path, "/api/admin/groups");
  h.items[0]!.display_name = "新的显示名";
  await h.respond(1, { items: h.items });
  await h.settle();
  await h.edit('[aria-label="分组 a排序值"]', "15");
  await h.emit(h.node('[aria-label="分组 a排序值"]'), "keydown", { key: "Enter" });
  assert.equal(h.pending[2]!.path, "/api/admin/groups/a/sort-order");
  assert.deepEqual(JSON.parse(String(h.pending[2]!.body)), { sort_order: 15 });
  await h.respond(2, { ok: true });
  h.items[0]!.sort_order = 15;
  await h.respond(3, { items: h.items });
  await h.edit('[aria-label="分组标识"]', "new-group");
  await h.edit('[aria-label="分组显示名"]', "新分组");
  await h.emit(h.node(".admin-create-form"), "submit");
  assert.equal(h.pending[4]!.path, "/api/admin/groups");
  assert.deepEqual(JSON.parse(String(h.pending[4]!.body)), { slug: "new-group", display_name: "新分组" });
  await h.respond(4, { ok: true });
  await h.respond(5, { items: h.items });
  await h.settle();
  await h.edit('[aria-label="分组标识"]', "ordered-group");
  await h.edit('[aria-label="分组排序（可选）"]', "-8");
  await h.emit(h.node(".admin-create-form"), "submit");
  assert.deepEqual(JSON.parse(String(h.pending[6]!.body)), { slug: "ordered-group", display_name: "", sort_order: -8 });
  await h.respond(6, { ok: true });
  await h.respond(7, { items: h.items });
  assert.equal(h.node<HTMLInputElement>('[aria-label="分组排序（可选）"]').value, "");
  await h.settle();
  for (const key of [queryKeys.adminImages, queryKeys.publicImages, queryKeys.galleryFacets]) {
    assert.equal(h.client.getQueryState(key)?.isInvalidated, false);
  }
  await h.emit(h.node('[data-group-slug="a"]'), "click");
  assert.equal(h.pathname(), "/admin/groups/a");
});

test("[Web/分组] 超级管理员两次确认删除，同名重建不复用旧成员与图库标记", async (t) => {
  const h = await groupPage(t, "super", true);
  const item = adminImageListItem({ id: "00000000-0000-7000-8000-000000000001", title: "old-member" });
  const picker = () => Array.from(h.document.querySelectorAll<HTMLButtonElement>(".image-admin-view-switch button"))
    .find((button) => button.textContent === "图库")!;
  await h.respond(0, { items: [item], total: 1 });
  await h.emit(picker(), "click");
  await h.respond(1, { items: [{ ...item, in_group: true }], total: 1 });
  await h.emit(h.node(".group-title-link"), "click", { button: 0 });
  const otherGroupKey = [...queryKeys.groupImages, "other", "members"];
  h.client.setQueryData(otherGroupKey, { items: [item], total: 1 });
  const otherGroupData = h.client.getQueryData(otherGroupKey);
  await h.emit(h.node('[aria-label="删除分组 a"]'), "click");
  const form = h.node('.confirm-dialog form');
  await h.emit(form, "submit");
  assert.equal(h.pending.length, 2);
  await h.emit(form, "submit");
  assert.equal(h.pending[2]!.path, "/api/admin/groups/a/delete");
  await h.respond(2, { ok: true });
  assert.equal(h.pending[3]!.path, "/api/admin/groups");
  await h.respond(3, { items: [] });
  await h.settle();
  assert.equal(h.document.querySelector('[data-group-slug="a"]'), null);
  await h.edit('[aria-label="分组标识"]', "a");
  await h.emit(h.node(".admin-create-form"), "submit");
  await h.respond(4, { ok: true });
  await h.respond(5, { items: [{ ...h.items[0]!, image_count: 0 }] });
  await h.settle();
  await h.emit(h.node('[data-group-slug="a"]'), "click");
  assert.equal(h.pending.length, 7, "recreated group reads members even while its old cache would still be fresh");
  assert.equal(h.document.querySelector(".admin-image-card"), null);
  await h.respond(6, { items: [], total: 0 });
  await h.emit(picker(), "click");
  assert.equal(h.pending.length, 8, "picker membership marks must also be read for the new group");
  await h.respond(7, { items: [{ ...item, in_group: false }], total: 1 });
  assert.equal(h.node<HTMLButtonElement>('[aria-label="加入分组：old-member"]').disabled, false);
  assert.equal(h.client.getQueryData(otherGroupKey), otherGroupData);
  assert.equal(h.client.getQueryState(queryKeys.publicImages)?.isInvalidated, false);
  assert.equal(h.client.getQueryState(queryKeys.adminImages)?.isInvalidated, false);
});


test("[Web/分组] 成员查询、当前页连选及两步移出只刷新本组，标题返回列表", async (t) => {
  const h = await groupPage(t, "image", true);
  assert.equal(h.pending.length, 1);
  assert.equal(new URL(h.pending[0]!.path, "https://img.example").searchParams.get("group"), "a");
  const items = [1, 2, 3].map((value) => adminImageListItem({
    id: `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`,
    title: `member-${value}`
  }));
  await h.respond(0, { items, total: items.length });
  const cards = Array.from(h.document.querySelectorAll<HTMLElement>(".admin-image-card-detail"));
  await h.emit(cards[0]!, "click", { shiftKey: true });
  await h.emit(cards[2]!, "click", { shiftKey: true });
  assert.equal(h.document.querySelectorAll(".admin-image-card.is-selected").length, 3);
  await h.emit(h.node('[aria-label="移出分组"]'), "click");
  assert.equal(h.document.querySelector(".image-editor-modal"), null);
  assert.equal(h.pending.length, 1, "visible selected images do not need another preview");
  await h.emit(h.node('.image-list-batch-actions [aria-label="确认移出"]'), "click");
  assert.equal(h.pending[1]!.path, "/api/admin/groups/a/members/remove");
  assert.deepEqual(JSON.parse(String(h.pending[1]!.body)), { ids: items.map((item) => item.id) });
  await h.respond(1, { removed: 3 });
  assert.equal(h.pending.length, 3, "counts wait for the membership read");
  await h.respond(2, { items: [], total: 0 });
  await h.respond(3, { items: [{ ...h.items[0]!, image_count: 0 }] });
  await h.settle();
  assert.equal(h.document.querySelectorAll(".admin-image-card").length, 0);
  for (const key of [queryKeys.publicImages, queryKeys.adminImages, queryKeys.galleryFacets]) {
    assert.equal(h.client.getQueryState(key)?.isInvalidated, false);
  }
  const preferences: Record<string, string> = {};
  const changeViewControl = async (index: number, patch: Record<string, string>, queryExpected: boolean) => {
    const firstRequest = h.pending.length;
    const buttons = h.document.querySelectorAll(".image-list-view-controls > button");
    await h.emit(buttons[index]!, "click");
    const preferenceIndex = h.pending.findIndex((request, i) => i >= firstRequest && request.path === "/api/admin/preferences");
    assert.ok(preferenceIndex >= firstRequest);
    assert.deepEqual(JSON.parse(String(h.pending[preferenceIndex]!.body)), patch);
    Object.assign(preferences, patch);
    await h.respond(preferenceIndex, { preferences });
    const reads = h.pending.slice(firstRequest).filter((request) => request.path !== "/api/admin/preferences");
    assert.equal(reads.length, queryExpected ? 1 : 0);
    if (queryExpected) {
      const url = new URL(reads[0]!.path, "https://img.example");
      assert.equal(url.searchParams.get("sort_by"), preferences.image_sort_by);
      assert.equal(url.searchParams.get("order"), preferences.image_sort_order ?? "latest");
      assert.equal(url.searchParams.get("page"), "1");
      const queryIndex = h.pending.indexOf(reads[0]!);
      await h.respond(queryIndex, { items, total: items.length });
    }
  };
  await changeViewControl(0, { image_sort_by: "created_at" }, true);
  await h.emit(h.node(".admin-image-card-detail"), "click", { shiftKey: true });
  const selectedBeforeFit = h.document.querySelectorAll(".admin-image-card.is-selected").length;
  assert.equal(selectedBeforeFit, 1);
  await changeViewControl(2, { image_thumbnail_fit: "contain" }, false);
  assert.equal(h.node(".admin-image-grid").getAttribute("data-thumbnail-fit"), "contain");
  assert.equal(h.document.querySelectorAll(".admin-image-card.is-selected").length, selectedBeforeFit);
  await changeViewControl(1, { image_sort_order: "oldest" }, true);
  assert.equal(h.document.querySelectorAll(".admin-image-card.is-selected").length, 0);
  const picker = Array.from(h.document.querySelectorAll("button")).find((button) => button.textContent === "图库")!;
  const pickerRequest = h.pending.length;
  await h.emit(picker, "click");
  const pickerUrl = new URL(h.pending[pickerRequest]!.path, "https://img.example");
  assert.equal(pickerUrl.searchParams.get("mark_group"), "a");
  assert.equal(pickerUrl.searchParams.get("sort_by"), "created_at");
  assert.equal(pickerUrl.searchParams.get("order"), "oldest");
  await h.respond(pickerRequest, { items, total: items.length });
  await changeViewControl(1, { image_sort_order: "latest" }, true);
  await h.emit(h.node(".group-title-link"), "click", { button: 0 });
  assert.equal(h.pathname(), "/admin/groups");
});

test("[Web/分组] 按 ID 解析后只读预览，确认加入只写一次，成功与已在组内均不报错", async (t) => {
  const h = await groupPage(t, "image", true);
  await h.respond(0, { items: [], total: 0 });
  await h.emit(h.node('[aria-label="加入分组"]'), "click");
  await h.edit('[aria-label="图片 ID"]', Array.from({ length: 201 }, (_, index) => `invalid-${index}`).join(" "));
  await h.emit(h.node(".import-source-submit-button"), "click");
  assert.ok(h.document.body.textContent?.includes("最多 200 项"));
  assert.equal(h.pending.length, 1);
  const ids = [1, 2].map((value) => `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`);
  await h.edit('[aria-label="图片 ID"]', ids.join("\n"));
  await h.emit(h.node(".import-source-submit-button"), "click");
  await h.resolvePreview(ids);
  assert.equal(h.pending.length, 2);
  await h.confirmMembership();
  await h.confirmMembership();
  assert.equal(h.pending.length, 3, "repeated clicks must not duplicate a pending mutation");
  assert.deepEqual(JSON.parse(String(h.pending[2]!.body)), { ids });
  await h.respond(2, { items: ids.map((id, index) => ({ id, status: index ? "already_member" : "added" })) });
  await h.respond(3, { items: [], total: 0 });
  await h.respond(4, { items: h.items });
  await h.settle();
  assert.equal(h.document.querySelector(".image-editor-modal"), null);
  assert.equal(h.document.querySelector('[role="alert"]'), null);
  assert.ok(h.document.body.textContent?.includes("已加入 1 张；已在组内 1 张"));
  assert.equal(h.pending.filter((request) => request.path.endsWith("/members/add")).length, 1);
  assert.equal(h.client.getQueryState(queryKeys.adminImages)?.isInvalidated, false);
  assert.equal(h.client.getQueryState(queryKeys.publicImages)?.isInvalidated, false);
  for (const label of ["加入分组", "移出分组"]) {
    await h.emit(h.node(`[aria-label="${label}"]`), "click");
    await h.edit('[aria-label="图片 ID"]', ids[0]!);
    await h.emit(h.node(".import-source-submit-button"), "click");
    await h.resolvePreview([ids[0]!]);
    const requestCount: number = h.pending.length;
    await h.emit(h.node('.image-editor-row [title="从本次操作中移除"]'), "click");
    await h.settle();
    assert.equal(h.document.querySelector(".image-editor-modal"), null);
    assert.equal(h.pending.length, requestCount, "excluding the last preview item cancels without changing membership");
  }

  for (const adding of [true, false]) {
    await h.emit(h.node(`[aria-label="${adding ? "加入分组" : "移出分组"}"]`), "click");
    await h.edit('[aria-label="图片 ID"]', ids.join("\n"));
    await h.emit(h.node(".import-source-submit-button"), "click");
    const mixedIndex: number = h.pending.length - 1;
    assert.deepEqual(JSON.parse(String(h.pending[mixedIndex]!.body)), { ids, mark_group: "a" });
    await h.respond(mixedIndex, {
      items: ids.map((id, index) => ({ ...editableImage(id), in_group: index ? !adding : adding }))
    });
    await h.settle();
    assert.equal(h.document.querySelector(".image-editor-modal"), null);
    assert.ok(h.node(".import-issue-list").textContent?.includes(adding ? "已在组内" : "不在组内"));
    assert.ok(h.node(".import-issue-list").textContent?.includes(ids[0]!));
    await h.emit(h.node(".import-source-submit-button"), "click");
    await h.settle();
    assert.equal(h.document.querySelectorAll(".image-editor-row").length, 1);
    assert.ok(h.node(".image-editor-row").textContent?.includes(ids[1]!));
    assert.equal(h.pending.length, mixedIndex + 1, "continuing uses resolved snapshots without another request");
    await h.emit(h.node('.image-editor-row [title="从本次操作中移除"]'), "click");
    await h.settle();

    await h.emit(h.node(`[aria-label="${adding ? "加入分组" : "移出分组"}"]`), "click");
    await h.edit('[aria-label="图片 ID"]', ids[0]!);
    await h.emit(h.node(".import-source-submit-button"), "click");
    const emptyIndex: number = h.pending.length - 1;
    await h.respond(emptyIndex, { items: [{ ...editableImage(ids[0]!), in_group: adding }] });
    await h.settle();
    assert.equal(h.document.querySelector(".image-editor-modal"), null);
    assert.equal(h.node<HTMLButtonElement>(".import-source-submit-button").disabled, true);
    assert.equal(h.pending.filter((request) => /\/members\/(add|remove)$/.test(request.path)).length, 1,
      "parsing or cancelling must not write membership");
    await h.emit(h.node(".import-source-head .close"), "click");
  }

});

test("[Web/分组] 加入响应未确认时刷新权威列表且不重放写入", async (t) => {
  const h = await groupPage(t, "image", true);
  await h.respond(0, { items: [], total: 0 });
  await h.emit(h.node('[aria-label="加入分组"]'), "click");
  const id = adminImageListItem().id;
  await h.edit('[aria-label="图片 ID"]', id);
  await h.emit(h.node(".import-source-submit-button"), "click");
  await h.resolvePreview([id]);
  await h.confirmMembership();
  await h.respond(2, { ok: false, error: "Response unavailable" }, 502);
  assert.equal(new URL(h.pending[3]!.path, "https://img.example").searchParams.get("limit"), "1");
  await h.respond(3, { items: [], total: 0 });
  await h.respond(4, { items: [], total: 0 });
  await h.respond(5, { items: h.items });
  assert.ok(h.node('[role="alert"]').textContent?.includes("加入结果未确认"));
  assert.equal(h.node<HTMLButtonElement>(".image-editor-modal .workflow-submit-button").disabled, true);
  await h.confirmMembership();
  assert.equal(h.pending.filter((request) => request.path.endsWith("/members/add")).length, 1);
  await h.emit(h.node(".image-editor-modal .close"), "click");
  await h.settle();
});

test("[Web/分组] 成员写后刷新不复用写前尚未完成的首屏读取", async (t) => {
  const h = await groupPage(t, "image", true);
  await h.emit(h.node('[aria-label="加入分组"]'), "click");
  const item = adminImageListItem();
  await h.edit('[aria-label="图片 ID"]', item.id);
  await h.emit(h.node(".import-source-submit-button"), "click");
  await h.resolvePreview([item.id]);
  await h.confirmMembership();
  await h.respond(2, { items: [{ id: item.id, status: "added" }] });
  assert.equal(h.pending[0]!.signal?.aborted, true);
  await h.respond(3, { items: [item], total: 1 });
  await h.respond(4, { items: [{ ...h.items[0]!, image_count: 1 }] });
  await h.respond(0, { items: [], total: 0 });
  await h.settle();
  assert.equal(h.document.querySelectorAll(".admin-image-card").length, 1);
  assert.equal(h.document.querySelector(".image-editor-modal"), null);
});

test("[Web/分组] 按 ID 移出中离开详情页，未知写入仍先等待独立快照再刷新计数", async (t) => {
  const h = await groupPage(t, "image", true);
  const item = adminImageListItem();
  await h.respond(0, { items: [item], total: 1 });
  await h.emit(h.node('[aria-label="移出分组"]'), "click");
  await h.edit('[aria-label="图片 ID"]', item.id);
  await h.emit(h.node(".import-source-submit-button"), "click");
  await h.resolvePreview([item.id]);
  await h.confirmMembership();
  // Route departure can occur through browser navigation while a write is pending.
  await h.emit(h.node(".group-title-link"), "click", { button: 0 });
  assert.equal(h.pathname(), "/admin/groups");
  await h.respond(2, { ok: false, error: "Response unavailable" }, 502);
  const reconciliation = new URL(h.pending[3]!.path, "https://img.example");
  assert.equal(reconciliation.searchParams.get("group"), "a");
  assert.equal(reconciliation.searchParams.get("limit"), "1");
  await h.respond(3, { items: [], total: 0 });
  assert.equal(h.pending[4]!.path, "/api/admin/groups");
  await h.respond(4, { items: [{ ...h.items[0]!, image_count: 0 }] });
  assert.equal(h.client.getQueryData<{ items: ImageGroupDto[] }>(queryKeys.groups)!.items[0]!.image_count, 0);
  assert.equal(h.pending.filter((request) => request.path.endsWith("/members/remove")).length, 1);
});

test("[Web/分组] 图库允许连选成员，可见图片直接操作且按成员状态筛选并保留失败结果", async (t) => {
  const h = await groupPage(t, "image", true);
  await h.respond(0, { items: [], total: 0 });
  const picker = Array.from(h.document.querySelectorAll("button")).find((button) => button.textContent === "图库")!;
  await h.emit(picker, "click");
  const query = new URL(h.pending[1]!.path, "https://img.example");
  assert.equal(query.searchParams.get("mark_group"), "a");
  assert.equal(query.searchParams.has("group"), false);
  const items = [1, 2, 3].map((value) => adminImageListItem({
    id: `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`,
    title: `pick-${value}`, in_group: value === 2
  }));
  await h.respond(1, { items, total: 3 });
  assert.equal(h.node<HTMLInputElement>(`#admin-image-select-${items[1]!.id}`).disabled, false);
  assert.equal(h.node('[aria-label="加入分组：pick-2"]').hasAttribute("disabled"), true);
  assert.equal(h.node('[aria-label="移出分组：pick-1"]').hasAttribute("disabled"), true);
  const cards = Array.from(h.document.querySelectorAll(".admin-image-card-detail"));
  await h.emit(cards[0]!, "click", { shiftKey: true });
  await h.emit(cards[2]!, "click", { shiftKey: true });
  assert.equal(h.document.querySelectorAll(".admin-image-card.is-selected").length, 3);
  await h.emit(h.node('[aria-label="加入分组"]'), "click");
  assert.equal(h.document.querySelector(".image-editor-modal"), null);
  assert.deepEqual(JSON.parse(String(h.pending[2]!.body)), { ids: [items[0]!.id, items[2]!.id] });
  await h.respond(2, { items: [{ id: items[0]!.id, status: "added" }, { id: items[2]!.id, status: "group_limit" }] });
  items[0]!.in_group = true;
  await h.respond(3, { items, total: 3 });
  await h.respond(4, { items: h.items });
  assert.ok(h.document.body.textContent?.includes(`${items[2]!.id}：已达每张图的分组上限`));
  await h.emit(h.node('[aria-label="加入分组：pick-3"]'), "click");
  assert.deepEqual(JSON.parse(String(h.pending[5]!.body)), { ids: [items[2]!.id] });
  await h.respond(5, { items: [{ id: items[2]!.id, status: "added" }] });
  items[2]!.in_group = true;
  await h.respond(6, { items, total: 3 });
  await h.respond(7, { items: h.items });
  await h.emit(h.node('[aria-label="移出分组：pick-2"]'), "click");
  assert.equal(h.document.querySelector(".image-editor-modal"), null);
  assert.equal(h.pending.length, 8, "card removal first arms confirmation without loading a preview");
  await h.emit(h.node('.admin-image-card [aria-label="确认移出"]'), "click");
  assert.deepEqual(JSON.parse(String(h.pending[8]!.body)), { ids: [items[1]!.id] });
  await h.respond(8, { removed: 1 });
  items[1]!.in_group = false;
  await h.respond(9, { items, total: 3 });
  await h.respond(10, { items: h.items });
  assert.equal(h.client.getQueryState(queryKeys.adminImages)?.isInvalidated, false);
  assert.equal(h.client.getQueryState(queryKeys.publicImages)?.isInvalidated, false);
});

test("[Web/分组] 随机链接条件独立于筛选，自动设备不附回退且按当前页标记条件外", async (t) => {
  t.after(installProperties(navigator, { userAgent: "Mozilla/5.0 Windows" }));
  const h = await groupPage(t, "image", true);
  const items = [
    adminImageListItem({ id: "00000000-0000-7000-8000-000000000001", device: "pc", brightness: "dark" }),
    adminImageListItem({ id: "00000000-0000-7000-8000-000000000002", device: "mb", brightness: "light" })
  ];
  await h.respond(0, { items, total: 999 });
  const link = () => new URL(h.node<HTMLInputElement>('[aria-label="分组随机链接"]').value);
  const outside = () => Array.from(h.document.querySelectorAll(".admin-image-card-meta")).filter((node) => node.textContent?.includes("条件外")).length;
  const choose = async (label: string, value: string) => {
    const trigger = h.node(`[aria-label="${label}"]`);
    await h.emit(trigger, "click");
    const menu = h.document.getElementById(trigger.getAttribute("aria-controls")!);
    assert.ok(menu);
    const option = Array.from(menu.querySelectorAll('[role="option"]')).find((node) => node.textContent === value);
    assert.ok(option, value);
    await h.emit(option, "click");
    if (menu.classList.contains("is-closing")) await h.emit(menu, "animationend");
  };
  assert.equal(link().search, "?group=a&device=all");
  assert.equal(link().searchParams.get("device"), "all");
  assert.equal(outside(), 0);
  await choose("链接设备", "移动端");
  assert.equal(link().searchParams.get("device"), "mb");
  assert.equal(outside(), 1);
  await choose("链接亮度", "暗色图片");
  assert.equal(outside(), 2);
  await choose("链接设备", "桌面端");
  assert.equal(link().searchParams.get("device"), "pc");
  assert.equal(outside(), 1);
  await choose("链接返回方式", "JSON");
  assert.equal(link().searchParams.get("mode"), "json");
  assert.equal(link().searchParams.has("limit"), false);
  assert.equal(h.pending.length, 1, "link changes never filter the page or read all members");
  const generated = link().href;
  await choose("设备", "移动端");
  assert.equal(link().href, generated);
  assert.equal(new URL(h.pending[1]!.path, "https://img.example").searchParams.get("device"), "mb");
  await h.respond(1, { items: [items[1]], total: 1 });
  assert.equal(outside(), 1);
  await choose("链接返回方式", "302 跳转");
  assert.equal(link().searchParams.get("mode"), "redirect");
  assert.equal(link().searchParams.has("limit"), false);
  await choose("链接返回方式", "代理模式");
  assert.equal(link().searchParams.get("mode"), "proxy");
  await choose("链接返回方式", "默认返回");
  await choose("链接设备", "自动设备");
  await choose("链接亮度", "全部亮度");
  assert.equal(link().search, "?group=a");
  let copied = "";
  t.after(installProperties(navigator, { clipboard: { writeText: async (value: string) => { copied = value; } } }));
  await h.emit(h.node('[aria-label="复制分组随机链接"]'), "click");
  assert.equal(copied, link().href);
});
