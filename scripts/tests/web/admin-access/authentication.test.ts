import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHTML
} from "linkedom";

import {
  authExpiredEvent,
  clearCsrfToken
} from "../../../../packages/web/src/lib/api/client.ts";

import {
  AuthSessionRefreshCoordinator
} from "../../../../packages/web/src/lib/api/auth-session.ts";

test("[Web/后台访问] 认证过期事件在同一在途窗口只触发一次权威刷新", async () => {
  const coordinator = new AuthSessionRefreshCoordinator();
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let refreshCount = 0;
  const refresh = async () => {
    refreshCount += 1;
    await refreshGate;
  };

  const first = coordinator.run(refresh);
  const second = coordinator.run(refresh);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(refreshCount, 1);
  releaseRefresh();
  await Promise.all([first, second]);

  await coordinator.run(async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 2);
});
test("[Web/后台访问] 认证刷新失败后会释放在途状态并允许成功重试", async () => {
  const coordinator = new AuthSessionRefreshCoordinator();
  let refreshCount = 0;

  await assert.rejects(
    coordinator.run(async () => {
      refreshCount += 1;
      throw new Error("refresh failed");
    }),
    /refresh failed/
  );

  await coordinator.run(async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 2);
});
test("[Web/后台访问] 认证会话恢复保持最新刷新并只注册一个过期监听器", async () => {
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

  const activeAuthListeners = new Set<EventListenerOrEventListenerObject>();
  let authListenerAdds = 0;
  let authListenerRemoves = 0;
  const addWindowEventListener = window.addEventListener.bind(window);
  const removeWindowEventListener = window.removeEventListener.bind(window);
  window.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) => {
    if (type === authExpiredEvent && listener) {
      authListenerAdds += 1;
      activeAuthListeners.add(listener);
    }
    if (listener) addWindowEventListener(type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ) => {
    if (type === authExpiredEvent && listener) {
      authListenerRemoves += 1;
      activeAuthListeners.delete(listener);
    }
    if (listener) removeWindowEventListener(type, listener, options);
  }) as typeof window.removeEventListener;

  let fetchCount = 0;
  const fetchStub = async (input: RequestInfo | URL) => {
    assert.equal(String(input), "/api/admin/auth/me");
    fetchCount += 1;
    return new Response(JSON.stringify({
      ok: true,
      authenticated: true,
      username: `auth-recovery-${fetchCount}`,
      role: "super",
      permissions: [],
      csrf_token: `csrf-${fetchCount}`,
      application_version: "current-test",
      preferences: {},
      preferences_etag: `W/"auth-recovery-preferences-${fetchCount}"`,
      version_settings: { enabled: true, link_enabled: true }
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
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
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
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
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { MemoryRouter } = await import("react-router");
    const { AuthSessionProvider, useAuthSessionQuery } = await import(
      "../../../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);

    let authIsFetching = true;
    function AuthProbe() {
      const query = useAuthSessionQuery();
      authIsFetching = query.isFetching;
      return React.createElement(
        "span",
        null,
        query.data?.authenticated ? query.data.username : "pending"
      );
    }
    const tree = () => React.createElement(
      React.StrictMode,
      null,
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/admin"] },
          React.createElement(
            AuthSessionProvider,
            null,
            React.createElement(AuthProbe)
          )
        )
      )
    );
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        if (predicate()) return;
      }
      assert.fail(
        "auth session recovery did not settle: "
          + `text=${container.textContent} fetches=${fetchCount} `
          + `listeners=${activeAuthListeners.size}`
      );
    };

    await React.act(async () => root.render(tree()));
    await settleUntil(() => (
      !authIsFetching
      && container.textContent === `auth-recovery-${fetchCount}`
    ));
    const initialFetchCount = fetchCount;
    assert.ok(initialFetchCount >= 1);
    assert.equal(activeAuthListeners.size, 1);
    const listenerCountsAfterMount = {
      adds: authListenerAdds,
      removes: authListenerRemoves
    };

    await React.act(async () => root.render(tree()));
    assert.deepEqual({
      adds: authListenerAdds,
      removes: authListenerRemoves
    }, listenerCountsAfterMount, "普通重渲染不得重绑认证过期监听器");

    await React.act(async () => {
      window.dispatchEvent(new window.Event(authExpiredEvent));
      window.dispatchEvent(new window.Event(authExpiredEvent));
      await Promise.resolve();
    });
    await settleUntil(() => (
      !authIsFetching
      && fetchCount === initialFetchCount + 1
      && container.textContent === `auth-recovery-${fetchCount}`
    ));
    assert.equal(
      fetchCount,
      initialFetchCount + 1,
      "同一在途窗口的过期事件应合并为一次最新 refetch"
    );
    assert.equal(activeAuthListeners.size, 1);
    assert.deepEqual({
      adds: authListenerAdds,
      removes: authListenerRemoves
    }, listenerCountsAfterMount);

    await React.act(async () => root.unmount());
    assert.equal(activeAuthListeners.size, 0);
    assert.equal(authListenerRemoves, authListenerAdds);
    window.dispatchEvent(new window.Event(authExpiredEvent));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fetchCount, initialFetchCount + 1, "卸载后不得保留认证刷新入口");
    client.clear();
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
