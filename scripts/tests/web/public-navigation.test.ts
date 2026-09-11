import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyGalleryFilters,
  imageBrowseApiSearchParams,
  galleryFiltersFromSearchParams,
  galleryHref,
  galleryRandomRequestDevice,
  showModeFromSearchParams,
  showOrderFromSearchParams,
  updateImageBrowseSearchParams
} from "../../../packages/web/src/lib/gallery/gallery-query.ts";
import {
  publicHomeBrowsePath,
  publicRootPath
} from "../../../packages/web/src/lib/constants.ts";
import {
  buildRandomUrl
} from "../../../packages/web/src/lib/gallery/random-url.ts";
import {
  publicNavigationAutoHideDelayMs,
  publicNavigationTopEdgeRevealHeight
} from "../../../packages/web/src/lib/ui/public-navigation.ts";
import {
  createPublicNavigationHarness
} from "../support/web-test-context.ts";

test("[Web/公开导航] 站点根入口保持 home、show、gallery 与关闭回退语义", () => {
  function site(
    root: "home" | "show" | "gallery",
    homeEnabled: boolean,
    showEnabled = true,
    browseTarget: "gallery" | "show" = "gallery",
    galleryEnabled = true
  ) {
    return {
      root,
      home: {
        enabled: homeEnabled,
        browse_target: browseTarget,
        background: "",
        banner_label: "",
        banner_title: ""
      },
      show: {
        enabled: showEnabled,
        mode: "waterfall" as const,
        density: "balanced" as const,
        drift_speed: 28,
        order: "random" as const
      },
      gallery: { enabled: galleryEnabled }
    };
  }

  assert.equal(publicRootPath(site("home", true)), "/home");
  assert.equal(publicRootPath(site("show", true)), "/show");
  assert.equal(publicRootPath(site("gallery", true)), "/gallery");
  assert.equal(publicRootPath(site("home", false)), "/gallery");
  assert.equal(publicRootPath(site("show", true, false)), "/gallery");
  assert.equal(publicRootPath(site("gallery", false)), "/gallery");
  assert.equal(publicRootPath(site("gallery", false, true, "gallery", false)), "/show");
  assert.equal(publicRootPath(site("gallery", true, false, "gallery", false)), "/home");
  assert.equal(publicRootPath(site("gallery", false, false, "gallery", false)), null);
  assert.equal(publicHomeBrowsePath(site("home", true, true, "show")), "/show");
  assert.equal(publicHomeBrowsePath(site("home", true, false, "show")), "/gallery");
  assert.equal(publicHomeBrowsePath(site("home", true, true, "gallery")), "/gallery");
  assert.equal(
    publicHomeBrowsePath(site("home", true, true, "gallery", false)),
    "/show"
  );
  assert.equal(
    publicHomeBrowsePath(site("home", true, false, "gallery", false)),
    null
  );
  assert.equal(
    publicHomeBrowsePath(site("home", true, true, "show"), true),
    "/embed/show"
  );
  assert.equal(
    publicHomeBrowsePath(site("home", true, true, "show", false), true),
    "/embed/show"
  );
  assert.equal(
    publicHomeBrowsePath(site("home", true, false, "show"), true),
    "/embed/gallery"
  );
  assert.equal(
    publicHomeBrowsePath(site("home", true, false, "show", false), true),
    null
  );
});
test("[Web/公开导航] 桌面与嵌入展映三秒无点击收起，顶部 36px 唤出，导航内悬停和焦点取消计时", async (t) => {
  assert.equal(publicNavigationAutoHideDelayMs, 3000);
  assert.equal(publicNavigationTopEdgeRevealHeight, 36);
  for (const headerPresent of [true, false]) {
    await t.test(headerPresent ? "普通展映" : "嵌入展映", async (t) => {
      const h = await createPublicNavigationHarness(t, { headerPresent });
      await h.advance(2000);
      await h.pointer(200);
      await h.advance(1000);
      assert.equal(h.visible(), false, "普通鼠标移动不重置无点击计时");
      await h.pointer(36);
      assert.equal(h.visible(), false);
      await h.pointer(35);
      assert.equal(h.visible(), true);
      await h.advance(2000);
      await h.pointer(34);
      await h.advance(1000);
      assert.equal(h.visible(), false, "顶部区域内移动也不续期");
      await h.pointer(100);
      await h.pointer(35);
      await h.advance(2000);
      await h.click();
      await h.advance(2999);
      assert.equal(h.visible(), true);
      await h.hover(true);
      assert.equal(h.timerCount(), 0, "悬停期间取消计时器");
      await h.advance(6000);
      assert.equal(h.visible(), true);
      await h.focus(true);
      await h.hover(false);
      assert.equal(h.timerCount(), 0, "鼠标离开但焦点仍在导航内时继续保护");
      await h.advance(6000);
      assert.equal(h.visible(), true);
      await h.focus(false);
      await h.advance(2999);
      assert.equal(h.visible(), true);
      await h.advance(1);
      assert.equal(h.visible(), false);
    });
  }
});
test("[Web/公开导航] 随机图链接取消全选后恢复滚动与三秒计时收起", async (t) => {
  await t.test("滚动收起", async (t) => {
    const h = await createPublicNavigationHarness(t);
    await h.readOnlySelection(true);
    await h.manual(300, "mouse");
    assert.equal(h.visible(), true, "链接仍有选区时保留导航");
    await h.readOnlySelection(false);
    await h.manual(300, "mouse");
    assert.equal(h.visible(), false, "选区折叠后恢复手动滚动收起");
  });

  await t.test("计时收起", async (t) => {
    const h = await createPublicNavigationHarness(t);
    await h.readOnlySelection(true);
    await h.advance(6000);
    assert.equal(h.visible(), true, "链接仍有选区时不执行计时收起");
    assert.equal(h.timerCount(), 0);
    await h.readOnlySelection(false);
    await h.advance(2999);
    assert.equal(h.visible(), true);
    await h.advance(1);
    assert.equal(h.visible(), false, "选区折叠后重新计满三秒并收起");
  });
});
test("[Web/公开导航] 画廊只随滚动显隐，任何页面位置均不启用无操作计时器", async (t) => {
  const h = await createPublicNavigationHarness(t, { movement: "page" });
  await h.advance(6000);
  assert.equal(h.visible(), true);
  await h.scroll(96);
  await h.advance(16);
  await h.advance(6000);
  assert.equal(h.visible(), true);
  await h.scroll(97);
  await h.advance(16);
  await h.advance(6000);
  assert.equal(h.visible(), true);
  assert.equal(h.timerCount(), 0);
  await h.scroll(400);
  await h.advance(16);
  assert.equal(h.visible(), false);
  await h.scroll(0);
  await h.advance(16);
  await h.advance(6000);
  assert.equal(h.visible(), true, "向上滚动唤出后也不会自动收起");
});
test("[Web/公开导航] 展映暂停或后台取消计时，恢复后重新计满三秒，合成移动不唤出", async (t) => {
  const h = await createPublicNavigationHarness(t);
  await h.advance(2999);
  await h.playing(false);
  assert.equal(h.timerCount(), 0);
  await h.advance(6000);
  assert.equal(h.visible(), true);
  await h.playing(true);
  await h.advance(2999);
  assert.equal(h.visible(), true);
  await h.hidden(true);
  assert.equal(h.timerCount(), 0);
  await h.advance(6000);
  await h.hidden(false);
  await h.advance(2999);
  assert.equal(h.visible(), true);
  await h.advance(1);
  assert.equal(h.visible(), false);
  await h.pointer(10, 0, false);
  await h.pointerOver(h.documentBody);
  assert.equal(h.visible(), false, "Pixi 合成事件和导航动画引起的内部悬停切换不能重新展开");
  await h.pointerOver(null);
  assert.equal(h.visible(), true, "真实鼠标从文档外进入顶部仍可唤出");
});
test("[Web/公开导航] 展映桌面鼠标拖动只收起导航，滚轮和触控仍可唤出", async (t) => {
  for (const headerPresent of [true, false]) {
    await t.test(headerPresent ? "普通展映" : "嵌入展映", async (t) => {
      const h = await createPublicNavigationHarness(t, { headerPresent });
      await h.manual(300, "mouse");
      assert.equal(h.visible(), false, "向上拖动仍收起导航");
      await h.manual(-300, "mouse");
      assert.equal(h.visible(), false, "向下拖动回到起点也不唤出");
      await h.manual(1, "mouse");
      assert.equal(h.visible(), false, "反向或小幅惯性不触发顶部自动唤出");
      await h.manual(-1);
      assert.equal(h.visible(), true, "滚轮仍可唤出");
      await h.manual(300, "mouse");
      await h.manual(-300, "touch");
      assert.equal(h.visible(), true, "触控保持原有唤出行为");
    });
  }
});
test("[Web/公开导航] 移动展映拖动继续双向控制导航，并保护键盘可见焦点", async (t) => {
  const h = await createPublicNavigationHarness(t, { mobileLayout: true });
  for (const pointerType of ["touch", "mouse"]) {
    await h.manual(300, pointerType);
    assert.equal(h.visible(), false);
    await h.manual(-300, pointerType);
    assert.equal(h.visible(), true);
  }
  await h.focus(true);
  await h.manual(300, "touch");
  await h.advance(6000);
  assert.equal(h.visible(), true, "移动端键盘操作期间仍保护导航");
  await h.focus(false);
  await h.advance(3000);
  assert.equal(h.visible(), false);
});
test("[Web/公开导航] 移动画廊与展映关闭筛选后，触摸残留的悬停和按钮焦点不阻止收起", async (t) => {
  for (const movement of ["page", "manual"] as const) {
    for (const headerPresent of [true, false]) {
      await t.test(`${movement} / ${headerPresent ? "普通页" : "嵌入页"}`, async (t) => {
        const h = await createPublicNavigationHarness(t, { movement, headerPresent, mobileLayout: true });
        if (movement === "page") {
          await h.scroll(97);
          await h.advance(16);
        }
        await h.hover(true);
        await h.focus(true, false);
        await h.toggleFilters();
        assert.equal(h.filtersOpen(), true);
        await h.advance(6000);
        assert.equal(h.visible(), true, "面板展开期间保持导航");
        await h.toggleFilters();
        assert.equal(h.filtersOpen(), false);
        await h.advance(2999);
        assert.equal(h.visible(), true);
        await h.advance(1);
        assert.equal(h.visible(), movement === "page", "只有展映在关闭后重新计满三秒；画廊保持滚动显隐");
        if (movement === "page") {
          await h.scroll(0);
          await h.advance(16);
          await h.scroll(97);
          await h.advance(16);
        } else {
          await h.manual(-1, "touch");
        }
        await h.toggleFilters();
        await h.toggleFilters();
        if (movement === "page") {
          await h.scroll(400);
          await h.advance(16);
        } else {
          await h.manual(300, "touch");
        }
        assert.equal(h.visible(), false, "关闭后也可随滚动或上拖收起");
      });
    }
  }
});
test("[Web/公开导航] 公开图库筛选与随机图链接使用同一当前参数契约", () => {
  for (const theme of ["~unset", "!~unset", "none", "!none"]) {
    const selected = galleryFiltersFromSearchParams(new URLSearchParams({ theme }));
    assert.equal(selected.theme, theme);
    assert.equal(imageBrowseApiSearchParams(selected, "latest", { view: "gallery" }).get("theme"), theme);
  }
  const filters = galleryFiltersFromSearchParams(new URLSearchParams(
    "device=pc&brightness=dark&theme=editorial,stage&tag=concert,red-carpet&author=startrail-photo"
  ));
  assert.deepEqual(filters, {
    device: "pc",
    brightness: "dark",
    theme: "editorial,stage",
    tag: "concert,red-carpet",
    author: "startrail-photo"
  });
  assert.equal(
    galleryHref(filters),
    "/gallery?device=pc&brightness=dark&theme=editorial%2Cstage&tag=concert%2Cred-carpet&author=startrail-photo"
  );
  assert.equal(
    galleryHref(filters, "/embed/gallery"),
    "/embed/gallery?device=pc&brightness=dark&theme=editorial%2Cstage&tag=concert%2Cred-carpet&author=startrail-photo"
  );
  assert.equal(galleryHref(emptyGalleryFilters), "/gallery");
  assert.equal(
    galleryHref(emptyGalleryFilters, "/embed/gallery"),
    "/embed/gallery"
  );

  const automaticDevice = galleryFiltersFromSearchParams(
    new URLSearchParams("device=auto&brightness=light&theme=stage")
  );
  assert.equal(
    galleryHref(automaticDevice),
    "/gallery?device=auto&brightness=light&theme=stage"
  );
  assert.equal(
    imageBrowseApiSearchParams(automaticDevice, "random", {
      view: "gallery", limit: 60,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    }).toString(),
    "brightness=light&device=pc&limit=60&order=random&theme=stage&view=gallery"
  );
  assert.equal(
    imageBrowseApiSearchParams(automaticDevice, "latest", {
      view: "gallery", limit: 60,
      userAgent: "Mozilla/5.0 (iPhone)"
    }).toString(),
    "brightness=light&device=mb&limit=60&order=latest&theme=stage&view=gallery"
  );
  assert.equal(
    imageBrowseApiSearchParams(automaticDevice, "latest", {
      view: "gallery", limit: 60,
      userAgent: "unrecognized-client"
    }).toString(),
    "brightness=light&limit=60&order=latest&theme=stage&view=gallery"
  );
  assert.equal(galleryRandomRequestDevice(""), "all");
  assert.equal(galleryRandomRequestDevice("auto"), "");
  assert.equal(galleryRandomRequestDevice("pc"), "pc");
  assert.equal(showOrderFromSearchParams(new URLSearchParams(), "oldest"), "oldest");
  assert.equal(showModeFromSearchParams(new URLSearchParams(), "float"), "float");
  assert.equal(
    showModeFromSearchParams(new URLSearchParams("mode=waterfall"), "float"),
    "waterfall"
  );
  assert.equal(
    showModeFromSearchParams(new URLSearchParams("mode=invalid"), "float"),
    "float"
  );
  assert.equal(
    showOrderFromSearchParams(new URLSearchParams("order=latest"), "random"),
    "latest"
  );
  assert.equal(
    showOrderFromSearchParams(new URLSearchParams("order=invalid"), "random"),
    "random"
  );
  const implicit = updateImageBrowseSearchParams(new URLSearchParams(), { theme: "stage" });
  assert.equal(implicit.toString(), "theme=stage");
  assert.equal(showOrderFromSearchParams(implicit, "random"), "random");
  assert.equal(showOrderFromSearchParams(implicit, "latest"), "latest");
  assert.equal(updateImageBrowseSearchParams(implicit, emptyGalleryFilters).toString(), "");
  const explicit = new URLSearchParams("order=oldest&mode=float&tag=concert&tag=stage");
  const selected = updateImageBrowseSearchParams(explicit, { theme: "stage" });
  assert.equal(selected.toString(), "order=oldest&mode=float&tag=concert&tag=stage&theme=stage");
  assert.equal(explicit.toString(), "order=oldest&mode=float&tag=concert&tag=stage");
  const cleared = updateImageBrowseSearchParams(selected, emptyGalleryFilters);
  assert.equal(cleared.toString(), "order=oldest&mode=float");
  const ordered = updateImageBrowseSearchParams(selected, { order: "random" });
  assert.equal(ordered.toString(), "order=random&mode=float&tag=concert&tag=stage&theme=stage");
  assert.equal(showOrderFromSearchParams(ordered, "latest"), "random");
  assert.equal(
    updateImageBrowseSearchParams(implicit, { mode: "float" }).toString(),
    "theme=stage&mode=float"
  );
  assert.equal(
    updateImageBrowseSearchParams(ordered, { mode: "waterfall" }).toString(),
    "order=random&mode=waterfall&tag=concert&tag=stage&theme=stage"
  );
  assert.equal(
    imageBrowseApiSearchParams(automaticDevice, "oldest", {
      view: "show", limit: 100,
      cursor: "cursor-token",
      userAgent: "Mozilla/5.0 (iPhone)"
    }).toString(),
    "brightness=light&cursor=cursor-token&device=mb&limit=100&order=oldest&theme=stage&view=show"
  );
  assert.deepEqual(
    galleryFiltersFromSearchParams(new URLSearchParams("device=all")),
    {
      device: "",
      brightness: "",
      theme: "",
      tag: "",
      author: ""
    }
  );
  assert.equal(
    galleryFiltersFromSearchParams(
      new URLSearchParams(
        "theme=stage,!editorial&tag=valid,INVALID_VALUE"
      )
    ).theme,
    ""
  );

  assert.equal(buildRandomUrl({
    origin: "https://img.example.com",
    device: "pc",
    brightness: "random",
    theme: " Stage, !Archive ",
    tag: "Live",
    author: "Alice",
    mode: "json"
  }), "https://img.example.com/random?device=pc&theme=stage,!archive&tag=live&author=alice&mode=json");
  assert.equal(buildRandomUrl({
    origin: "https://img.example.com",
    device: galleryRandomRequestDevice(""),
    brightness: "random",
    theme: "",
    tag: "",
    author: ""
  }), "https://img.example.com/random?device=all");
  assert.equal(buildRandomUrl({
    origin: "https://img.example.com",
    device: galleryRandomRequestDevice("auto"),
    brightness: "random",
    theme: "",
    tag: "",
    author: ""
  }), "https://img.example.com/random");
});
