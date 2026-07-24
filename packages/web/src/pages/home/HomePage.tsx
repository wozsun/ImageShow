import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AppHeader } from "../../components/navigation/AppHeader.js";
import { GeneratedLinkActions } from "../../components/actions/GeneratedLinkActions.js";
import { Icon } from "../../components/icon/Icon.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { FacetSelector } from "../../components/data-display/FacetSelector.js";
import { buildRandomUrl } from "../../lib/gallery/random-url.js";
import { rootSiteOrigin } from "../../lib/gallery/theme-host.js";
import { cssUrl } from "../../lib/ui/formatters.js";
import { randomBrightnessSelectOptions, randomDeviceSelectOptions, randomModeSelectOptions } from "../../lib/ui/select-options.js";
import type { RandomLinkDraft, RandomMode } from "../../lib/types.js";
import { useGalleryFacets, useSiteConfig } from "../../lib/api/site-data.js";
import { PreviewProgress } from "./PreviewProgress.js";

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
  const [facetPending, setFacetPending] = useState(false);
  const [facetProgressKey, setFacetProgressKey] = useState(0);
  const [nonce, setNonce] = useState(0);
  const facetTimerRef = useRef<number | undefined>(undefined);
  const previewObjectUrlRef = useRef("");
  const { data: siteConfig } = useSiteConfig();
  const { data: galleryFacets } = useGalleryFacets();
  const siteName = siteConfig?.site?.name || "ImageShow";
  const homeTagline = siteConfig?.site?.home.tagline ?? "";

  const homeHeroBackground = siteConfig?.site?.home.hero_background || "/random?m=redirect";
  const previewDelayMs = siteConfig?.site?.home.preview_delay_ms ?? 1_000;

  const linkOrigin = siteConfig?.site.domain
    ? rootSiteOrigin(siteConfig.site.domain).replace(/\/$/, "")
    : window.location.origin;
  const randomUrl = buildRandomUrl({ ...committed, origin: linkOrigin });
  const previewUrl = buildRandomUrl({ ...committed, mode: "proxy" });

  const applyRandomDraft = (next: RandomLinkDraft) => {
    window.clearTimeout(facetTimerRef.current);
    setFacetPending(false);
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

  const scheduleFacets = (next: RandomLinkDraft) => {
    setFacetPending(true);
    setFacetProgressKey((current) => current + 1);
    window.clearTimeout(facetTimerRef.current);
    facetTimerRef.current = window.setTimeout(() => applyRandomDraft(next), previewDelayMs);
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

  useEffect(() => () => window.clearTimeout(facetTimerRef.current), []);
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
        <section className="home-hero" style={{ backgroundImage: cssUrl(homeHeroBackground) }}>
          <div>
            <h1>{siteName}</h1>
            {homeTagline && <p>{homeTagline}</p>}
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
              {facetPending && <PreviewProgress key={`facet-${facetProgressKey}`} durationMs={previewDelayMs} />}
              {!facetPending && previewState === "loading" && <PreviewProgress indeterminate />}
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
                  options={galleryFacets?.themes ?? []}
                  value={themeInput}
                  onChange={updateThemeInput}
                  noun="主题"
                />
              </label>
              <label>
                标签
                <FacetSelector
                  options={galleryFacets?.tags ?? []}
                  value={tagInput}
                  onChange={updateTagInput}
                  noun="标签"
                />
              </label>
              <label>
                作者
                <FacetSelector
                  options={galleryFacets?.authors ?? []}
                  value={authorInput}
                  onChange={updateAuthorInput}
                  noun="作者"
                />
              </label>
            </div>
            <p className="builder-hint">可搜索并多选主题、标签或作者，筛选方式可切换为包含或排除。</p>
            <div className="generated-link">
              <GeneratedLinkActions url={randomUrl} />
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
