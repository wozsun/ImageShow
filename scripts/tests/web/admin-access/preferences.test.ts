import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { type AdminPreferences } from "../../../../packages/shared/src/browser.ts";

import {
  setCsrfToken,
  clearCsrfToken
} from "../../../../packages/web/src/lib/api/client.ts";

import { queryKeys } from "../../../../packages/web/src/lib/api/query-keys.ts";

import { createConfigStreamHarness } from "../../support/web-test-context.ts";

test("[Web/后台访问] 偏好队列随账号卸载终止，迟到响应不写入新账号且原账号可恢复", async (t) => {
  const h = await createConfigStreamHarness(t, { honorAbort: false });
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { AdminPreferencesProvider, useAdminPreference } =
    await import("../../../../packages/web/src/hooks/useAdminPreferences.tsx");
  const stored = new Map<string, string>();
  Object.assign(h.window, {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value)
    }
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => {
    client.clear();
    clearCsrfToken();
  });
  let setColor!: (value: "light" | "dark" | "system") => void;
  let setSort!: (value: "oldest" | "latest") => void;
  function Probe() {
    [, setColor] = useAdminPreference("color_scheme");
    [, setSort] = useAdminPreference("image_sort_order");
    return null;
  }
  const mount = async (username: string, preferences: AdminPreferences) => {
    setCsrfToken(`csrf-${username}`);
    client.setQueryData(queryKeys.me, {
      authenticated: true,
      username,
      preferences,
      preferences_etag: username
    });
    await h.render(
      h.React.createElement(
        h.React.StrictMode,
        null,
        h.React.createElement(
          QueryClientProvider,
          { client },
          h.React.createElement(
            AdminPreferencesProvider,
            {
              key: username,
              username,
              serverPreferences: preferences,
              serverPreferencesEtag: username,
              serverPreferencesUpdatedAt: Date.now()
            },
            h.React.createElement(Probe)
          )
        )
      )
    );
  };
  await mount("A", { color_scheme: "dark", image_sort_order: "latest" });
  await h.React.act(async () => {
    setColor("light");
    setSort("oldest");
  });
  assert.equal(h.pending.length, 1, "同账号请求串行发送");
  assert.equal(new Headers(h.pending[0]!.headers).get("x-csrf-token"), "csrf-A");
  h.window.dispatchEvent(new Event("online"));
  await mount("B", { color_scheme: "dark", image_sort_order: "latest" });
  assert.equal(h.pending[0]!.signal?.aborted, true);
  const cacheA = stored.get("imageshow.admin.preferences.A");
  const cacheB = stored.get("imageshow.admin.preferences.B");
  await h.respond(0, { preferences: { color_scheme: "light", image_sort_order: "latest" } });
  assert.equal(h.pending.length, 1, "旧队列及 online 回调都不能借用 B 的凭据发送");
  assert.equal(stored.get("imageshow.admin.preferences.A"), cacheA, "迟到响应不清除原账号 pending");
  assert.equal(stored.get("imageshow.admin.preferences.B"), cacheB);
  assert.deepEqual(client.getQueryData(queryKeys.me), {
    authenticated: true,
    username: "B",
    preferences: { color_scheme: "dark", image_sort_order: "latest" },
    preferences_etag: "B"
  });
  // Strict Mode reactivation must retain pending work without reviving the old queue.
  await mount("A", { color_scheme: "light", image_sort_order: "latest" });
  assert.equal(h.pending.length, 2);
  assert.deepEqual(JSON.parse(String(h.pending[1]!.body)), { image_sort_order: "oldest" });
  assert.equal(new Headers(h.pending[1]!.headers).get("x-csrf-token"), "csrf-A");
  await h.respond(1, { preferences: { color_scheme: "light", image_sort_order: "oldest" } });
  assert.deepEqual(JSON.parse(stored.get("imageshow.admin.preferences.A")!).pending, {});
  await h.React.act(async () => {
    setColor("dark");
    setSort("latest");
  });
  assert.equal(h.pending.length, 3);
  await h.respond(2, { preferences: { color_scheme: "dark", image_sort_order: "oldest" } });
  assert.equal(h.pending.length, 4);
  await h.respond(3, { preferences: { color_scheme: "dark", image_sort_order: "latest" } });
  assert.deepEqual(JSON.parse(stored.get("imageshow.admin.preferences.A")!).pending, {});
});

test("[Web/后台访问] 跨标签页更新后旧偏好回执只触发一次重验证，旧队列不重放", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { AdminPreferencesProvider, useAdminPreference } =
    await import("../../../../packages/web/src/hooks/useAdminPreferences.tsx");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => {
    client.clear();
    clearCsrfToken();
  });
  const key = "imageshow.admin.preferences.shared-owner";
  const stored = new Map<string, string>();
  Object.assign(h.window, {
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value)
    }
  });
  const initial = { color_scheme: "dark", image_sort_order: "latest" } as const;
  let setColor!: (value: "light" | "dark" | "system") => void;
  let setSort!: (value: "oldest" | "latest") => void;
  let color = "";
  let order = "";
  function Probe() {
    [color, setColor] = useAdminPreference("color_scheme");
    [order, setSort] = useAdminPreference("image_sort_order");
    return null;
  }
  setCsrfToken("shared-owner-csrf");
  client.setQueryData(queryKeys.me, {
    authenticated: true,
    username: "shared-owner",
    preferences: initial,
    preferences_etag: "initial"
  });
  await h.render(
    h.React.createElement(
      QueryClientProvider,
      { client },
      h.React.createElement(
        AdminPreferencesProvider,
        {
          username: "shared-owner",
          serverPreferences: initial,
          serverPreferencesEtag: "initial",
          serverPreferencesUpdatedAt: Date.now()
        },
        h.React.createElement(Probe)
      )
    )
  );
  await h.React.act(async () => {
    setColor("light");
    setSort("oldest");
  });
  assert.equal(h.pending.length, 1);
  const otherDocument = { color_scheme: "system", image_sort_order: "latest" } as const;
  await h.React.act(async () => {
    stored.set(key, JSON.stringify({ values: otherDocument, pending: {} }));
    h.window.dispatchEvent(
      Object.assign(new Event("storage"), {
        key,
        storageArea: h.window.localStorage
      })
    );
  });
  assert.equal(color, "system");
  await h.respond(0, { preferences: { color_scheme: "light", image_sort_order: "latest" } });
  assert.equal(color, "system", "迟到 PATCH 不得在重验证期间回退页面");
  assert.equal(order, "latest");
  assert.equal(h.pending.length, 2);
  assert.equal(h.pending[1].body, undefined, "使用现有偏好 GET owner，不重放旧写入");
  assert.deepEqual(JSON.parse(stored.get(key)!), { values: otherDocument, pending: {} });
  await h.respond(1, { preferences: otherDocument });
  assert.equal(h.pending.length, 2, "另一页已经覆盖的排队排序不能再次写入");
  assert.deepEqual(client.getQueryData([...queryKeys.adminPreferences, "shared-owner"]), {
    preferences: otherDocument,
    etag: ""
  });
  assert.deepEqual(
    (client.getQueryData(queryKeys.me) as { preferences: AdminPreferences }).preferences,
    otherDocument
  );
  await h.React.act(async () => setSort("oldest"));
  await h.respond(2, { preferences: { ...otherDocument, image_sort_order: "oldest" } });
  assert.equal(h.pending.length, 3, "普通同页确认继续走无额外 GET 的路径");
  assert.equal(order, "oldest");
  // Choosing the same value again after another document replaced it is a new
  // intent, even while an older request for that value is awaiting its receipt.
  await h.React.act(async () => setColor("light"));
  await h.React.act(async () => {
    stored.set(key, JSON.stringify({ values: otherDocument, pending: {} }));
    h.window.dispatchEvent(
      Object.assign(new Event("storage"), {
        key,
        storageArea: h.window.localStorage
      })
    );
    setColor("light");
  });
  await h.respond(3, { preferences: { color_scheme: "light", image_sort_order: "oldest" } });
  assert.equal(JSON.parse(stored.get(key)!).pending.color_scheme, "light");
  await h.respond(4, { preferences: otherDocument });
  assert.equal(color, "light", "用户重新选择的同值仍保留自己的待写入身份");
  assert.deepEqual(JSON.parse(String(h.pending[5].body)), { color_scheme: "light" });
  await h.respond(5, { preferences: { ...otherDocument, color_scheme: "light" } });
  assert.equal(color, "light");
  assert.deepEqual(JSON.parse(stored.get(key)!).pending, {});
});

test("[Web/后台访问] 偏好写入在取消读取期间卸载也不发送 PATCH", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { AdminPreferencesProvider, useAdminPreference } =
    await import("../../../../packages/web/src/hooks/useAdminPreferences.tsx");
  const client = new QueryClient();
  t.after(() => client.clear());
  const cancellation = Promise.withResolvers<void>();
  t.mock.method(client, "cancelQueries", () => cancellation.promise);
  let setColor!: (value: "light" | "dark" | "system") => void;
  function Probe() {
    [, setColor] = useAdminPreference("color_scheme");
    return null;
  }
  await h.render(
    h.React.createElement(
      QueryClientProvider,
      { client },
      h.React.createElement(
        AdminPreferencesProvider,
        {
          username: "fenced",
          serverPreferences: {},
          serverPreferencesEtag: "fenced",
          serverPreferencesUpdatedAt: Date.now()
        },
        h.React.createElement(Probe)
      )
    )
  );
  await h.React.act(async () => setColor("light"));
  assert.equal(h.pending.length, 0);
  await h.render(null);
  await h.React.act(async () => cancellation.resolve());
  assert.equal(h.pending.length, 0);
});

test("[Web/后台访问] 后台偏好五分钟内聚焦零请求且首次过期重验证命中 304", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const localStorageValues = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageValues.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageValues.delete(key);
    }
  };
  Object.assign(window, { localStorage });
  let preferenceReads = 0;
  let preferenceWrites = 0;
  const preferenceEtag = 'W/"preference-focus-v1"';
  const updatedPreferenceEtag = 'W/"preference-focus-v2"';
  const fetchStub = async (
    input: RequestInfo | URL,
    init: RequestInit = {}
  ) => {
    const url = new URL(String(input), "https://imageshow.test");
    assert.equal(url.pathname, "/api/admin/preferences");
    if (init.method === "PATCH") {
      preferenceWrites += 1;
      return new Response(
        JSON.stringify({
          ok: true,
          preferences: { color_scheme: "light" }
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            etag: updatedPreferenceEtag
          }
        }
      );
    }
    preferenceReads += 1;
    assert.equal(
      new Headers(init.headers).get("if-none-match"),
      preferenceEtag,
      "首次偏好 GET 必须复用 /auth/me 提供的验证器"
    );
    return new Response(null, {
      status: 304,
      headers: { etag: preferenceEtag }
    });
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    localStorage,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    )
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { focusManager, QueryClient, QueryClientProvider } =
      await import("@tanstack/react-query");
    const { AdminPreferencesProvider, useAdminPreference } =
      await import("../../../../packages/web/src/hooks/useAdminPreferences.tsx");
    const username = "preference-focus-test";
    const initialUpdatedAt = Date.now();
    const queryKey = [...queryKeys.adminPreferences, username] as const;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    client.setQueryData(queryKeys.me, {
      authenticated: true,
      username,
      role: "super",
      permissions: [],
      csrf_token: "preference-focus-token",
      application_version: "current-test",
      preferences: { color_scheme: "dark" },
      preferences_etag: preferenceEtag,
      version_settings: { enabled: true, link_enabled: true }
    });
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    let setColorScheme: ((value: "light" | "dark" | "system") => void) | undefined;

    function PreferenceProbe() {
      const [, setPreference] = useAdminPreference("color_scheme");
      setColorScheme = setPreference;
      return React.createElement("span", null, "ready");
    }

    await React.act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(
            AdminPreferencesProvider,
            {
              username,
              serverPreferences: { color_scheme: "dark" },
              serverPreferencesEtag: preferenceEtag,
              serverPreferencesUpdatedAt: initialUpdatedAt
            },
            React.createElement(PreferenceProbe)
          )
        )
      );
      await Promise.resolve();
    });
    assert.equal(preferenceReads, 0, "认证首帧快照新鲜时不得追加偏好 GET");

    await React.act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });
    assert.equal(preferenceReads, 0, "五分钟内重新聚焦不得读取偏好");

    const current = client.getQueryData(queryKey);
    assert.ok(current);
    client.setQueryData(queryKey, current, {
      updatedAt: initialUpdatedAt - 5 * 60 * 1000 - 1
    });
    await React.act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      for (let attempt = 0; attempt < 20 && preferenceReads === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(preferenceReads, 1, "过期快照应在重新聚焦时重验证一次");
    assert.deepEqual(
      client.getQueryData(queryKey),
      {
        preferences: { color_scheme: "dark" },
        etag: preferenceEtag
      },
      "304 应继续使用认证首帧的偏好快照"
    );

    let authReadAborted = false;
    let authReadStarted = false;
    const staleAuthRead = client
      .fetchQuery({
        queryKey: queryKeys.me,
        staleTime: 0,
        queryFn: ({ signal }) =>
          new Promise<never>((_resolve, reject) => {
            authReadStarted = true;
            signal.addEventListener(
              "abort",
              () => {
                authReadAborted = true;
                reject(signal.reason);
              },
              { once: true }
            );
          })
      })
      .catch(() => undefined);
    assert.equal(authReadStarted, true);
    await React.act(async () => {
      setColorScheme?.("light");
      for (let attempt = 0; attempt < 30 && preferenceWrites === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    await staleAuthRead;
    assert.equal(preferenceWrites, 1);
    assert.equal(
      authReadAborted,
      true,
      "偏好 PATCH 必须取消可能携带旧偏好和 ETag 的在途 /auth/me"
    );
    assert.deepEqual(client.getQueryData(queryKeys.me), {
      authenticated: true,
      username,
      role: "super",
      permissions: [],
      csrf_token: "preference-focus-token",
      application_version: "current-test",
      preferences: { color_scheme: "light" },
      preferences_etag: updatedPreferenceEtag,
      version_settings: { enabled: true, link_enabled: true }
    });
    await React.act(async () => root.unmount());
    client.clear();
    focusManager.setFocused(undefined);
  } finally {
    const { focusManager } = await import("@tanstack/react-query");
    focusManager.setFocused(undefined);
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
