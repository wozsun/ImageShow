import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { registerHooks } from "node:module";
import { createConfigStreamHarness } from "../support/web-test-context.ts";
import { dispatchDomEvent, inputText } from "../support/dom-events.ts";
import { queryKeys } from "../../../packages/web/src/lib/api/query-keys.ts";
import { appConfig } from "../../../packages/shared/src/app-config.ts";
import {
  adminPermissions,
  sortOrderMin,
  sortOrderMax
} from "../../../packages/shared/src/browser.ts";

type Kind = "tags" | "themes" | "authors" | "storage";

async function sortingPage(t: TestContext, kind: Kind) {
  const h = await createConfigStreamHarness(t);
  h.window.scrollTo = () => {};
  const css = registerHooks({
    load(url, context, next) {
      return url.endsWith(".css")
        ? { format: "module", source: "", shortCircuit: true }
        : next(url, context);
    }
  });
  const { VocabularyAdmin } =
    await import("../../../packages/web/src/pages/admin/VocabularyAdmin.tsx");
  const { StorageSettings } =
    await import("../../../packages/web/src/pages/admin/storage/StorageSettings.tsx");
  css.deregister();
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { MemoryRouter } = await import("react-router");
  const { AuthSessionProvider } =
    await import("../../../packages/web/src/hooks/useAuthSession.tsx");
  const { ActionFeedbackProvider } =
    await import("../../../packages/web/src/components/feedback/ActionFeedbackRegion.tsx");
  const { storageBackendS3FormSettings } =
    await import("../../../packages/web/src/pages/admin/storage/storage-backend-form.ts");
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  t.after(() => client.clear());
  const key = kind === "storage" ? queryKeys.storageBackends : queryKeys[kind];
  const path = kind === "storage" ? "/api/admin/storage/backends" : `/api/admin/${kind}`;
  const original = (kind === "storage" ? ["local", "a", "b", "c"] : ["a", "b", "c"]).map(
    (slug, index) => ({
      slug,
      sort_order: 100 - index,
      display_name: slug,
      image_count: 0,
      link: "",
      derived_identity: null,
      type: slug === "local" ? "local" : "s3",
      enabled: true,
      is_default: slug === "local",
      content_md5: null,
      s3: { ...storageBackendS3FormSettings(), secret_access_key_configured: true },
      ingestion_session_count: 0,
      cleanup_job_count: 0,
      failed_cleanup_job_count: 0,
      exhausted_cleanup_job_count: 0,
      deletion:
        slug === "local"
          ? { action: "blocked", blockers: ["local"] }
          : { action: "delete", blockers: [] }
    })
  );
  const response = (values: Record<string, number> = {}) => {
    const rows = original.map((item) => ({
      ...item,
      sort_order: values[item.slug] ?? item.sort_order
    }));
    rows.sort(
      (a, b) =>
        Number(b.slug === "local") - Number(a.slug === "local") ||
        b.sort_order - a.sort_order ||
        a.slug.localeCompare(b.slug)
    );
    return kind === "storage" ? { backends: rows } : { items: rows };
  };
  client.setQueryData(key, response());
  client.setQueryData(queryKeys.settings, { settings: appConfig.runtimeDefaults });
  client.setQueryData(queryKeys.me, {
    authenticated: true,
    username: "sort-tester",
    role: "super",
    permissions: Object.values(adminPermissions),
    preferences: {},
    csrf: "sort-test"
  });
  const projections =
    kind === "storage"
      ? [queryKeys.storageOptions]
      : [queryKeys.galleryFacets, queryKeys.galleryStats, queryKeys.ingestionVocabulary];
  for (const projection of projections) client.setQueryData(projection, {});
  client.setQueryData(queryKeys.adminImages, {});
  await h.render(
    h.React.createElement(
      QueryClientProvider,
      { client },
      h.React.createElement(
        MemoryRouter,
        { initialEntries: [`/admin/${kind}`] },
        h.React.createElement(
          AuthSessionProvider,
          null,
          h.React.createElement(
            ActionFeedbackProvider,
            null,
            kind === "storage"
              ? h.React.createElement(StorageSettings)
              : h.React.createElement(VocabularyAdmin, { kind })
          )
        )
      )
    )
  );
  const input = (slug: string) => {
    const node = h.document.querySelector<HTMLInputElement>(
      `.sort-order-control input[aria-label$=" ${slug}排序值"]`
    );
    assert.ok(node, `排序输入 ${slug}`);
    return node;
  };
  const edit = async (slug: string, value: string) =>
    h.React.act(async () => {
      inputText(h.window, input(slug), value);
    });
  const emit = async (
    node: EventTarget,
    event: string,
    properties: Record<string, unknown> = {}
  ) => {
    await h.React.act(async () => {
      dispatchDomEvent(h.window, node, event, properties);
    });
    await h.flush();
  };
  const enter = (slug: string) => emit(input(slug), "keydown", { key: "Enter" });
  return { ...h, client, key, path, response, projections, input, edit, emit, enter };
}

for (const kind of ["tags", "themes", "authors", "storage"] as const) {
  test(`[Web/后台排序] ${kind} 草稿、控件内焦点与连续单项保存保持其他卡片可编辑`, async (t) => {
    const h = await sortingPage(t, kind);
    const first = h.input("a");
    const control = first.parentElement!;
    const minus = control.querySelector<HTMLButtonElement>("button")!;
    const plus = control.querySelector<HTMLButtonElement>("button:last-child")!;
    assert.equal(minus.title, "排序值减 1（更靠后）");
    assert.equal(plus.title, "排序值加 1（更靠前）");
    await h.edit("a", "1000");
    await h.emit(plus, "click");
    await h.emit(plus, "click");
    await h.emit(minus, "click");
    assert.equal(first.value, "1001");
    await h.emit(first, "focusout", { relatedTarget: plus });
    assert.equal(h.pending.length, 0, "编辑及内部焦点切换只更新草稿");
    await h.enter("a");
    assert.equal(h.pending[0].path, `${h.path}/a/sort-order`);
    assert.deepEqual(JSON.parse(String(h.pending[0].body)), { sort_order: 1001 });
    assert.equal(h.input("a").disabled, true);
    assert.equal(h.input("b").disabled, false);
    assert.equal(h.input("c").disabled, false);
    await h.edit("b", "-20");
    await h.emit(h.input("b"), "focusout", { relatedTarget: h.document.body });
    assert.equal(h.input("b").disabled, true);
    assert.equal(h.input("c").disabled, false);
    assert.equal(h.pending.length, 1, "下一项等待前一项写入及回读");
    await h.respond(0, { ok: true });
    assert.equal(h.pending[1].path, h.path);
    await h.respond(1, h.response({ a: 1001 }));
    assert.equal(h.input("a"), first, "回读保留原卡片节点");
    assert.equal(h.input("b").value, "-20", "其他条目回读保留未提交草稿");
    assert.equal(h.pending[2].path, `${h.path}/b/sort-order`);
    assert.deepEqual(JSON.parse(String(h.pending[2].body)), { sort_order: -20 });
    await h.respond(2, { ok: true });
    await h.respond(3, h.response({ a: 1001, b: -20 }));
    assert.deepEqual(
      [...h.document.querySelectorAll<HTMLInputElement>(".sort-order-control input")].map(
        (node) => node.value
      ),
      ["1001", kind === "storage" ? "97" : "98", "-20"]
    );
    assert.equal(h.input("b").disabled, false);
    assert.equal(h.pending.length, 4, "每项一次写入及所属列表回读");
    for (const projection of h.projections)
      assert.equal(h.client.getQueryState(projection)?.isInvalidated, true);
    assert.equal(
      h.client.getQueryState(queryKeys.adminImages)?.isInvalidated,
      false,
      "排序只失效相关投影"
    );
  });
}

test("[Web/后台排序] 单项失败保留草稿并继续队列，刷新失败独立提示且可重试", async (t) => {
  const h = await sortingPage(t, "tags");
  await h.edit("a", "-5");
  await h.enter("a");
  await h.edit("b", "10");
  await h.enter("b");
  await h.respond(0, { code: "save_failed", error: "save failed" }, 500);
  assert.equal(h.input("a").value, "-5");
  assert.match(h.document.querySelector('[role="alert"]')!.textContent!, /排序保存失败/);
  assert.equal(h.pending[1].path, `${h.path}/b/sort-order`);
  await h.respond(1, { ok: true });
  await h.respond(2, h.response({ b: 10 }));
  await h.enter("a");
  await h.respond(3, { ok: true });
  await h.respond(4, { code: "read_failed", error: "read failed" }, 500);
  assert.equal(h.input("a").value, "-5");
  assert.match(
    h.document.querySelector(
      '.action-feedback-fallback-region .action-feedback-error[role="alert"]'
    )!.textContent!,
    /已保存.*列表刷新失败/
  );
  await h.enter("a");
  await h.respond(5, { ok: true });
  await h.respond(6, h.response({ a: -5, b: 10 }));
  assert.equal(h.input("a").disabled, false);
  assert.equal(h.input("a").getAttribute("aria-invalid"), "false");
  assert.equal(h.input("a").value, "-5");
});

test("[Web/后台排序] 作者资料保存与排序回读重叠时采用同时包含两次修改的列表", async (t) => {
  const h = await sortingPage(t, "authors");
  await h.edit("a", "1001");
  await h.enter("a");
  await h.respond(0, { ok: true });
  assert.equal(h.pending[1].path, h.path);
  const otherCard = h.input("b").closest(".entity-card")!;
  const name = otherCard.querySelector<HTMLInputElement>(".entity-display-input")!;
  assert.equal(name.disabled, false);
  await h.React.act(async () => {
    inputText(h.window, name, "updated");
  });
  await h.emit(otherCard.querySelector(".entity-card-foot .button")!, "click");
  assert.equal(h.pending[2].path, `${h.path}/b`);
  const fresh = h.response({ a: 1001 }).items!;
  const item = { ...fresh.find((row) => row.slug === "b")!, display_name: "updated" };
  await h.respond(2, { ok: true, item });
  assert.equal(h.pending[3].path, h.path);
  assert.equal(h.pending[1].signal?.aborted, true, "后续写入使用提交后的新列表读取");
  await h.respond(3, { items: fresh.map((row) => (row.slug === "b" ? item : row)) });
  assert.equal(h.input("a").value, "1001");
  assert.equal(h.input("a").disabled, false);
  assert.equal(h.input("a").getAttribute("aria-invalid"), "false");
  assert.equal(name.value, "updated");
  assert.equal(h.pending.length, 4);
  assert.equal(
    h.client.getQueryState(queryKeys.adminImages)?.isInvalidated,
    false,
    "作者资料与排序更新只刷新词表投影"
  );
});

test("[Web/后台排序] 作者同值顺序保持服务器排列，无法确定的新位置由列表回读", async (t) => {
  const h = await sortingPage(t, "authors");
  const rows = h.response().items!;
  const aa = { ...rows[0], slug: "aa", sort_order: sortOrderMax };
  const ab = { ...rows[1], slug: "a-b", sort_order: sortOrderMax };
  await h.React.act(async () => {
    h.client.setQueryData(h.key, { items: [aa, ab] });
  });
  await h.flush();
  const order = () =>
    [...h.document.querySelectorAll<HTMLInputElement>(".entity-card .entity-slug")].map(
      (input) => input.value
    );
  const saveName = async (slug: string, value: string) => {
    const card = h.input(slug).closest(".entity-card")!;
    await h.React.act(async () => {
      inputText(h.window, card.querySelector<HTMLInputElement>(".entity-display-input")!, value);
    });
    await h.emit(card.querySelector(".entity-card-foot .button")!, "click");
  };
  const renamed = { ...ab, display_name: "renamed" };
  await saveName("a-b", renamed.display_name);
  await h.respond(0, { ok: true, item: renamed });
  assert.deepEqual(order(), ["aa", "a-b"], "修改资料保持服务器提供的同值顺序");
  assert.equal(h.pending.length, 1, "排序值未变时原位采用资料，无需列表回读");

  const moved = { ...aa, display_name: "also updated", sort_order: -1 };
  await saveName("aa", moved.display_name);
  await h.respond(1, { ok: true, item: moved });
  assert.equal(h.pending[2].path, h.path);
  await h.respond(2, { items: [renamed, moved] });
  assert.deepEqual(order(), ["a-b", "aa"]);
  assert.equal(h.input("aa").value, "-1", "资料 DTO 中改变的排序值和列表位置同时生效");

  const created = { ...aa, slug: "a-c" };
  await h.React.act(async () => {
    inputText(
      h.window,
      h.document.querySelector<HTMLInputElement>(".entity-create-slug")!,
      created.slug
    );
  });
  await h.emit(h.document.querySelector(".admin-create-form")!, "submit");
  assert.equal(h.pending[3].path, h.path);
  assert.equal(JSON.parse(String(h.pending[3].body)).slug, created.slug);
  await h.respond(3, { ok: true, item: created });
  assert.equal(h.pending[4].path, h.path);
  await h.respond(4, { items: [renamed, created, moved] });
  assert.deepEqual(order(), ["a-b", "a-c", "aa"], "同值新建采用数据库确定的完整顺序");
  assert.equal(h.pending.length, 5);
});

test("[Web/后台排序] 整数输入边界、权威更新与卸载遵循草稿和单次提交契约", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { SortOrderInput } =
    await import("../../../packages/web/src/components/actions/SortOrderInput.tsx");
  const { ActionFeedbackProvider } =
    await import("../../../packages/web/src/components/feedback/ActionFeedbackRegion.tsx");
  const saved: number[] = [];
  let pending = Promise.withResolvers<number>();
  const onSave = (value: number) => {
    saved.push(value);
    return pending.promise;
  };
  const render = (value: number) =>
    h.render(
      h.React.createElement(
        ActionFeedbackProvider,
        null,
        h.React.createElement(SortOrderInput, {
          value,
          itemLabel: "标签 x",
          disabled: false,
          onSave
        })
      )
    );
  const input = () => h.document.querySelector<HTMLInputElement>("input")!;
  const edit = async (value: string) =>
    h.React.act(async () => {
      inputText(h.window, input(), value);
    });
  const key = async (key: string, isComposing = false) =>
    h.React.act(async () => {
      dispatchDomEvent(h.window, input(), "keydown", { key, isComposing });
    });
  await render(1);
  await render(2);
  assert.equal(input().value, "2");
  await edit("-1000");
  await render(3);
  assert.equal(input().value, "-1000");
  await key("Enter", true);
  assert.equal(saved.length, 0, "输入法确认不触发保存");
  for (const value of [
    "",
    "1.5",
    "1e3",
    "NaN",
    String(sortOrderMax + 1),
    String(sortOrderMin - 1)
  ]) {
    await edit(value);
    await key("Enter");
    assert.equal(input().getAttribute("aria-invalid"), "true");
    assert.equal(saved.length, 0, "非法整数留在输入框供修正");
    const message = h.document.querySelector(
      '.action-feedback-fallback-region .action-feedback-error[role="alert"]'
    );
    assert.ok(message);
    assert.match(message.textContent!, /请输入 -5,000,000 至 5,000,000 之间的整数/);
  }
  await edit(String(sortOrderMax));
  await key("ArrowUp");
  assert.equal(input().value, String(sortOrderMax));
  await edit(String(sortOrderMin));
  await key("ArrowDown");
  assert.equal(input().value, String(sortOrderMin));
  await edit(" +004 ");
  await key("Enter");
  await key("Enter");
  assert.deepEqual(saved, [4]);
  await h.React.act(async () => pending.resolve(4));
  assert.equal(input().value, "4");
  await render(5);
  assert.equal(input().value, "5", "成功保存后的 clean 输入跟随权威值");
  pending = Promise.withResolvers<number>();
  await edit("-6");
  await key("Enter");
  await h.render(null);
  await h.React.act(async () => pending.resolve(-6));
  assert.deepEqual(saved, [4, -6]);
});
