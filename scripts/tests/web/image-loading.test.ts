import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { ProgressiveImage } from "../../../packages/web/src/components/image/ProgressiveImage.tsx";
import { ImageLoadSchedulerProvider } from "../../../packages/web/src/components/image/ImageLoadSchedulerContext.tsx";
import { ImageLoadScheduler } from "../../../packages/web/src/components/image/image-load-scheduler.ts";
import { installProperties } from "../support/property-descriptors.ts";

function imageHarness(t: TestContext) {
  const restoreReact = installProperties(globalThis, { React });
  const scheduler = new ImageLoadScheduler(2);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const restoreAnimation = installProperties(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id)
  });
  t.after(async () => {
    try {
      await React.act(async () => root.unmount());
      scheduler.dispose();
      container.remove();
    } finally {
      restoreAnimation();
      restoreReact();
    }
  });
  return {
    container, scheduler, root,
    async render(props: React.ComponentProps<typeof ProgressiveImage>) {
      await React.act(async () => {
        root.render(React.createElement(ImageLoadSchedulerProvider, {
          scheduler,
          children: React.createElement(React.StrictMode, null, React.createElement(ProgressiveImage, props))
        }));
      });
    },
    async dispatch(image: HTMLImageElement, event: string) {
      await React.act(async () => { image.dispatchEvent(new Event(event)); });
    },
    full() {
      const element = container.querySelector<HTMLImageElement>('[data-image-role="full"]');
      assert.ok(element);
      return element;
    }
  };
}

for (const thumbSrc of ["", "/thumb.webp"]) {
  test(`[Web/图片详情] 完整图失败可显式重试且保留可用图层 / ${thumbSrc ? "有缩略图" : "无缩略图"}`, async (t) => {
    const h = imageHarness(t);
    let parentClicks = 0;
    await h.render({ imageKey: "a", fullSrc: "/full.jpg", thumbSrc, onClick: () => parentClicks++ });
    const thumbnail = h.container.querySelector<HTMLImageElement>(".progressive-image-thumb");
    if (thumbSrc) {
      assert.ok(thumbnail);
      await h.dispatch(thumbnail, "load");
    }
    await h.dispatch(h.full(), "error");
    assert.match(h.container.querySelector('[role="status"]')?.textContent ?? "", /图片加载失败/u);
    assert.deepEqual(h.scheduler.snapshot(), { pending: 0, inFlight: 0 });
    assert.equal(h.full().getAttribute("src"), null);
    if (thumbnail) assert.equal(thumbnail.getAttribute("src"), thumbSrc);

    const retry = h.container.querySelector("button");
    assert.ok(retry);
    await React.act(async () => retry.click());
    assert.equal(parentClicks, 0, "重试不得触发外层关闭或放大");
    assert.equal(h.container.querySelector('[role="status"]'), null);
    assert.equal(h.full().getAttribute("src"), "/full.jpg");
    assert.deepEqual(h.scheduler.snapshot(), { pending: 0, inFlight: 1 });
    await h.dispatch(h.full(), "load");
    assert.ok(h.container.querySelector(".progressive-image-full-frame.is-ready"));
    assert.equal(h.container.querySelector('[role="status"]'), null);
    assert.deepEqual(h.scheduler.snapshot(), { pending: 0, inFlight: 0 });
  });
}

test("[Web/图片详情] 换源、换图与关闭隔离旧解码结果并释放加载槽", async (t) => {
  const h = imageHarness(t);
  const oldDecode = Promise.withResolvers<void>();
  await h.render({ imageKey: "a", fullSrc: "/old.jpg" });
  const image = h.full();
  const restoreDecode = installProperties(image, { decode: () => oldDecode.promise });
  await h.dispatch(image, "load");
  restoreDecode();
  await h.render({ imageKey: "a", fullSrc: "/new.jpg" });
  await React.act(async () => oldDecode.resolve());
  assert.equal(h.full().getAttribute("src"), "/new.jpg");
  assert.equal(h.container.querySelector(".progressive-image-full-frame.is-ready"), null);
  assert.equal(h.container.querySelector('[role="status"]'), null);
  await h.dispatch(h.full(), "error");
  assert.ok(h.container.querySelector('[role="status"]'));
  await h.render({ imageKey: "b", fullSrc: "/new.jpg" });
  assert.equal(h.container.querySelector('[role="status"]'), null);
  assert.equal(h.full().getAttribute("src"), "/new.jpg");
  await React.act(async () => h.root.render(null));
  assert.equal(image.getAttribute("src"), null);
  assert.deepEqual(h.scheduler.snapshot(), { pending: 0, inFlight: 0 });
});
