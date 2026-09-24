import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { IngestionJob } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-job.ts";
import { createManifestImportJobs } from "../../../../packages/web/src/pages/admin/ingestion/import/manifest-jobs.ts";
import { createConfigStreamHarness } from "../../support/web-test-context.ts";
import {
  dispatchDomEvent,
  inputText
} from "../../support/dom-events.ts";

test("[Web/内容接入] 导入菜单键盘与来源标签保持真实 DOM 焦点和读屏关联", async (t) => {
  const h = await createConfigStreamHarness(t);
  const dom = h.document.defaultView!;
  let active: HTMLElement | null = h.document.body;
  Object.defineProperty(h.document, "activeElement", { configurable: true, get: () => active });
  const priorFocus = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "focus");
  const priorAttach = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "attachEvent");
  const priorDetach = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "detachEvent");
  (dom.HTMLElement.prototype as any).attachEvent = () => {};
  (dom.HTMLElement.prototype as any).detachEvent = () => {};
  const priorBlur = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "blur");
  dom.HTMLElement.prototype.focus = function () {
    active = this;
    this.dispatchEvent(new dom.Event("focusin", { bubbles: true }));
  };
  dom.HTMLElement.prototype.blur = function () {
    if (active === this) active = h.document.body;
  };
  const extra = {
    Event: dom.Event,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
    cancelAnimationFrame: clearTimeout,
    scrollTo() {},
    scrollY: 0,
    innerWidth: 1440,
    innerHeight: 900,
    getComputedStyle: () => ({
      getPropertyValue: () => "",
      display: "block",
      visibility: "visible",
      position: "static",
      overflowY: "visible"
    }),
    matchMedia: (media: string) => ({
      media,
      matches: media.includes("prefers-reduced-motion") || media.includes("min-width"),
      addEventListener() {},
      removeEventListener() {}
    })
  };
  const previous = new Map(
    Object.keys(extra).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const [key, value] of Object.entries(extra))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const key = async (node: Element, value: string) =>
    h.React.act(async () => {
      const event = dispatchDomEvent(h.window, node, "keydown", { key: value });
      await Promise.resolve();
      return event;
    });
  try {
    const { ImportSplitButton } =
      await import("../../../../packages/web/src/pages/admin/ingestion/import/ImportSplitButton.tsx");
    let selected = "";
    let opener: Element | undefined;
    const choose = (name: string) => (element: HTMLButtonElement) => {
      selected = name;
      opener = element;
    };
    const base = {
      pending: false,
      onPreloadWorkflow() {},
      onPreloadImportSource() {},
      onOpenWorkflow() {},
      onOpenUrls: choose("urls"),
      onOpenJsonl: choose("jsonl"),
      onOpenWeibo: choose("weibo")
    };
    const renderMenu = async (pending = false) =>
      h.render(
        h.React.createElement(
          "div",
          null,
          h.React.createElement(ImportSplitButton, { ...base, pending }),
          h.React.createElement("input", { id: "outside-menu" })
        )
      );
    await renderMenu();
    const trigger = () => h.document.querySelector<HTMLButtonElement>('[title="更多导入方式"]')!;
    const items = () => [...h.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    for (const [index, mode] of [
      [0, "urls"],
      [1, "jsonl"],
      [2, "weibo"]
    ] as const) {
      await h.React.act(async () => trigger().focus());
      await key(trigger(), "ArrowDown");
      await h.flush();
      assert.equal(h.document.activeElement, items()[0]);
      await key(items()[0], "End");
      assert.equal(h.document.activeElement, items()[2]);
      await key(items()[2], "ArrowDown");
      assert.equal(h.document.activeElement, items()[0]);
      await key(items()[0], "ArrowUp");
      assert.equal(h.document.activeElement, items()[2]);
      await h.React.act(async () => items()[index].click());
      assert.equal(selected, mode);
      assert.equal(opener, trigger());
    }
    const outside = h.document.getElementById("outside-menu")!;
    await h.React.act(async () => outside.focus());
    await h.React.act(async () => {
      dispatchDomEvent(h.window, trigger(), "pointerover", {
        pointerType: "mouse"
      });
      await Promise.resolve();
    });
    await h.flush();
    assert.equal(h.document.activeElement, outside);
    await h.React.act(async () => {
      const event = new dom.Event("keydown", { bubbles: true });
      (event as any).key = "Escape";
      h.document.dispatchEvent(event);
    });
    assert.equal(h.document.activeElement, outside);
    await key(trigger(), "ArrowUp");
    await h.flush();
    await h.React.act(async () => outside.focus());
    assert.equal(items().length, 0);
    await renderMenu(true);
    await key(trigger(), "ArrowDown");
    assert.equal(items().length, 0);
    await h.render(null);
    const { ImportSourceDialog } =
      await import("../../../../packages/web/src/pages/admin/ingestion/import/ImportSourceDialog.tsx");
    await h.render(
      h.React.createElement(ImportSourceDialog, {
        initialMode: "urls",
        autoImportAfterParse: false,
        maxItems: 200,
        weiboMaxItems: 10,
        onClose() {},
        onSubmit() {}
      })
    );
    const tabs = () => [...h.document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    for (const [value, index] of [
      ["ArrowLeft", 2],
      ["ArrowRight", 0],
      ["End", 2],
      ["Home", 0],
      ["ArrowRight", 1]
    ] as const) {
      const selectedTab = tabs().find((tab) => tab.getAttribute("aria-selected") === "true")!;
      await key(selectedTab, value);
      assert.equal(h.document.activeElement, tabs()[index]);
      assert.equal(tabs().filter((tab) => tab.getAttribute("tabindex") === "0").length, 1);
      const panel = h.document.querySelector('[role="tabpanel"]')!;
      assert.equal(panel.getAttribute("aria-labelledby"), tabs()[index].id);
      assert.equal(tabs()[index].getAttribute("aria-controls"), panel.id);
    }
    await h.React.act(async () => tabs()[0].click());
    assert.equal(h.document.activeElement, h.document.querySelector("textarea"));

    // 解析请求尚未完成时父层重渲染，自动导入必须采用最新提交回调。
    for (const mode of ["weibo", "jsonl"] as const) {
      await h.render(null);
      const jobs: IngestionJob[] = [];
      let closed = 0;
      const renderSource = (storageSlug: string, theme: string) =>
        h.render(
          h.React.createElement(ImportSourceDialog, {
            initialMode: mode,
            autoImportAfterParse: true,
            maxItems: 200,
            weiboMaxItems: 10,
            onClose() {
              closed += 1;
            },
            onSubmit(submission) {
              assert.notEqual(submission.mode, "urls");
              if (submission.mode === "urls") return;
              jobs.push(
                ...createManifestImportJobs(
                  submission.mode === "weibo"
                    ? submission.result.manifest.items
                    : submission.manifest.items,
                  { device: "auto", brightness: "auto", theme, author: "", tags: [] },
                  storageSlug,
                  mode,
                  false
                )
              );
            }
          })
        );
      await renderSource("local", "old");
      const textarea = h.document.querySelector<HTMLTextAreaElement>("textarea")!;
      await h.React.act(async () => {
        inputText(
          h.window,
          textarea,
          mode === "weibo"
            ? "https://weibo.com/123/Abc"
            : '{"original":"https://example.com/image.jpg"}'
        );
        await Promise.resolve();
      });
      const requestIndex = h.pending.length;
      await h.React.act(async () =>
        h.document.querySelector<HTMLButtonElement>(".import-source-submit-button")!.click()
      );
      assert.equal(h.pending.length, requestIndex + 1);
      assert.equal(jobs.length, 0);
      await renderSource("cos", "current");
      const manifest = {
        items: [{ original: "https://example.com/image.jpg", line: 1, batch_position: 0 }],
        errors: []
      };
      await h.respond(
        requestIndex,
        mode === "weibo" ? { manifest, errors: [], posts: [] } : manifest
      );
      assert.equal(jobs.length, 1, "自动导入只提交一次");
      assert.equal(jobs[0].storageSlug, "cos");
      assert.equal(jobs[0].draft.theme, "current");
      assert.equal(closed, 1);
    }
  } finally {
    await h.render(null);
    await h.flush();
    await h.flush();
    if (priorAttach) Object.defineProperty(dom.HTMLElement.prototype, "attachEvent", priorAttach);
    else delete (dom.HTMLElement.prototype as any).attachEvent;
    if (priorDetach) Object.defineProperty(dom.HTMLElement.prototype, "detachEvent", priorDetach);
    else delete (dom.HTMLElement.prototype as any).detachEvent;
    if (priorFocus) Object.defineProperty(dom.HTMLElement.prototype, "focus", priorFocus);
    if (priorBlur) Object.defineProperty(dom.HTMLElement.prototype, "blur", priorBlur);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});
