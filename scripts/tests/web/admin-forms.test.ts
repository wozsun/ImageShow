import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHTML
} from "linkedom";
import {
  type IngestionVocabularyDto,
  type RuntimeConfig,
  type StorageBackendMigrationResultDto
} from "../../../packages/shared/src/browser.ts";
import type {
  StorageBackendAdmin
} from "../../../packages/web/src/lib/types.ts";
import {
  ApiClientError,
  authExpiredEvent,
  clearCsrfToken
} from "../../../packages/web/src/lib/api/client.ts";
import {
  invalidateImageDataAfterMetadataSave
} from "../../../packages/web/src/lib/api/query-invalidation.ts";
import {
  queryKeys
} from "../../../packages/web/src/lib/api/query-keys.ts";
import {
  configPackageRecognitionNotice,
  configPackageSlugMappingError
} from "../../../packages/web/src/pages/admin/advanced-config/ConfigPackageImportDialog.tsx";
import {
  imageMetadataCardSaveState,
  changedMetadataUpdate,
  createImageMetadataSaveReport,
  createImageMetadataSession,
  fieldsChangedFor,
  reconcileImageMetadataSession,
  type ImageMetadataSaveAttempt
} from "../../../packages/web/src/components/image/editor/image-metadata-session.ts";
import {
  imageTrashIdsNeedingSnapshot,
  pruneImageMetadataSessionAfterTrash,
  reconcileImageEditorTrash
} from "../../../packages/web/src/components/image/editor/image-editor-trash.ts";
import {
  storageBackendAfterDeleteRejection,
  storageBackendDeletionReasons,
  storageBackendWithHiddenStagingBlocker
} from "../../../packages/web/src/pages/admin/storage/storage-backend-deletion-policy.ts";
import {
  storageBackendEditConfigPatch,
  storageBackendS3AfterSuccessfulSave,
  storageBackendS3FormSettings
} from "../../../packages/web/src/pages/admin/storage/storage-backend-form.ts";
import {
  storageMaintenancePreview
} from "../../../packages/web/src/pages/admin/storage/storage-maintenance-preview.ts";
import {
  tagScrollAvailability,
  tagScrollContentMetrics,
  tagScrollItemMetrics,
  tagScrollNavigationTarget,
  tagVerticalWheelPixels,
  tagWheelScrollTarget
} from "../../../packages/web/src/components/form/tag-input-scroll.ts";
import {
  TagInput
} from "../../../packages/web/src/components/form/TagInput.tsx";
import {
  editableImage,
  imageUpdateResponse,
  createConfigStreamHarness
} from "../support/web-test-context.ts";
import {
  dispatchDomEvent,
  inputText
} from "../support/dom-events.ts";
import {
  installControlledClock
} from "../support/controlled-clock.ts";

test("[Web/后台表单] 存储维护预览区分可修复、不可修复、可删除与受保护项", () => {
  assert.deepEqual(storageMaintenancePreview({
    missing_objects: [{ id: "missing-source", backend: "local", namespace: "local" }],
    missing_thumbs: [
      { id: "missing-source", backend: "local", namespace: "local" },
      { id: "repairable", backend: "local", namespace: "local" },
      { id: "blocked", backend: "archive", namespace: "archive" },
      { id: "broken-alias", backend: "broken-alias", namespace: "shared" }
    ],
    pending_thumbnail_repairs: [
      { id: "pending", backend: "local", namespace: "local" }
    ],
    orphan_objects: [
      { key: "orphan-full", backend: "local", namespace: "local" },
      { key: "shared-orphan", backend: "working-alias", namespace: "shared" }
    ],
    orphan_thumbs: [
      { key: "orphan-thumb", backend: "archive", namespace: "archive" }
    ],
    active_staging_files: [{ key: "active-upload", namespace: "local" }],
    retained_staging_files: [{ key: "retained-upload", namespace: "local" }],
    orphan_staging_files: [
      { key: "orphan-upload", backend: "local", namespace: "local" }
    ],
    incomplete_listings: [
      { backend: "archive", namespace: "archive", prefix: "full" },
      { backend: "archive", namespace: "archive", prefix: "thumbs" }
    ],
    unavailable_backends: [
      {
        backend: "offline",
        namespace: "offline",
        blocks_maintenance: true
      },
      {
        backend: "broken-alias",
        namespace: "shared",
        blocks_maintenance: false
      }
    ]
  }), {
    repairable_thumbnails: 2,
    missing_originals: 1,
    removable_objects: 3,
    protected_staging_objects: 2,
    blocked_namespaces: 2,
    unavailable_logical_backends: 1,
    blocked_items: 3,
    preview_items: 6
  });
  assert.equal(storageMaintenancePreview({ missing_objects: [] }), null);
});
test("[Web/后台表单] 配置包预览明确提示目标版本的采用、回退、忽略与跳过结果", () => {
  const partialNotice = configPackageRecognitionNotice({
    config_values: {
      recognized: 37,
      defaulted: 9,
      ignored: 3
    },
    skipped_storage_backends: 2
  });
  assert.match(partialNotice, /采用 37 个运行时配置项/u);
  assert.match(partialNotice, /9 个运行时配置项使用当前默认值/u);
  assert.match(partialNotice, /忽略 3 个未知或错误的运行时配置字段/u);
  assert.match(partialNotice, /跳过 2 个无法安全识别的存储后端/u);

  const exactNotice = configPackageRecognitionNotice({
    config_values: {
      recognized: 46,
      defaulted: 0,
      ignored: 0
    },
    skipped_storage_backends: 0
  });
  assert.match(exactNotice, /采用 46 个运行时配置项/u);
  assert.match(exactNotice, /0 个运行时配置项使用当前默认值/u);
});
test("[Web/后台表单] 配置包冲突重命名在提交前执行与服务端一致的 slug 长度边界", () => {
  const preview = {
    conflicts: ["archive"],
    existing_slugs: ["local", "archive"],
    storage_backends: [{
      slug: "archive",
      display_name: "Archive",
      enabled: true,
      is_default: false
    }]
  };
  assert.equal(
    configPackageSlugMappingError(
      preview,
      { archive: "a".repeat(33) },
      "archive"
    ),
    "slug 不能超过 32 个字符"
  );
  assert.equal(
    configPackageSlugMappingError(
      preview,
      { archive: "a".repeat(32) },
      "archive"
    ),
    ""
  );
});
test("[Web/后台表单] 站点配置与后台认证初始失败真实挂载保持 bootstrap 反馈语义", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html data-ui-context=bootstrap data-color-scheme=dark>"
      + "<head><meta name=color-scheme content=dark>"
      + "<meta name=theme-color content=#070b15></head>"
      + "<body><div id=root></div></body></html>"
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
  const getComputedStyle = () => ({
    backgroundColor: "rgb(7, 11, 21)",
    getPropertyValue: (name: string) => (
      name === "--color-browser-canvas" ? "#070b15" : ""
    )
  });
  let scenario: "site-config" | "admin-auth" | "public-auth-401" =
    "site-config";
  const requestedPaths: string[] = [];
  const siteConfig = {
    site: {
      name: "ImageShow",
      icon: "/assets/brand/favicon.svg",
      description: "自定义站点描述",
      root: "home",
      home: {
        enabled: true,
        browse_target: "gallery",
        background: "",
        banner_label: "",
        banner_title: ""
      },
      show: {
        enabled: true,
        mode: "waterfall",
        density: "balanced",
        drift_speed: 28,
        order: "random"
      },
      gallery: {
        enabled: true,
        order: "latest",
        public_original_button: false
      },
      static_url: "https://static.example.com"
    },
    embed: { enabled: false }
  };
  const fetchStub = async (input: RequestInfo | URL) => {
    const path = String(input);
    requestedPaths.push(path);
    if (path === "/api/site-config" && scenario === "admin-auth") {
      return new Response(JSON.stringify(siteConfig), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      ok: false,
      error: scenario === "site-config"
        ? "site config unavailable"
        : "auth unavailable"
    }), {
      status: scenario === "public-auth-401" ? 401 : 503,
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
    getComputedStyle,
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
    const { AppRoutes } = await import(
      "../../../packages/web/src/AppRoutes.tsx"
    );
    const { SiteHead } = await import(
      "../../../packages/web/src/components/layout/SiteHead.tsx"
    );
    const { AdminShell } = await import(
      "../../../packages/web/src/pages/admin/shell/AdminShell.tsx"
    );
    const { AuthSessionProvider, useAuthMe } = await import(
      "../../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const container = document.getElementById("root");
    assert.ok(container);

    const renderFailure = async (
      path: "/" | "/admin",
      content: React.ReactNode
    ) => {
      document.documentElement.dataset.uiContext = "bootstrap";
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } }
      });
      const root = createRoot(container);
      await React.act(async () => {
        root.render(React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(
            MemoryRouter,
            { initialEntries: [path] },
            React.createElement(
              AuthSessionProvider,
              null,
              content
            )
          )
        ));
      });
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        if (container.querySelector('[role="alert"]')) break;
      }
      const alert = container.querySelector('[role="alert"]');
      assert.ok(alert);
      assert.match(alert.className, /\bcenter\b/);
      assert.match(alert.textContent ?? "", /加载失败，请稍后重试/);
      assert.equal(document.documentElement.dataset.uiContext, "bootstrap");
      await React.act(async () => root.unmount());
      client.clear();
    };

    await renderFailure(
      "/",
      React.createElement(React.Fragment, null,
        React.createElement(SiteHead),
        React.createElement(AppRoutes)
      )
    );
    assert.deepEqual(requestedPaths, ["/api/site-config"]);

    requestedPaths.length = 0;
    scenario = "admin-auth";
    await renderFailure(
      "/admin",
      React.createElement(React.Fragment, null,
        React.createElement(SiteHead),
        React.createElement(AdminShell, { siteName: siteConfig.site.name })
      )
    );
    assert.deepEqual(
      requestedPaths.sort(),
      ["/api/admin/auth/me", "/api/site-config"]
    );
    assert.equal(
      document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content,
      "自定义站点描述"
    );

    requestedPaths.length = 0;
    siteConfig.site.name = "站点名称回退";
    siteConfig.site.description = "服务端投影后的描述";
    await renderFailure(
      "/admin",
      React.createElement(React.Fragment, null,
        React.createElement(SiteHead),
        React.createElement(AdminShell, { siteName: siteConfig.site.name })
      )
    );
    assert.deepEqual(
      requestedPaths.sort(),
      ["/api/admin/auth/me", "/api/site-config"]
    );
    assert.equal(
      document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content,
      "服务端投影后的描述"
    );

    requestedPaths.length = 0;
    siteConfig.site.name = "另一站点";
    siteConfig.site.description = "服务端权威描述";
    await renderFailure(
      "/admin",
      React.createElement(React.Fragment, null,
        React.createElement(SiteHead),
        React.createElement(AdminShell, { siteName: siteConfig.site.name })
      )
    );
    assert.deepEqual(
      requestedPaths.sort(),
      ["/api/admin/auth/me", "/api/site-config"]
    );
    assert.equal(
      document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content,
      "服务端权威描述"
    );

    requestedPaths.length = 0;
    scenario = "public-auth-401";
    localStorage.setItem("site_session_hint", "1");
    const authClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    const authRoot = createRoot(container);
    function PublicAuthProbe() {
      const query = useAuthMe();
      return React.createElement(
        "span",
        { "data-auth-probe": true },
        query.isError ? "failed" : "pending"
      );
    }
    await React.act(async () => {
      authRoot.render(React.createElement(
        QueryClientProvider,
        { client: authClient },
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/"] },
          React.createElement(
            AuthSessionProvider,
            null,
            React.createElement(PublicAuthProbe)
          )
        )
      ));
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (container.textContent === "failed") break;
    }
    assert.equal(container.textContent, "failed");
    assert.deepEqual(requestedPaths, ["/api/admin/auth/me"]);
    assert.equal(localStorage.getItem("site_session_hint"), null);
    await React.act(async () => authRoot.unmount());
    authClient.clear();
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
for (const itemCount of [1, 3]) {
  test(`[Web/后台表单] 图片元数据会话以同一契约处理 ${itemCount} 项`, () => {
    const ids = Array.from({ length: itemCount }, (_, index) => `image-${index}`);
    let state = createImageMetadataSession(ids.map((id) => editableImage(id)));
    state = {
      ...state,
      drafts: Object.fromEntries(ids.map((id) => [
        id,
        { ...state.drafts[id]!, title: `${id}-saved` }
      ]))
    };
    const updates = ids.map((id, index) => changedMetadataUpdate(
      state.baselineItems[index]!,
      state.drafts[id]!,
      fieldsChangedFor(state.baselineItems[index]!, state.drafts[id]!)
    ));
    assert.deepEqual(updates, ids.map((id) => ({
      id,
      title: `${id}-saved`
    })));

    const attempt: ImageMetadataSaveAttempt = {
      activeIds: ids,
      items: updates,
      response: imageUpdateResponse(ids)
    };
    const authority = ids.map((id) => editableImage(id, {
      title: `${id}-saved`
    }));
    const report = createImageMetadataSaveReport(attempt, authority);
    const next = reconcileImageMetadataSession(state, attempt, authority);
    assert.deepEqual(
      { updated: report.updated, failed: report.failed },
      { updated: itemCount, failed: 0 }
    );
    assert.equal(report.responseReceived, true);
    for (const id of ids) {
      assert.equal(imageMetadataCardSaveState(report, id), "saved");
      assert.equal(fieldsChangedFor(
        authority.find((item) => item.id === id)!,
        next.drafts[id]!
      ).title, false);
    }

    const pendingWithResponse = createImageMetadataSaveReport(attempt, null);
    assert.equal(pendingWithResponse.responseReceived, true);
    for (const id of ids) {
      assert.equal(imageMetadataCardSaveState(
        pendingWithResponse,
        id
      ), "pending");
    }

    const unknownAttempt: ImageMetadataSaveAttempt = {
      ...attempt,
      response: null
    };
    const pendingWithoutResponse = createImageMetadataSaveReport(
      unknownAttempt,
      null
    );
    const confirmedWithoutResponse = createImageMetadataSaveReport(
      unknownAttempt,
      authority
    );
    assert.equal(pendingWithoutResponse.responseReceived, false);
    assert.equal(confirmedWithoutResponse.responseReceived, false);
    for (const id of ids) {
      assert.equal(imageMetadataCardSaveState(
        pendingWithoutResponse,
        id
      ), "pending");
      assert.equal(imageMetadataCardSaveState(
        confirmedWithoutResponse,
        id
      ), "saved");
    }
  });
}
test("[Web/后台表单] 可空来源可添加和清空，权威回读收敛草稿及丢失回执", () => {
  const id = "source-image";
  let state = createImageMetadataSession([editableImage(id, { source: null })]);
  assert.equal(state.drafts[id]!.source, "");
  assert.equal(fieldsChangedFor(state.baselineItems[0]!, state.drafts[id]!).source, false);

  for (const source of ["https://source.example.com/post", ""]) {
    state = {
      ...state,
      drafts: { [id]: { ...state.drafts[id]!, source } }
    };
    const changes = fieldsChangedFor(state.baselineItems[0]!, state.drafts[id]!);
    assert.equal(changes.source, true);
    const update = changedMetadataUpdate(state.baselineItems[0]!, state.drafts[id]!, changes);
    assert.deepEqual(update, { id, source });
    const attempt: ImageMetadataSaveAttempt = {
      activeIds: [id], items: [update], response: null
    };
    const authority = [editableImage(id, { source: source || null })];
    const report = createImageMetadataSaveReport(attempt, authority);
    assert.equal(imageMetadataCardSaveState(report, id), "saved");
    state = reconcileImageMetadataSession(state, attempt, authority);
    assert.equal(state.drafts[id]!.source, source);
    assert.equal(fieldsChangedFor(state.baselineItems[0]!, state.drafts[id]!).source, false);
  }
});
test("[Web/后台表单] 图片元数据部分失败保留对应卡片草稿", () => {
  let state = createImageMetadataSession([
    editableImage("a"),
    editableImage("b")
  ]);
  state = {
    ...state,
    drafts: {
      a: { ...state.drafts.a!, title: "a-saved" },
      b: { ...state.drafts.b!, title: "b-retry", tags: ["landed"] }
    }
  };
  const attempt: ImageMetadataSaveAttempt = {
    activeIds: ["a", "b"],
    items: [
      { id: "a", title: "a-saved" },
      { id: "b", title: "b-retry", tags: ["landed"] }
    ],
    response: imageUpdateResponse(["a"], ["b"])
  };
  const authority = [
    editableImage("a", { title: "a-saved" }),
    editableImage("b", { tags: ["landed"] })
  ];
  const report = createImageMetadataSaveReport(attempt, authority);
  const next = reconcileImageMetadataSession(state, attempt, authority);
  assert.equal(imageMetadataCardSaveState(report, "a"), "saved");
  assert.equal(imageMetadataCardSaveState(report, "b"), "failed");
  assert.equal(fieldsChangedFor(authority[0]!, next.drafts.a!).title, false);
  assert.equal(fieldsChangedFor(authority[1]!, next.drafts.b!).title, true);
  assert.equal(fieldsChangedFor(authority[1]!, next.drafts.b!).tags, false);
});
test("[Web/后台表单] 图片编辑器 trash 以逐项结果和权威回读收敛成员", () => {
  const requestedIds = ["A", "b", "c"];
  const response = {
    requested: 3,
    // 聚合计数即使与逐项结果矛盾也不能成为成功依据。
    trashed: 3,
    ignored: 0,
    results: [
      { id: "a", status: "trashed" as const },
      { id: "b", status: "ignored" as const },
      { id: "outside", status: "trashed" as const }
    ]
  };
  assert.deepEqual(
    imageTrashIdsNeedingSnapshot(requestedIds, response),
    ["b", "c"]
  );
  const reconciled = reconcileImageEditorTrash(
    requestedIds,
    response,
    [editableImage("B")]
  );
  assert.deepEqual(reconciled, {
    trashedIds: ["A", "c"],
    editableIds: ["b"],
    unknownIds: []
  });

  const responseLost = reconcileImageEditorTrash(
    requestedIds,
    null,
    [editableImage("A")]
  );
  assert.deepEqual(responseLost, {
    trashedIds: ["b", "c"],
    editableIds: ["A"],
    unknownIds: []
  });
  assert.deepEqual(
    reconcileImageEditorTrash(requestedIds, null, null),
    {
      trashedIds: [],
      editableIds: [],
      unknownIds: requestedIds
    }
  );

  const session = createImageMetadataSession(
    requestedIds.map((id) => editableImage(id))
  );
  assert.deepEqual(
    pruneImageMetadataSessionAfterTrash(session, ["a", "C"]),
    {
      activeIds: ["b"],
      baselineItems: [editableImage("b")],
      drafts: { b: session.drafts.b }
    }
  );
});
test("[Web/后台表单] 存储删除反馈以服务端权威结果收口", () => {
  const backend = {
    slug: "archive",
    display_name: "Archive",
    enabled: true,
    is_default: false,
    type: "local",
    image_count: 3,
    ingestion_session_count: 0,
    cleanup_job_count: 0,
    failed_cleanup_job_count: 0,
    exhausted_cleanup_job_count: 0,
    deletion: { action: "migrate", blockers: ["images"] }
  } satisfies StorageBackendAdmin;
  assert.deepEqual(storageBackendDeletionReasons(backend), [
    "仍有 3 张图片使用该后端；请先迁移这些图片。"
  ]);
  const rejected = storageBackendAfterDeleteRejection(backend, new ApiClientError(
    "后端仍在使用",
    409,
    "storage_backend_in_use",
    {
      image_count: 0,
      ingestion_session_count: 2,
      cleanup_job_count: 1,
      deletion: {
        action: "blocked",
        blockers: ["ingestion_sessions", "cleanup_jobs"]
      }
    }
  ));
  assert.ok(rejected);
  assert.deepEqual(rejected.deletion.blockers, ["ingestion_sessions", "cleanup_jobs"]);
  assert.deepEqual(storageBackendWithHiddenStagingBlocker(backend, {
    ...backend,
    deletion: { action: "blocked", blockers: ["staging_objects"] }
  }).deletion.blockers, ["images", "staging_objects"]);
});
test("[Web/后台表单] 整后端迁移以错误总数为权威并只发布稳定错误样本", () => {
  const migration = {
    source: "archive",
    target: "local",
    migrated: 8,
    unchanged: 1,
    missing: 0,
    error_samples: [{
      id: "0198f6f8-168f-74fd-b3f2-a71d71742845",
      object_key: "45/0198f6f8-168f-74fd-b3f2-a71d71742845.webp",
      code: "storage_object_conflict",
      message: "仅供展示的诊断文本"
    }],
    error_count: 2
  } satisfies StorageBackendMigrationResultDto;
  assert.equal(migration.error_count, 2);
  assert.equal(migration.error_samples.length, 1);
  assert.deepEqual(
    migration.error_samples.map(({ code }) => code),
    ["storage_object_conflict"]
  );
  assert.equal("errors" in migration, false);
});
test("[Web/后台表单] 存储编辑只提交变化字段并省略空凭据", () => {
  const backend = {
    slug: "archive",
    display_name: "Archive",
    enabled: true,
    is_default: false,
    type: "s3",
    image_count: 0,
    ingestion_session_count: 0,
    cleanup_job_count: 0,
    failed_cleanup_job_count: 0,
    exhausted_cleanup_job_count: 0,
    deletion: { action: "delete", blockers: [] },
    s3: {
      endpoint: "https://objects.example.com",
      region: "ap-southeast-1",
      bucket: "gallery",
      access_key_id: "key",
      force_path_style: false,
      root_path: "/images",
      public_base_url: "https://cdn.example.com",
      connect_timeout_seconds: 15,
      idle_timeout_seconds: 15,
      task_timeout_seconds: 300,
      secret_access_key_configured: false
    }
  } satisfies StorageBackendAdmin;
  assert.deepEqual(storageBackendS3FormSettings(), {
    endpoint: "",
    region: "auto",
    bucket: "",
    access_key_id: "",
    force_path_style: true,
    root_path: "/",
    public_base_url: "",
    connect_timeout_seconds: 15,
    idle_timeout_seconds: 15,
    task_timeout_seconds: 300,
    secret_access_key: ""
  });
  const unchanged = storageBackendS3FormSettings(backend);
  assert.equal("secret_access_key_configured" in unchanged, false);
  assert.deepEqual(storageBackendEditConfigPatch(backend, unchanged), {});

  const presentationPatch = storageBackendEditConfigPatch(backend, {
    ...unchanged,
    public_base_url: "https://assets.example.com"
  });
  assert.deepEqual(
    { display_name: backend.display_name, ...presentationPatch },
    {
      display_name: "Archive",
      s3: { public_base_url: "https://assets.example.com" }
    },
    "保存请求不应重新发送未变化配置或空 Secret"
  );
  assert.deepEqual(
    { slug: backend.slug, ...presentationPatch },
    {
      slug: "archive",
      s3: { public_base_url: "https://assets.example.com" }
    },
    "连接测试应复用同一个差异 patch"
  );
  const credentialPatch = storageBackendEditConfigPatch(backend, {
    ...unchanged,
    secret_access_key: "replacement"
  });
  assert.deepEqual(credentialPatch, {
    s3: { secret_access_key: "replacement" }
  });
  const afterSave = storageBackendS3AfterSuccessfulSave({
    ...unchanged,
    secret_access_key: "replacement"
  });
  const refreshedBackend = {
    ...backend,
    s3: { ...backend.s3, secret_access_key_configured: true }
  };
  assert.equal(afterSave.secret_access_key, "");
  assert.deepEqual(
    storageBackendEditConfigPatch(refreshedBackend, afterSave),
    {},
    "Secret false→true 刷新后再次保存或测试不应发送只读标记或明文凭据"
  );
});
test("[Web/后台表单] 标签可视窗口逐个补齐相邻项目并独占纯纵向滚轮", () => {
  assert.deepEqual(
    tagScrollItemMetrics(747, 5_922, { left: -5_171, width: 117 }, 4),
    { offsetLeft: 0, offsetWidth: 117 },
    "弹窗外层坐标与 viewport 内边距必须归一化到标签内容坐标"
  );
  assert.deepEqual(
    tagScrollContentMetrics({
      clientWidth: 208,
      scrollLeft: 300,
      scrollWidth: 508
    }, 4, 4),
    {
      clientWidth: 200,
      scrollLeft: 300,
      scrollWidth: 500
    },
    "内容模型应同时扣除两侧内边距且保持真实最大 scrollLeft"
  );
  const metrics = {
    clientWidth: 200,
    scrollLeft: 0,
    scrollWidth: 410
  };
  const items = [
    { offsetLeft: 0, offsetWidth: 60 },
    { offsetLeft: 66, offsetWidth: 60 },
    { offsetLeft: 132, offsetWidth: 60 },
    { offsetLeft: 198, offsetWidth: 60 },
    { offsetLeft: 264, offsetWidth: 140 }
  ];
  assert.deepEqual(tagScrollAvailability(metrics), {
    backward: false,
    forward: true
  });
  assert.equal(
    tagScrollNavigationTarget(metrics, items, 1),
    58,
    "前进应以最小位移只补齐首个被右侧遮挡的标签"
  );
  assert.equal(
    tagScrollNavigationTarget({ ...metrics, scrollLeft: 58 }, items, -1),
    0,
    "后退应以最小位移只补齐首个被左侧遮挡的标签"
  );
  const navigationInsets = {
    leading: 14,
    trailing: 14
  };
  assert.equal(
    tagScrollNavigationTarget(metrics, items, 1, navigationInsets),
    7,
    "按钮渐变覆盖了当前末项的一小部分时，应先以最小位移将该项补齐"
  );
  assert.equal(
    tagScrollNavigationTarget(
      { ...metrics, scrollLeft: 58 },
      items,
      1,
      navigationInsets
    ),
    73,
    "继续前进时必须把目标标签完整移出按钮包含半透明渐变在内的覆盖区"
  );
  assert.equal(
    tagScrollNavigationTarget(
      { ...metrics, scrollLeft: 72 },
      items,
      -1,
      navigationInsets
    ),
    51,
    "后退补齐标签时必须把其左边界移出按钮的完整覆盖区"
  );
  assert.equal(
    tagScrollNavigationTarget(
      { clientWidth: 200, scrollLeft: 526, scrollWidth: 726 },
      [
        ...items,
        { offsetLeft: 500, offsetWidth: 140 },
        { offsetLeft: 646, offsetWidth: 80 }
      ],
      -1
    ),
    500,
    "末端输入恰好对齐时应以最小位移完整显示前一个标签"
  );
  const wideMetrics = {
    clientWidth: 200,
    scrollLeft: 0,
    scrollWidth: 490
  };
  const wideItems = [
    { offsetLeft: 0, offsetWidth: 400 },
    { offsetLeft: 406, offsetWidth: 80 }
  ];
  assert.equal(
    tagScrollNavigationTarget(wideMetrics, wideItems, 1),
    200,
    "超宽首项应先显示连续中段，不能只移动内边距"
  );
  assert.equal(
    tagScrollNavigationTarget(
      { ...wideMetrics, scrollLeft: 200 },
      wideItems,
      1
    ),
    286,
    "超宽首项末端已对齐后应以最小位移补齐尾部输入组"
  );
  assert.equal(
    tagScrollNavigationTarget(
      { ...wideMetrics, scrollLeft: 290 },
      wideItems,
      -1
    ),
    200,
    "从尾部后退应先对齐超宽项末端"
  );
  assert.equal(
    tagScrollNavigationTarget(
      { ...wideMetrics, scrollLeft: 200 },
      wideItems,
      -1
    ),
    0,
    "超宽项第二次后退应回到其起始边界"
  );
  const extraWideMetrics = {
    clientWidth: 200,
    scrollLeft: 0,
    scrollWidth: 690
  };
  const extraWideItems = [
    { offsetLeft: 0, offsetWidth: 600 },
    { offsetLeft: 606, offsetWidth: 80 }
  ];
  assert.deepEqual(
    [0, 200, 400].map((scrollLeft) => tagScrollNavigationTarget(
      { ...extraWideMetrics, scrollLeft },
      extraWideItems,
      1
    )),
    [200, 400, 486],
    "超过两个 viewport 的标签必须逐屏连续前进后才进入尾部输入组"
  );
  assert.deepEqual(
    [490, 400, 200].map((scrollLeft) => tagScrollNavigationTarget(
      { ...extraWideMetrics, scrollLeft },
      extraWideItems,
      -1
    )),
    [400, 200, 0],
    "超过两个 viewport 的标签必须逐屏连续后退"
  );
  assert.equal(
    tagScrollNavigationTarget(
      tagScrollContentMetrics({
        clientWidth: 208,
        scrollLeft: 300,
        scrollWidth: 508
      }, 4, 4),
      [{ offsetLeft: 250, offsetWidth: 100 }],
      -1
    ),
    250,
    "普通项后退时应以最小位移让左边界落入物理可视区"
  );
  assert.deepEqual(
    tagScrollAvailability({ ...metrics, scrollLeft: 210 }),
    { backward: true, forward: false }
  );
  assert.equal(tagVerticalWheelPixels({
    clientWidth: 200,
    deltaMode: 0,
    deltaX: 0,
    deltaY: 48
  }), 48);
  assert.equal(tagVerticalWheelPixels({
    clientWidth: 200,
    deltaMode: 1,
    deltaX: 0,
    deltaY: -3
  }), -48);
  assert.equal(tagVerticalWheelPixels({
    clientWidth: 200,
    deltaMode: 2,
    deltaX: 0,
    deltaY: 1
  }), 200);
  assert.equal(tagVerticalWheelPixels({
    clientWidth: 200,
    deltaMode: 0,
    deltaX: 0,
    deltaY: 0.5
  }), null, "不足一个像素的纵向噪声不得接管滚轮");
  assert.equal(tagVerticalWheelPixels({
    clientWidth: 200,
    deltaMode: 0,
    deltaX: 0.25,
    deltaY: 30
  }), null, "混合 deltaX/deltaY 应保留触控板原生横向路径");
  assert.equal(tagWheelScrollTarget(metrics, 80), 80);
  assert.equal(
    tagWheelScrollTarget({ ...metrics, scrollLeft: 210 }, 80),
    210,
    "末端纵向滚轮仍应锁定在标签横向边界"
  );
});
test("[Web/后台表单] 标签翻页键的键盘焦点保留草稿且 disabled 切换重算溢出", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div><button id=outside>外部</button></body></html>"
  );
  const React = await import("react");
  class TestResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const matchMedia = (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  });
  let animationFrame = 0;
  const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = ++animationFrame;
    frameTimers.set(id, setTimeout(() => {
      frameTimers.delete(id);
      callback(0);
    }, 0));
    return id;
  };
  const cancelAnimationFrame = (id: number) => {
    const timer = frameTimers.get(id);
    if (timer) clearTimeout(timer);
    frameTimers.delete(id);
  };
  const getComputedStyle = () => ({
    paddingLeft: "4px",
    paddingRight: "4px",
    overflow: "visible",
    overflowX: "auto",
    overflowY: "visible"
  }) as CSSStyleDeclaration;
  Object.assign(window, {
    innerWidth: 1_024,
    innerHeight: 768,
    matchMedia,
    ResizeObserver: TestResizeObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
    getComputedStyle
  });
  Object.defineProperties(window.HTMLElement.prototype, {
    clientHeight: { configurable: true, get: () => 0 },
    clientWidth: { configurable: true, get: () => 0 },
    offsetHeight: { configurable: true, get: () => 0 },
    offsetWidth: { configurable: true, get: () => 0 },
    scrollHeight: { configurable: true, get: () => 0 },
    scrollWidth: { configurable: true, get: () => 0 }
  });
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    ResizeObserver: TestResizeObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
    getComputedStyle,
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

  let unmountRoot: (() => Promise<void>) | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const changes: string[][] = [];
    const renderTagInputs = (disabled: boolean) => React.createElement(
      React.Fragment,
      null,
      React.createElement(TagInput, {
        key: "decoy",
        value: ["decoy"],
        onChange: () => {},
        suggestions: [],
        disabled,
        ariaLabel: "前置标签",
        className: "decoy-tag-input"
      }),
      React.createElement(TagInput, {
        key: "target",
        value: ["alpha", "beta"],
        onChange: (next: string[]) => changes.push(next),
        suggestions: [{
          slug: "draft-pending",
          display_name: "Draft pending"
        }],
        disabled,
        ariaLabel: "测试标签",
        className: "target-tag-input"
      })
    );
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    unmountRoot = async () => {
      await React.act(async () => root.unmount());
    };
    await React.act(async () => {
      root.render(renderTagInputs(true));
      await Promise.resolve();
    });

    const control = container.querySelector<HTMLElement>(
      ".target-tag-input"
    );
    assert.ok(control);
    const viewport = control.querySelector<HTMLElement>(
      ".tag-input-scroll-window"
    );
    assert.ok(viewport);
    let clientWidth = 100;
    let scrollWidth = 300;
    let scrollLeft = 0;
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, get: () => clientWidth },
      scrollWidth: { configurable: true, get: () => scrollWidth },
      scrollLeft: {
        configurable: true,
        get: () => scrollLeft,
        set: (value: number) => { scrollLeft = value; }
      }
    });
    await React.act(async () => {
      root.render(renderTagInputs(false));
      await Promise.resolve();
    });

    const input = control.querySelector<HTMLInputElement>(".tag-input-field");
    const decoyInput = container.querySelector<HTMLInputElement>(
      ".decoy-tag-input .tag-input-field"
    );
    const navigation = [...control.querySelectorAll<HTMLButtonElement>(
      "[data-tag-scroll-navigation]"
    )];
    const removeButton = control.querySelector<HTMLButtonElement>(
      ".tag-chip-remove"
    );
    const backward = navigation[0];
    const forward = navigation[1];
    assert.ok(input && decoyInput && removeButton && backward && forward);
    const testRect = (left: number, width: number) => ({
      bottom: 36,
      height: 36,
      left,
      right: left + width,
      top: 0,
      width,
      x: left,
      y: 0,
      toJSON: () => ({})
    });
    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => testRect(0, 100)
    });
    Object.defineProperty(backward, "getBoundingClientRect", {
      configurable: true,
      value: () => testRect(-4, 22)
    });
    Object.defineProperty(forward, "getBoundingClientRect", {
      configurable: true,
      value: () => testRect(82, 22)
    });
    Object.defineProperty(removeButton, "getBoundingClientRect", {
      configurable: true,
      value: () => testRect(0, 24)
    });
    for (const item of control.querySelectorAll<HTMLElement>(
      "[data-tag-scroll-item]"
    )) {
      Object.defineProperty(item, "getBoundingClientRect", {
        configurable: true,
        value: () => testRect(4, 0)
      });
    }
    assert.equal(forward.disabled, false, "启用态内容溢出后应显示前进键");

    const dispatchWheel = async (
      target: Element,
      deltaX: number,
      deltaY: number
    ) => {
      const event = new window.Event("wheel", {
        bubbles: true,
        cancelable: true
      });
      Object.defineProperties(event, {
        deltaMode: { configurable: true, value: 0 },
        deltaX: { configurable: true, value: deltaX },
        deltaY: { configurable: true, value: deltaY }
      });
      await React.act(async () => {
        target.dispatchEvent(event);
        await Promise.resolve();
      });
      return event;
    };
    const movingWheel = await dispatchWheel(forward, 0, 40);
    assert.equal(movingWheel.defaultPrevented, true, "按钮覆盖区的鼠标滚轮也应归标签框所有");
    assert.equal(scrollLeft, 40, "标签框内纯纵向滚轮应转换为横向位移");
    scrollLeft = 200;
    const edgeWheel = await dispatchWheel(forward, 0, 40);
    assert.equal(edgeWheel.defaultPrevented, true, "到达横向边界后不得把滚轮交还页面");
    assert.equal(scrollLeft, 200, "边界滚轮不得越过标签内容范围");
    const trackpadWheel = await dispatchWheel(viewport, 12, 40);
    assert.equal(trackpadWheel.defaultPrevented, false, "带水平分量的触控板事件应保留原生路径");
    assert.equal(scrollLeft, 200, "触控板事件不得再由纵向转换路径重复移动");
    scrollLeft = 0;

    let activeElement: Element | null = null;
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => activeElement
    });
    Object.defineProperty(input, "focus", {
      configurable: true,
      value: () => { activeElement = input; }
    });
    Object.defineProperty(decoyInput, "focus", {
      configurable: true,
      value: () => { activeElement = decoyInput; }
    });
    for (const button of navigation) {
      Object.defineProperty(button, "focus", {
        configurable: true,
        value: () => {
          if (!button.disabled) activeElement = button;
        }
      });
    }
    await React.act(async () => {
      input.focus();
      inputText(window as Window, input, "draft-pending");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(input.value, "draft-pending");
    assert.equal(input.getAttribute("aria-expanded"), "true");

    const blankPress = dispatchDomEvent(window as Window, viewport, "pointerdown", {
      button: 0,
      clientX: 0,
      clientY: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse"
    });
    assert.equal(blankPress.defaultPrevented, true, "内部空白按下必须保留编辑器焦点");
    assert.equal(document.activeElement, input);
    const touchPress = dispatchDomEvent(window as Window, viewport, "pointerdown", {
      button: 0,
      clientX: 20,
      clientY: 20,
      isPrimary: true,
      pointerId: 2,
      pointerType: "touch"
    });
    assert.equal(touchPress.defaultPrevented, false, "内部触控按下必须继续交给横向手势");
    const firstChip = control.querySelector<HTMLElement>(".tag-chip");
    assert.ok(firstChip);
    type TestTouch = {
      identifier: number;
      clientX: number;
      clientY: number;
    };
    const dispatchTouch = async (
      target: Element,
      type: "touchstart" | "touchmove" | "touchend" | "touchcancel",
      touches: TestTouch[],
      changedTouches: TestTouch[]
    ) => {
      const event = new window.Event(type, {
        bubbles: true,
        cancelable: true
      });
      Object.defineProperties(event, {
        touches: { configurable: true, value: touches },
        changedTouches: { configurable: true, value: changedTouches }
      });
      await React.act(async () => {
        target.dispatchEvent(event);
        await Promise.resolve();
      });
      return event;
    };
    activeElement = forward;
    scrollLeft = 0;
    await dispatchTouch(
      viewport,
      "touchstart",
      [{ identifier: 2, clientX: 20, clientY: 20 }],
      [{ identifier: 2, clientX: 20, clientY: 20 }]
    );
    await dispatchTouch(
      viewport,
      "touchmove",
      [{ identifier: 2, clientX: 25, clientY: 20 }],
      [{ identifier: 2, clientX: 25, clientY: 20 }]
    );
    const dragTouchEnd = await dispatchTouch(
      viewport,
      "touchend",
      [],
      [{ identifier: 2, clientX: 25, clientY: 20 }]
    );
    assert.equal(dragTouchEnd.defaultPrevented, false, "横向手势抬起不得取消原生路径");
    assert.equal(document.activeElement, forward, "横向移动达到手势阈值后不得抢回输入焦点");
    assert.equal(scrollLeft, 0, "横向手势的触控路径不得重复移动标签窗口");
    await dispatchTouch(
      firstChip,
      "touchstart",
      [{ identifier: 3, clientX: 20, clientY: 20 }],
      [{ identifier: 3, clientX: 20, clientY: 20 }]
    );
    await dispatchTouch(
      firstChip,
      "touchmove",
      [{ identifier: 3, clientX: 22, clientY: 21 }],
      [{ identifier: 3, clientX: 22, clientY: 21 }]
    );
    const tapTouchEnd = await dispatchTouch(
      firstChip,
      "touchend",
      [],
      [{ identifier: 3, clientX: 22, clientY: 21 }]
    );
    assert.equal(
      tapTouchEnd.defaultPrevented,
      true,
      "触控轻点必须在原生 touchend 取消兼容焦点与 click"
    );
    assert.equal(
      document.activeElement,
      input,
      "未达到手势阈值的 touchend 必须直接聚焦末尾编辑器"
    );
    assert.equal(
      scrollLeft,
      200,
      "已有标签占满视区时，聚焦必须同时露出末尾输入位置"
    );
    const synthesizedClick = dispatchDomEvent(window as Window, firstChip, "click");
    assert.equal(
      synthesizedClick.defaultPrevented,
      true,
      "非 Touch-Event 浏览器的 click 回退仍须阻止默认焦点离开编辑器"
    );
    assert.equal(document.activeElement, input);
    await React.act(async () => {
      scrollLeft = 0;
      dispatchDomEvent(window as Window, viewport, "scroll");
      await Promise.resolve();
    });
    activeElement = decoyInput;
    const dragPress = dispatchDomEvent(window as Window, removeButton, "pointerdown", {
      button: 0,
      clientX: 10,
      clientY: 18,
      isPrimary: true,
      pointerId: 40,
      pointerType: "touch"
    });
    dispatchDomEvent(window as Window, removeButton, "pointermove", {
      button: 0,
      clientX: 15,
      clientY: 18,
      isPrimary: true,
      pointerId: 40,
      pointerType: "touch"
    });
    const dragRelease = dispatchDomEvent(window as Window, removeButton, "pointerup", {
      button: 0,
      clientX: 15,
      clientY: 18,
      isPrimary: true,
      pointerId: 40,
      pointerType: "touch"
    });
    assert.equal(dragPress.defaultPrevented, true, "删除键触控按下应继续保留原输入焦点");
    assert.equal(dragRelease.defaultPrevented, false, "达到手势阈值的松手不得提交按钮激活");
    assert.equal(changes.length, 0, "从删除键开始拖动标签窗口不得移除标签");
    assert.equal(document.activeElement, decoyInput, "删除键拖动不得抢走其他输入框焦点");

    dispatchDomEvent(window as Window, removeButton, "pointerdown", {
      button: 0,
      clientX: 10,
      clientY: 18,
      isPrimary: true,
      pointerId: 41,
      pointerType: "touch"
    });
    dispatchDomEvent(window as Window, removeButton, "pointermove", {
      button: 0,
      clientX: 13,
      clientY: 18,
      isPrimary: true,
      pointerId: 41,
      pointerType: "touch"
    });
    const tapRelease = dispatchDomEvent(window as Window, removeButton, "pointerup", {
      button: 0,
      clientX: 13,
      clientY: 18,
      isPrimary: true,
      pointerId: 41,
      pointerType: "touch"
    });
    assert.equal(tapRelease.defaultPrevented, true, "阈值内轻点仍应激活标签删除键");
    assert.deepEqual(changes, [["beta"]], "轻点标签删除键仍应只移除对应标签");
    changes.length = 0;
    input.focus();

    const removePress = dispatchDomEvent(window as Window, removeButton, "pointerdown", {
      button: 0,
      clientX: 10,
      clientY: 18,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse"
    });
    assert.equal(removePress.defaultPrevented, true, "chip 移除键按下必须保留编辑器焦点");
    assert.equal(document.activeElement, input);

    await React.act(async () => {
      dispatchDomEvent(window as Window, input, "focusout", { relatedTarget: forward });
      await Promise.resolve();
    });
    assert.equal(changes.length, 0, "Tab 到翻页键不得提交草稿");
    assert.equal(input.value, "draft-pending", "Tab 到翻页键不得清空输入");
    assert.equal(
      input.getAttribute("aria-expanded"),
      "true",
      "翻页键取得键盘焦点时建议菜单应保持"
    );

    await React.act(async () => {
      activeElement = forward;
      assert.equal(document.activeElement, forward);
      dispatchDomEvent(window as Window, forward, "click");
      dispatchDomEvent(window as Window, forward, "focusout", { relatedTarget: input });
      await Promise.resolve();
    });
    assert.equal(changes.length, 0, "键盘与辅助技术 click 路径不得提交草稿");
    assert.equal(input.value, "draft-pending");
    assert.equal(forward.disabled, true, "到达末端后前进键必须立即失效");
    assert.equal(
      document.activeElement,
      input,
      "当前键盘导航按钮失效前必须把焦点无结算地归还输入"
    );
    assert.equal(changes.length, 0, "边界禁用导致的焦点转移不得提交草稿");
    assert.equal(input.value, "draft-pending");
    assert.equal(input.getAttribute("aria-expanded"), "true");

    dispatchDomEvent(window as Window, input, "compositionstart");
    activeElement = removeButton;
    scrollWidth = 180;
    scrollLeft = 0;
    await React.act(async () => {
      root.render(renderTagInputs(true));
      await Promise.resolve();
    });
    assert.equal(input.disabled, false, "复合禁用不应原生禁用焦点落点");
    assert.equal(input.getAttribute("aria-disabled"), "true");
    assert.equal(control.hasAttribute("aria-disabled"), false);
    assert.equal(control.hasAttribute("data-tag-input-disabled"), true);
    assert.equal(removeButton.isConnected, true, "禁用切换不得移除当前内部焦点 owner");
    assert.equal(removeButton.getAttribute("aria-disabled"), "true");
    assert.equal(removeButton.tabIndex, -1);
    await React.act(async () => {
      dispatchDomEvent(window as Window, removeButton, "click");
      await Promise.resolve();
    });
    assert.equal(changes.length, 0, "禁用态保留可见删除符号仍不得移除标签");
    assert.equal(document.activeElement, input, "禁用切换应先把 chip 移除键焦点归还输入");
    assert.equal(input.tabIndex, -1, "禁用态输入不得进入顺序 Tab 导航");
    assert.equal(scrollLeft, 0, "禁用态方向交接测试应从左端开始");
    assert.equal(backward.disabled, true);
    assert.equal(forward.disabled, false);
    await React.act(async () => {
      activeElement = forward;
      dispatchDomEvent(window as Window, forward, "click");
      await Promise.resolve();
    });
    assert.equal(scrollLeft, 80, "禁用态前进键应移动到右端");
    assert.equal(forward.disabled, true);
    assert.equal(backward.disabled, false);
    assert.equal(
      document.activeElement,
      input,
      "整体禁用时应由只读编辑器稳定接管键盘焦点"
    );
    assert.equal(changes.length, 0, "禁用态翻页方向互换不得提交草稿");
    assert.equal(input.value, "draft-pending");

    scrollWidth = 100;
    scrollLeft = 0;
    await React.act(async () => {
      dispatchDomEvent(window as Window, viewport, "scroll");
      await Promise.resolve();
    });
    assert.equal(backward.disabled, true);
    assert.equal(forward.disabled, true);
    assert.equal(
      document.activeElement,
      input,
      "禁用态无可用方向时焦点仍应留在标签复合控件内"
    );
    assert.equal(changes.length, 0, "整体禁用时导航键失焦不得提交草稿");
    assert.equal(input.value, "draft-pending", "整体禁用时应保留未结算草稿");
    assert.equal(
      forward.disabled,
      true,
      "禁用期间可用宽度变化后应立即隐藏失效翻页键"
    );

    scrollWidth = 300;
    await React.act(async () => {
      root.render(renderTagInputs(false));
      await Promise.resolve();
    });
    assert.equal(
      forward.disabled,
      false,
      "恢复可编辑并重新溢出后应立即恢复前进键"
    );
    assert.equal(
      document.activeElement,
      input,
      "复合控件恢复编辑时应保留输入焦点"
    );
    await React.act(async () => {
      const event = dispatchDomEvent(window as Window, input, "keydown", {
        key: "Enter",
        keyCode: 13,
        isComposing: false
      });
      assert.equal(event.defaultPrevented, true, "恢复编辑后 Enter 不得被残留 IME 状态吞掉");
      await Promise.resolve();
    });
    assert.deepEqual(changes, [["alpha", "beta", "draft-pending"]]);
    await React.act(async () => {
      inputText(window as Window, input, "draft-final");
      await Promise.resolve();
    });

    const outside = document.getElementById("outside");
    assert.ok(outside);
    await React.act(async () => {
      dispatchDomEvent(window as Window, input, "focusout", { relatedTarget: outside });
      await Promise.resolve();
    });
    assert.deepEqual(
      changes,
      [
        ["alpha", "beta", "draft-pending"],
        ["alpha", "beta", "draft-final"]
      ],
      "焦点真正离开整个控件后才结算草稿"
    );

    await unmountRoot();
    unmountRoot = undefined;
  } finally {
    await unmountRoot?.();
    for (const timer of frameTimers.values()) clearTimeout(timer);
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/后台表单] 后台配置首载失败可重试，配置到达前不挂载，后台刷新失败保留已编辑页面", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { AdminSettingsBoundary } = await import("../../../packages/web/src/components/feedback/AdminSettingsBoundary.tsx");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  t.after(() => client.clear());
  let mounts = 0;
  function Page({ pageSize }: { pageSize: number }) {
    const [value, setValue] = h.React.useState(() => { mounts += 1; return pageSize; });
    return h.React.createElement("button", { onClick: () => setValue((current) => current + 1) }, String(value));
  }
  await h.render(h.React.createElement(QueryClientProvider, { client },
    h.React.createElement(AdminSettingsBoundary, {
      children: (settings) => h.React.createElement(Page, { pageSize: settings.admin.image_page_size })
    })
  ));
  assert.equal(mounts, 0);
  assert.equal(h.pending.length, 1);
  await h.respond(0, { error: "暂时不可用" }, 503);
  assert.equal(mounts, 0);
  assert.ok(h.document.querySelector('[role="alert"]'));
  const retry = [...h.document.querySelectorAll("button")].find((button) => button.textContent?.includes("重试"));
  assert.ok(retry);
  await h.React.act(async () => retry.click());
  assert.equal(h.pending.length, 2);
  await h.respond(1, { settings: { admin: { image_page_size: 73 } } });
  assert.equal(mounts, 1);
  assert.equal(h.document.querySelector("button")?.textContent, "73");
  await h.React.act(async () => h.document.querySelector("button")!.click());
  await h.React.act(async () => { void client.refetchQueries({ queryKey: queryKeys.settings }); });
  await h.respond(2, { error: "刷新失败" }, 503);
  assert.equal(h.document.querySelector("button")?.textContent, "74");
  assert.equal(mounts, 1, "已有设置的后台失败不能重挂内容接入与编辑状态");
});
test("[Web/后台表单] 配置包原始响应复用认证与 CSRF 边界且不探测 auth/me", async (t) => {
  const { apiResponse, getCsrfToken, setCsrfToken } = await import("../../../packages/web/src/lib/api/client.ts");
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  t.after(() => { globalThis.fetch = originalFetch; clearCsrfToken(); if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else delete (globalThis as any).window; });
  let expired = 0;
  events.addEventListener(authExpiredEvent, () => expired++);
  const calls: string[] = [];
  setCsrfToken("export-token");
  globalThis.fetch = async (path, init) => {
    calls.push(String(path));
    assert.equal(init?.credentials, "same-origin");
    assert.equal(new Headers(init?.headers).get("x-csrf-token"), calls.length === 1 ? "export-token" : null);
    return calls.length === 1 ? new Response("proxy error", { status: 401 })
      : new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Disposition": 'attachment; filename="config.zip"' } });
  };
  await assert.rejects(apiResponse("/api/admin/advanced-config/export", { method: "POST" }), (e: any) => e.status === 401 && e.message === "HTTP 401");
  assert.equal(expired, 1);
  assert.equal(getCsrfToken(), "");
  const response = await apiResponse("/api/admin/advanced-config/export", { method: "POST" });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);
  assert.match(response.headers.get("content-disposition")!, /config.zip/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((path) => !path.includes("/auth/me")));
});
test("[Web/后台表单] 日志等级保存隔离旧读取，跨文件缓存采用确认值且刷新失败不回退", async (t) => {
  const h = await createConfigStreamHarness(t, { honorAbort: false });
  const clock = installControlledClock(t, h.window);
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
  const { LogPage } = await import("../../../packages/web/src/pages/admin/LogPage.tsx").finally(() => hooks.deregister());
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { ActionFeedbackProvider } = await import("../../../packages/web/src/components/feedback/ActionFeedbackRegion.tsx");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  t.after(() => client.clear());
  const payload = (level: string, selected = "app.log") => ({
    level, selected, content: "existing log", bytes_read: 12, limit_bytes: 100, truncated: false,
    files: ["app.log", "old.log"].map((name) => ({ name, size: 12, modified_at: "2026-09-05T00:00:00Z" }))
  });
  client.setQueryData([...queryKeys.logs, ""], payload("WARN"));
  client.setQueryData([...queryKeys.logs, "old.log"], payload("WARN", "old.log"));
  await h.render(h.React.createElement(QueryClientProvider, { client }, h.React.createElement(ActionFeedbackProvider, null, h.React.createElement(LogPage))));
  const select = (label: string) => h.document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
  const choose = async (label: string, value: string) => {
    await h.React.act(async () => {
      dispatchDomEvent(h.window, select(label), "click", { detail: 0 });
      await Promise.resolve();
    });
    const option = [...h.document.querySelectorAll<HTMLButtonElement>(
      `[role="listbox"][aria-label="${label}"] [role="option"]`
    )].find((entry) => entry.textContent === value);
    assert.ok(option, `${label} 应显示 ${value} 选项`);
    await h.React.act(async () => {
      dispatchDomEvent(h.window, option, "click", { detail: 0 });
      await Promise.resolve();
    });
    await h.flush();
  };
  const visibleLevel = () => select("日志写入等级").textContent;
  await h.React.act(async () => { void client.refetchQueries({ queryKey: [...queryKeys.logs, ""], exact: true }); });
  await choose("日志写入等级", "INFO");
  assert.equal(h.pending.length, 2);
  await choose("日志文件", "old.log");
  const successfulLevelSave = h.respond(1, { level: "INFO" });
  await Promise.resolve();
  await clock.advanceBy(499);
  assert.equal(select("日志写入等级").hasAttribute("disabled"), true);
  await clock.advanceBy(1);
  await successfulLevelSave;
  assert.equal(h.pending[0].signal?.aborted, true);
  assert.equal(h.pending.length, 3, "保存后只刷新当前文件一次");
  assert.equal(h.pending[2].path, "/api/admin/logs?file=old.log");
  await h.respond(0, payload("WARN"));
  await h.respond(2, { error: "failed" }, 503);
  assert.equal(visibleLevel(), "INFO");
  assert.equal(select("日志写入等级").hasAttribute("disabled"), false);
  for (const file of ["", "old.log"]) assert.equal(client.getQueryData<any>([...queryKeys.logs, file]).level, "INFO");
  await choose("日志文件", "app.log");
  assert.equal(visibleLevel(), "INFO");
  await h.respond(3, payload("INFO"));
  await choose("日志写入等级", "DEBUG");
  const failedLevelSave = h.respond(4, { error: "POST failed" }, 503);
  await Promise.resolve();
  await clock.advanceBy(499);
  assert.equal(select("日志写入等级").hasAttribute("disabled"), true);
  await clock.advanceBy(1);
  await failedLevelSave;
  assert.equal(visibleLevel(), "INFO");
  assert.equal(select("日志写入等级").hasAttribute("disabled"), false);
  assert.equal(h.pending.length, 5, "失败提交不发起刷新");
});
test("[Web/后台表单] 词条卡片同 slug 按字段保护 dirty，clean 跟随权威且成功保存立即归于 clean", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { VocabularyAdminCard } = await import("../../../packages/web/src/pages/admin/VocabularyAdminCard.tsx");
  for (const kind of ["themes", "tags", "authors"] as const) {
    let item: { slug: string; display_name: string; image_count: number; link: string } = {
      slug: kind,
      display_name: "old",
      image_count: 1,
      link: "https://example.com/old"
    };
    let refreshFails = false;
    const props = { kind, onChanged: async () => { if (refreshFails) throw Error("refresh failed"); }, onDelete() {}, onError() {}, reorderBusy: false, canMovePrevious: false, canMoveNext: false, onMove() {}, onReorderControlRef() {} } as const;
    const render = async () => h.render(h.React.createElement(VocabularyAdminCard, { ...props, item }));
    await render();
    const display = () => h.document.querySelector<HTMLInputElement>(".entity-display-input")!;
    const change = async (value: string) => h.React.act(async () => {
      inputText(h.window, display(), value);
      await Promise.resolve();
    });
    item = { ...item, display_name: "fresh" }; await render();
    assert.equal(display().value, "fresh");
    await change(" mine ");
    item = { ...item, display_name: "remote", link: "https://example.com/fresh" }; await render();
    assert.equal(display().value, " mine ");
    if (kind === "authors") assert.equal(h.document.querySelector<HTMLInputElement>(".entity-link-input")!.value, item.link);
    const save = h.document.querySelector<HTMLButtonElement>(".entity-card-foot .button")!;
    refreshFails = true;
    await h.React.act(async () => save.click());
    const requestIndex = h.pending.length - 1;
    await h.respond(requestIndex, kind === "authors" ? { item: { ...item, display_name: "mine" } } : { ok: true });
    assert.equal(display().value, "mine");
    // Props stay stale after failed refresh; the next authority update should still replace clean saved input.
    item = { ...item, display_name: "new authority" }; await render();
    assert.equal(display().value, "new authority");
    await change("unsaved");
    item = { ...item, slug: kind + "-other", display_name: "replacement" }; await render();
    assert.equal(display().value, "replacement");
    await h.render(null);
  }
});
test("[Web/后台表单] 站点配置保留未保存值，保存锁住所有控件并在超时、失败和卸载后收口", async (t) => {
  const h = await createConfigStreamHarness(t);
  const clock = installControlledClock(t, h.window);
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
  const { SettingsPage } = await import("../../../packages/web/src/pages/admin/SettingsPage.tsx").finally(() => hooks.deregister());
  const { appConfig } = await import("../../../packages/shared/src/app-config.ts");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  t.after(() => client.clear());
  const originalTimeout = AbortSignal.timeout;
  let deadline = new AbortController();
  AbortSignal.timeout = (ms) => { assert.equal(ms, 15_000); deadline = new AbortController(); return deadline.signal; };
  t.after(() => { AbortSignal.timeout = originalTimeout; });
  let settings = structuredClone(appConfig.runtimeDefaults) as RuntimeConfig;
  client.setQueryData(queryKeys.settings, { settings });
  await h.render(h.React.createElement(QueryClientProvider, { client }, h.React.createElement(SettingsPage)));
  const input = () => h.document.querySelector<HTMLInputElement>('input[placeholder="站点名称"]')!;
  const edit = async (value: string) => h.React.act(async () => {
    inputText(h.window, input(), value);
    await Promise.resolve();
  });
  const publish = async (name: string) => { settings = { ...settings, site: { ...settings.site, name } }; await h.React.act(async () => client.setQueryData(queryKeys.settings, { settings })); await h.flush(); };
  const save = () => [...h.document.querySelectorAll<HTMLButtonElement>(".settings-head-actions button")].at(-1)!;
  const locked = () => h.document.querySelector("fieldset")!.hasAttribute("disabled");
  await publish("fresh"); assert.equal(input().value, "fresh");
  await edit("unsaved"); await publish("background"); assert.equal(input().value, "unsaved");
  const number = h.document.querySelector<HTMLInputElement>('input[type="number"]')!;
  await h.React.act(async () => {
    inputText(h.window, number, "77");
    await Promise.resolve();
  });
  Object.defineProperty(h.document,"activeElement",{configurable:true,get:()=>number});
  number.blur = () => {
    dispatchDomEvent(h.window, number, "focusout", { relatedTarget: null });
  };
  await h.React.act(async () => { save().click(); save().click(); });
  assert.equal(JSON.parse(String(h.pending[0].body)).site.gallery.limit,77,"锁定前同步结算数字输入，提交当前可见值");
  delete (h.document as any).activeElement;
  assert.equal(h.pending.length, 1); assert.equal(locked(), true);
  assert.ok([...h.document.querySelectorAll('.select-trigger')].every((element) => element.hasAttribute("disabled")));
  await edit("blocked"); assert.equal(input().value, "unsaved");
  await h.React.act(async () => {
    deadline.abort(new DOMException("timed out", "TimeoutError"));
    await Promise.resolve();
    await clock.advanceBy(499);
    assert.equal(locked(), true, "最短反馈期限前保持保存锁定");
    await clock.advanceBy(1);
  });
  assert.equal(locked(), false); assert.equal(input().value, "unsaved");
  assert.match(h.document.querySelector('[role="alert"]')!.textContent!, /超时/);
  await edit("normalized input ");
  await h.React.act(async () => save().click());
  const successfulSave = h.respond(1, { settings: { ...settings, site: { ...settings.site, name: "normalized input" } } });
  await Promise.resolve();
  await clock.advanceBy(499);
  assert.equal(locked(), true, "成功反馈期限前保持保存锁定");
  await clock.advanceBy(1);
  await successfulSave;
  assert.equal(input().value, "normalized input"); assert.equal(locked(), false);
  assert.equal(h.pending.length, 2, "成功响应直接发布配置，无 GET 回读");
  await publish("after save"); assert.equal(input().value, "after save");
  await edit("retain after failure"); await h.React.act(async () => save().click());
  const failedSave = h.respond(2, { error: "save failure" }, 503);
  await Promise.resolve();
  await clock.advanceBy(499);
  assert.equal(locked(), true, "失败反馈期限前保持保存锁定");
  await clock.advanceBy(1);
  await failedSave;
  assert.equal(locked(), false); assert.equal(input().value, "retain after failure");
  await h.React.act(async () => save().click());
  await h.render(null);
  assert.equal(h.pending[3].signal?.aborted, true);
});
test("[Web/后台表单] 词表首份请求尚未完成时新词条提交隔离旧响应", async () => {
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  let resolveOld!: (value: IngestionVocabularyDto) => void;
  let calls = 0;
  const old = { themes: [], authors: [], tags: [] } as IngestionVocabularyDto;
  const fresh = { ...old, tags: [{ slug: "new", display_name: "new" }] } as IngestionVocabularyDto;
  const observer = new QueryObserver(client, { queryKey: queryKeys.ingestionVocabulary, queryFn: () => ++calls === 1 ? new Promise<IngestionVocabularyDto>((resolve) => { resolveOld = resolve; }) : Promise.resolve(fresh) });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const refresh = invalidateImageDataAfterMetadataSave(client, [{ id: "image", tags: ["new"] }], []);
    resolveOld(old);
    await refresh;
    assert.deepEqual(client.getQueryData(queryKeys.ingestionVocabulary), fresh);
    assert.equal(calls, 2);
  } finally { unsubscribe(); client.clear(); }
});
test("[Web/后台表单] 单项服务端状态桶覆盖等待、执行、重复待决和全部终态", async () => {
  const { ingestionStatusSummary } = await import("../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-status-summary.ts");
  const cases = [
    ["queued", false, false, "waiting"], ["received", false, false, "waiting"],
    ["downloading", false, false, "running"], ["preparing", false, false, "running"],
    ["preparing", false, true, "waiting"], ["ready", false, false, "ready"],
    ["ready", true, false, "duplicate_pending"], ["committing", false, false, "committing"],
    ["resolving", false, false, "resolving"], ["completed", true, true, "completed"],
    ["failed", true, true, "failed"]
  ] as const;
  for (const [status, duplicate, waiting, bucket] of cases) {
    const summary = ingestionStatusSummary(status, duplicate, waiting);
    assert.equal(summary.total, 1); assert.equal(summary.unfinished, status === "completed" ? 0 : 1);
    const { total, unfinished, ...buckets } = summary;
    assert.deepEqual(Object.entries(buckets).filter(([, value]) => value), [[bucket, 1]]);
  }
});
