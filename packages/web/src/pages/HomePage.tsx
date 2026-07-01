import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppHeader } from "../components/AppHeader.js";
import { CopyButton } from "../components/CopyButton.js";
import { Icon } from "../components/Icon.js";
import { SelectMenu } from "../components/SelectMenu.js";
import { ProgressBar } from "../components/ProgressBar.js";
import { FacetSelector } from "../components/FacetSelector.js";
import { defaultSite } from "../lib/constants.js";
import { buildRandomUrl } from "../lib/random-url.js";
import { rootSiteOrigin } from "../lib/theme-host.js";
import { randomBrightnessSelectOptions, randomDeviceSelectOptions, randomModeSelectOptions } from "../lib/select-options.js";
import type { RandomLinkDraft, RandomMode } from "../lib/types.js";
import { useGalleryOptions, useSiteConfig } from "../lib/site-data.js";

export function HomePage() {
  const [device, setDevice] = useState("");
  const [brightness, setBrightness] = useState("random");
  const [themeInput, setThemeInput] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [authorInput, setAuthorInput] = useState("");
  const [mode, setMode] = useState<RandomMode>("");
  const [committed, setCommitted] = useState<RandomLinkDraft>({ device: "", brightness: "random", theme: "", tag: "", author: "", mode: "" });
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "error">("loading");
  const [hasPreview, setHasPreview] = useState(false);
  const [previewObjectUrl, setPreviewObjectUrl] = useState("");
  const [themePending, setThemePending] = useState(false);
  const [themeProgressKey, setThemeProgressKey] = useState(0);
  const [nonce, setNonce] = useState(0);
  const themeTimerRef = useRef<number | undefined>(undefined);
  const previewObjectUrlRef = useRef("");
  const { data: siteConfig } = useSiteConfig();
  const { data: galleryOptions } = useGalleryOptions();
  const siteName = siteConfig?.site?.name ?? defaultSite.name;
  // Effective URL from /api/site-config (default: the site's own random API); falls back
  // to the same-host random endpoint before it loads, mirroring the admin login bg.
  const homeHeroBackground = siteConfig?.site?.home_hero_background || "/random?m=redirect";
  const previewDelayMs = siteConfig?.home.preview_delay_ms ?? 1_000;
  // The shareable link uses the configured public domain, falling back to the
  // current origin only until the site config loads. The preview below keeps the
  // current origin so the dev proxy works and the fetch stays same-origin.
  const linkOrigin = siteConfig?.site.domain
    ? rootSiteOrigin(siteConfig.site.domain).replace(/\/$/, "")
    : window.location.origin;
  const randomUrl = buildRandomUrl({ ...committed, origin: linkOrigin });
  const previewUrl = buildRandomUrl({ ...committed, mode: "proxy" });

  const applyRandomDraft = (next: RandomLinkDraft) => {
    window.clearTimeout(themeTimerRef.current);
    setThemePending(false);
    setCommitted(next);
    setPreviewState("loading");
    setNonce((value) => value + 1);
  };

  const refreshPreview = () => {
    setPreviewState("loading");
    setNonce((value) => value + 1);
  };

  const updateDevice = (value: string) => {
    setDevice(value);
    applyRandomDraft({ device: value, brightness, theme: themeInput, tag: tagInput, author: authorInput, mode });
  };

  const updateBrightness = (value: string) => {
    setBrightness(value);
    applyRandomDraft({ device, brightness: value, theme: themeInput, tag: tagInput, author: authorInput, mode });
  };

  const updateMode = (value: RandomMode) => {
    setMode(value);
    applyRandomDraft({ device, brightness, theme: themeInput, tag: tagInput, author: authorInput, mode: value });
  };

  // Theme/tag changes debounce the preview reload (they fire as you build a
  // multi-select) while the shareable link stays in sync once committed.
  const scheduleFacets = (next: RandomLinkDraft) => {
    setThemePending(true);
    setThemeProgressKey((current) => current + 1);
    window.clearTimeout(themeTimerRef.current);
    themeTimerRef.current = window.setTimeout(() => applyRandomDraft(next), previewDelayMs);
  };

  const updateThemeInput = (value: string) => {
    const normalized = value.toLowerCase();
    setThemeInput(normalized);
    scheduleFacets({ device, brightness, theme: normalized, tag: tagInput, author: authorInput, mode });
  };

  const updateTagInput = (value: string) => {
    const normalized = value.toLowerCase();
    setTagInput(normalized);
    scheduleFacets({ device, brightness, theme: themeInput, tag: normalized, author: authorInput, mode });
  };

  const updateAuthorInput = (value: string) => {
    const normalized = value.toLowerCase();
    setAuthorInput(normalized);
    scheduleFacets({ device, brightness, theme: themeInput, tag: tagInput, author: normalized, mode });
  };

  useEffect(() => {
    let cancelled = false;
    setPreviewState("loading");
    fetch(previewUrl, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`preview ${response.status}`);
        const objectUrl = URL.createObjectURL(await response.blob());
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        if (previewObjectUrlRef.current) URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = objectUrl;
        setPreviewObjectUrl(objectUrl);
        setHasPreview(true);
        setPreviewState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        if (previewObjectUrlRef.current) URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = "";
        setPreviewObjectUrl("");
        setHasPreview(false);
        setPreviewState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [previewUrl, nonce]);

  useEffect(() => () => window.clearTimeout(themeTimerRef.current), []);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add("home-document");
    return () => {
      root.classList.remove("home-document");
    };
  }, []);
  useEffect(() => () => {
    if (previewObjectUrlRef.current) URL.revokeObjectURL(previewObjectUrlRef.current);
  }, []);

  return (
    <main className="page home-page">
      <AppHeader />
      <section className="home-layout">
        <section className="home-hero" style={{ backgroundImage: `url("${homeHeroBackground}")` }}>
          <div>
            <h1>{siteName}</h1>
            <p>个人图片管理、画廊展示和随机图片 API。</p>
          </div>
        </section>
        <section className="home-bottom">
          <div className="random-preview">
            <div className="panel-head">
              <h2><Icon name="shuffle-line" />随机图片预览</h2>
              <button className="pressable" type="button" onClick={refreshPreview}>
                <Icon name="refresh-line" />刷新
              </button>
            </div>
            <div className={`preview-frame ${previewState === "error" ? "error" : ""}`}>
              {hasPreview && previewObjectUrl && (
                <img
                  src={previewObjectUrl}
                  alt="随机图片预览"
                />
              )}
              {previewState === "error" && <div className="preview-message">当前组合没有可用图片，请调整设备、亮度或主题</div>}
              {themePending && <ProgressBar key={`theme-${themeProgressKey}`} durationMs={previewDelayMs} />}
              {!themePending && previewState === "loading" && <ProgressBar indeterminate />}
            </div>
          </div>
          <div className="random-builder">
            <h2>生成随机图链接</h2>
            <div className="builder-grid builder-grid-axes">
              <label>
                设备
                <SelectMenu
                  value={device}
                  onChange={updateDevice}
                  options={randomDeviceSelectOptions}
                  ariaLabel="设备"
                />
              </label>
              <label>
                亮度
                <SelectMenu
                  value={brightness}
                  onChange={updateBrightness}
                  options={randomBrightnessSelectOptions}
                  ariaLabel="亮度"
                />
              </label>
              <label>
                模式
                <SelectMenu
                  value={mode}
                  onChange={(value) => updateMode(value as RandomMode)}
                  options={randomModeSelectOptions}
                  ariaLabel="模式"
                />
              </label>
            </div>
            <div className="builder-grid builder-grid-facets">
              <label>
                主题
                <FacetSelector
                  options={galleryOptions?.themes ?? []}
                  value={themeInput}
                  onChange={updateThemeInput}
                  noun="主题"
                />
              </label>
              <label>
                标签
                <FacetSelector
                  options={galleryOptions?.tags ?? []}
                  value={tagInput}
                  onChange={updateTagInput}
                  noun="标签"
                />
              </label>
              <label>
                作者
                <FacetSelector
                  options={galleryOptions?.authors ?? []}
                  value={authorInput}
                  onChange={updateAuthorInput}
                  noun="作者"
                />
              </label>
            </div>
            <p className="builder-hint">可搜索并多选主题、标签或作者，筛选方式可切换为包含或排除。</p>
            <div className="generated-link">
              <code>{randomUrl}</code>
              <CopyButton value={randomUrl} />
              <a
                className="button secondary pressable"
                href={randomUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                <Icon name="external-link-line" />打开
              </a>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
