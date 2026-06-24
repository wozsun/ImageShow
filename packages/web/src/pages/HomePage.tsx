import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { AppHeader } from "../components/AppHeader.js";
import { CopyButton } from "../components/CopyButton.js";
import { Icon } from "../components/Icon.js";
import { SelectMenu } from "../components/SelectMenu.js";
import { ProgressBar } from "../components/ProgressBar.js";
import { ThemeSelector } from "../components/ThemeSelector.js";
import { defaultSite, queryKeys } from "../lib/constants.js";
import { buildRandomUrl } from "../lib/random-url.js";
import { rootSiteOrigin } from "../lib/theme-host.js";
import { randomBrightnessSelectOptions, randomDeviceSelectOptions, randomModeSelectOptions } from "../lib/select-options.js";
import type { GalleryOptions, RandomLinkDraft, RandomMode, SiteConfig } from "../lib/types.js";

export function HomePage() {
  const [device, setDevice] = useState("");
  const [brightness, setBrightness] = useState("random");
  const [themeInput, setThemeInput] = useState("");
  const [mode, setMode] = useState<RandomMode>("");
  const [committed, setCommitted] = useState<RandomLinkDraft>({ device: "", brightness: "random", theme: "", mode: "" });
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "error">("loading");
  const [hasPreview, setHasPreview] = useState(false);
  const [previewObjectUrl, setPreviewObjectUrl] = useState("");
  const [themePending, setThemePending] = useState(false);
  const [themeProgressKey, setThemeProgressKey] = useState(0);
  const [nonce, setNonce] = useState(0);
  const themeTimerRef = useRef<number | undefined>(undefined);
  const previewObjectUrlRef = useRef("");
  const { data: siteConfig } = useQuery<SiteConfig>({ queryKey: queryKeys.siteConfig, queryFn: () => api("/api/site-config") });
  const { data: galleryOptions } = useQuery<GalleryOptions>({ queryKey: queryKeys.galleryOptions, queryFn: () => api("/api/gallery-options") });
  const siteName = siteConfig?.site?.name ?? defaultSite.name;
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
    applyRandomDraft({ device: value, brightness, theme: themeInput, mode });
  };

  const updateBrightness = (value: string) => {
    setBrightness(value);
    applyRandomDraft({ device, brightness: value, theme: themeInput, mode });
  };

  const updateMode = (value: RandomMode) => {
    setMode(value);
    applyRandomDraft({ device, brightness, theme: themeInput, mode: value });
  };

  const updateThemeInput = (value: string) => {
    const normalized = value.toLowerCase();
    setThemeInput(normalized);
    setThemePending(true);
    setThemeProgressKey((current) => current + 1);
    window.clearTimeout(themeTimerRef.current);
    themeTimerRef.current = window.setTimeout(() => {
      applyRandomDraft({ device, brightness, theme: normalized, mode });
    }, previewDelayMs);
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
        <section className="home-hero" style={{ backgroundImage: "url('/random?m=redirect')" }}>
          <div>
            <h1>{siteName}</h1>
            <p>个人图片管理、画廊展示和随机图片 API。</p>
          </div>
        </section>
        <section className="home-bottom">
          <div className="random-preview">
            <div className="panel-head">
              <h2><Icon name="shuffle-line" />随机图片预览</h2>
              <button className="pressable" type="button" onClick={refreshPreview}><Icon name="refresh-line" />刷新</button>
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
            <div className="builder-grid">
              <label>设备<SelectMenu value={device} onChange={updateDevice} options={randomDeviceSelectOptions} ariaLabel="设备" /></label>
              <label>亮度<SelectMenu value={brightness} onChange={updateBrightness} options={randomBrightnessSelectOptions} ariaLabel="亮度" /></label>
              <label>主题<ThemeSelector themes={galleryOptions?.themes ?? []} value={themeInput} onChange={updateThemeInput} /></label>
              <label>模式<SelectMenu value={mode} onChange={(value) => updateMode(value as RandomMode)} options={randomModeSelectOptions} ariaLabel="模式" /></label>
            </div>
            <div className="generated-link">
              <code>{randomUrl}</code>
              <CopyButton value={randomUrl} />
              <a className="button secondary pressable" href={randomUrl} target="_blank" rel="noreferrer noopener"><Icon name="external-link-line" />打开</a>
            </div>
            <p className="builder-hint">可搜索并多选主题，筛选方式可切换为包含或排除。</p>
          </div>
        </section>
      </section>
    </main>
  );
}
