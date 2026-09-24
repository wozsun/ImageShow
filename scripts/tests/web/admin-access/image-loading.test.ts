import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";

test("[Web/后台访问] 缩略图真实挂载只请求一次并忽略快速换源的迟到结果", async () => {
  const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
  const React = await import("react");
  const requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number;
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  Object.assign(window, { requestAnimationFrame, cancelAnimationFrame });

  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLImageElement: window.HTMLImageElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
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

  const imagePrototype = window.HTMLImageElement.prototype;
  const originalSetAttribute = imagePrototype.setAttribute;
  const sourceWrites: string[] = [];
  imagePrototype.setAttribute = function setAttribute(name, value) {
    if (name.toLowerCase() === "src") sourceWrites.push(String(value));
    return originalSetAttribute.call(this, name, value);
  };

  try {
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { ThumbnailImage } =
      await import("../../../../packages/web/src/components/image/ThumbnailImage.tsx");

    const settleReact = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };
    const imageWithSource = (container: HTMLElement, source: string) =>
      [...container.querySelectorAll("img")].find((image) => image.getAttribute("src") === source);

    for (const lateOutcome of ["load", "error"] as const) {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const prefix = `https://img.example.test/images/full/${lateOutcome}`;
      const sourceA = `${prefix}-a.webp`;
      const sourceB = `${prefix}-b.webp`;
      const sourceC = `${prefix}-c.webp`;
      const startWrite = sourceWrites.length;
      const renderThumb = (source: string) =>
        React.createElement(
          React.StrictMode,
          null,
          React.createElement(ThumbnailImage, { src: source, alt: "测试缩略图" })
        );

      await React.act(async () => {
        root.render(renderThumb(sourceA));
        await settleReact();
      });
      const imageA = imageWithSource(container, sourceA);
      assert.ok(imageA);
      await React.act(async () => {
        imageA.dispatchEvent(new window.Event("load"));
        await settleReact();
      });
      assert.equal(
        container.querySelector("img.is-ready")?.getAttribute("src"),
        sourceA
      );

      await React.act(async () => {
        root.render(renderThumb(sourceB));
        await settleReact();
      });
      const imageB = imageWithSource(container, sourceB);
      assert.ok(imageB);

      await React.act(async () => {
        imageB.dispatchEvent(new window.Event(lateOutcome));
        flushSync(() => root.render(renderThumb(sourceC)));
        await settleReact();
      });
      assert.equal(
        container.querySelector("img.is-ready")?.getAttribute("src"),
        sourceA
      );
      const imageC = imageWithSource(container, sourceC);
      assert.ok(imageC);
      assert.deepEqual(
        sourceWrites.slice(startWrite),
        [sourceA, sourceB, sourceC]
      );

      await React.act(async () => {
        imageC.dispatchEvent(new window.Event("load"));
        await settleReact();
      });
      assert.equal(
        container.querySelector("img.is-ready")?.getAttribute("src"),
        sourceC
      );
      assert.equal(container.querySelectorAll("img").length, 1);

      await React.act(async () => root.unmount());
      container.remove();
    }
  } finally {
    imagePrototype.setAttribute = originalSetAttribute;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
