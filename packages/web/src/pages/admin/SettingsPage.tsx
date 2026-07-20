import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { NumberInput } from "../../components/form/NumberInput.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { StableButtonLabel } from "../../components/data-display/StableButtonLabel.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { adminApiBasePath, queryKeys } from "../../lib/constants.js";
import { galleryOrderSelectOptions } from "../../lib/ui/select-options.js";
import { errorMessage } from "../../lib/ui/formatters.js";
import type { AdminSettings, SiteSettings } from "../../lib/types.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import {
  ActionFeedback,
  createActionFeedback,
  type ActionFeedbackState
} from "../../components/feedback/ActionFeedback.js";
import { invalidateRuntimeData } from "../../lib/api/query-invalidation.js";

export function SettingsPage() {
  const query = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: () => api(`${adminApiBasePath}/settings`) });
  const client = useQueryClient();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const [action, setAction] = useState<"" | "save-application" | "reload">("");
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (query.data?.settings) {
      setSettings(query.data.settings);
    }
  }, [query.data]);
  if (!settings) {
    if (query.isError) return <QueryErrorState error={query.error} onRetry={() => void query.refetch()} fullPage />;
    return (
      <section className="workspace">
        <h1>站点配置</h1>
        <p className="muted">加载中</p>
      </section>
    );
  }
  const saveApplication = async () => {
    if (action) return;
    setAction("save-application");
    setFeedback(createActionFeedback("正在保存应用配置...", "pending"));
    try {
      const site = settings.site.home.enabled ? settings.site : { ...settings.site, root_redirect: "gallery" as const };
      await api(`${adminApiBasePath}/settings`, {
        method: "POST",
        body: JSON.stringify({
          site,
          upload: {
            list_page_size: settings.upload.list_page_size,
            concurrency: settings.upload.concurrency
          },
          link_image: {
            fill_original_url: settings.link_image.fill_original_url,
            concurrency: settings.link_image.concurrency
          },
          normalize: settings.normalize,
          thumbnail: settings.thumbnail,
          admin: settings.admin,
          image_detail: settings.image_detail
        })
      });
      setFeedback(createActionFeedback("应用配置已保存", "success"));
      // 统一失效已包含 settings 和 site-config；活动查询会在这里完成一次刷新，避免先
      // refetch settings、随后又因 invalidate 重复请求。
      await invalidateRuntimeData(client);
    } catch (error) {
      setFeedback(createActionFeedback(`保存失败：${errorMessage(error)}`, "error"));
    } finally {
      setAction("");
    }
  };
  const reloadConfig = async () => {
    if (action) return;
    setAction("reload");
    setFeedback(createActionFeedback("正在读取配置文件...", "pending"));
    try {
      await api(`${adminApiBasePath}/settings/reload`, { method: "POST" });
      await invalidateRuntimeData(client);
      setFeedback(createActionFeedback("已读取并应用最新配置文件", "success"));
    } catch (error) {
      setFeedback(createActionFeedback(`读取失败：${errorMessage(error)}`, "error"));
    } finally {
      setAction("");
    }
  };
  const updateSite = (patch: Partial<AdminSettings["site"]>) => setSettings({ ...settings, site: { ...settings.site, ...patch } });
  const updateSiteHome = (patch: Partial<AdminSettings["site"]["home"]>) => updateSite({ home: { ...settings.site.home, ...patch } });
  const updateHomeEnabled = (enabled: boolean) => updateSite({
    home: { ...settings.site.home, enabled },
    ...(enabled ? {} : { root_redirect: "gallery" as const })
  });
  const updateSiteGallery = (patch: Partial<AdminSettings["site"]["gallery"]>) => updateSite({ gallery: { ...settings.site.gallery, ...patch } });
  const updateUpload = (patch: Partial<AdminSettings["upload"]>) => setSettings({ ...settings, upload: { ...settings.upload, ...patch } });
  const updateLinkImage = (patch: Partial<AdminSettings["link_image"]>) => setSettings({ ...settings, link_image: { ...settings.link_image, ...patch } });
  const updateNormalize = (patch: Partial<AdminSettings["normalize"]>) => setSettings({ ...settings, normalize: { ...settings.normalize, ...patch } });
  const updateThumbnail = (patch: Partial<AdminSettings["thumbnail"]>) => setSettings({ ...settings, thumbnail: { ...settings.thumbnail, ...patch } });
  const updateAdmin = (patch: Partial<AdminSettings["admin"]>) => setSettings({ ...settings, admin: { ...settings.admin, ...patch } });
  return (
    <section className="workspace settings-page">
      <header className="workspace-head">
        <div>
          <h1>站点配置</h1>
          <p>站点信息与应用参数</p>
        </div>
        <div className="settings-head-actions">
          <button
            type="button"
            className="settings-config-button"
            disabled={action === "reload"}
            onClick={reloadConfig}
          >
            <Icon name="refresh-line" />
            <StableButtonLabel idle="读取配置文件" busyText="读取中" busy={action === "reload"} />
          </button>
          <button
            className="button settings-config-button"
            type="button"
            disabled={action === "save-application"}
            onClick={saveApplication}
          >
            <Icon name="save-3-line" />
            <StableButtonLabel idle="保存应用配置" busyText="保存中" busy={action === "save-application"} />
          </button>
        </div>
      </header>
      <div className="settings-scroll-region" ref={scrollRef}>
        <div className="settings-grid">
          <section>
            <h2><Icon name="information-line" />站点信息</h2>
            <p className="hint">这些非敏感配置只保存到容器配置目录；环境变量仅在配置文件首次生成时读取。</p>
            <label>
              站点名
              <input
                value={settings.site.name}
                onChange={(event) => updateSite({ name: event.target.value })}
                placeholder="ImageShow"
              />
            </label>
            <label>
              站点域名
              <input
                value={settings.site.domain}
                onChange={(event) => updateSite({ domain: event.target.value })}
                placeholder="img.example.com"
              />
            </label>
            <label>
              站点 icon
              <input
                value={settings.site.icon_url}
                onChange={(event) => updateSite({ icon_url: event.target.value })}
                placeholder="/assets/brand/favicon.svg 或 https://..."
              />
            </label>
            <label>
              站点描述
              <input
                value={settings.site.home.tagline}
                onChange={(event) => updateSiteHome({ tagline: event.target.value })}
                placeholder="个人图片管理、画廊展示和随机图片 API。"
              />
            </label>
            <label>
              登录页背景图
              <input
                value={settings.admin.login_background}
                onChange={(event) => updateAdmin({ login_background: event.target.value })}
                placeholder="留空＝站点域名的随机图 API（/random?m=redirect）"
              />
            </label>
            <label>
              首页 hero 背景图
              <input
                value={settings.site.home.hero_background}
                onChange={(event) => updateSiteHome({ hero_background: event.target.value })}
                placeholder="留空＝站点域名的随机图 API（/random?m=redirect）"
              />
            </label>
          </section>
          <section>
            <h2><Icon name="settings-3-line" />页面行为</h2>
            <div className="settings-toggle-grid">
              <label>
                <input
                  type="checkbox"
                  checked={settings.site.home.enabled}
                  onChange={(event) => updateHomeEnabled(event.target.checked)}
                />
                启用主页
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.site.docs_enabled}
                  onChange={(event) => updateSite({ docs_enabled: event.target.checked })}
                />
                启用 docs 站
              </label>
            </div>
            <label>
              根路径页面
              <SelectMenu
                value={settings.site.home.enabled ? settings.site.root_redirect : "gallery"}
                onChange={(value) => updateSite({ root_redirect: value as SiteSettings["root_redirect"] })}
                options={[{ value: "home", label: "首页 /home" }, { value: "gallery", label: "画廊 /gallery" }]}
                ariaLabel="根路径页面"
                disabled={!settings.site.home.enabled}
              />
            </label>
            <label>
              首页预览切换间隔 ms
              <NumberInput
                min={0}
                max={10000}
                value={settings.site.home.preview_delay_ms}
                onChange={(value) => updateSiteHome({ preview_delay_ms: value })}
              />
            </label>
            <label>
              画廊每次加载数量
              <NumberInput
                min={1}
                max={200}
                value={settings.site.gallery.default_limit}
                onChange={(value) => updateSiteGallery({ default_limit: value })}
              />
            </label>
            <label>
              画廊排序
              <SelectMenu
                value={settings.site.gallery.order}
                onChange={(value) => updateSiteGallery({ order: value as AdminSettings["site"]["gallery"]["order"] })}
                options={galleryOrderSelectOptions}
                ariaLabel="画廊排序"
              />
            </label>
            <label>
              总览最近上传展示数量
              <NumberInput
                min={1}
                max={50}
                value={settings.admin.recent_uploads}
                onChange={(value) => updateAdmin({ recent_uploads: value })}
              />
            </label>
            <label>
              随机图默认模式
              <SelectMenu
                value={settings.site.random_default_method}
                onChange={(value) => updateSite({ random_default_method: value as "proxy" | "redirect" })}
                options={[{ value: "proxy", label: "代理返回" }, { value: "redirect", label: "302 跳转" }]}
                ariaLabel="随机图默认模式"
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.admin.show_unset_theme_card}
                onChange={(event) => updateAdmin({ show_unset_theme_card: event.target.checked })}
              />
              主题管理显示「未设置」卡片
            </label>
          </section>
          <section className="settings-card-wide">
            <h2><Icon name="image-line" />图片设置</h2>
            <p className="hint">这些配置影响新上传、链接下载、缩略图生成和图片管理列表；已存在图片不会自动重新处理。</p>
            <div className="settings-field-grid">
              <label>
                上传与批量编辑每页数量
                <NumberInput
                  min={1}
                  max={100}
                  value={settings.upload.list_page_size}
                  onChange={(value) => updateUpload({ list_page_size: value })}
                />
              </label>
              <label>
                图片管理每页数量
                <NumberInput
                  min={10}
                  max={200}
                  value={settings.admin.image_page_size}
                  onChange={(value) => updateAdmin({ image_page_size: value })}
                />
              </label>
              <label>
                单客户端上传并发数
                <NumberInput
                  min={1}
                  max={128}
                  value={settings.upload.concurrency}
                  onChange={(value) => updateUpload({ concurrency: value })}
                />
              </label>
              <label>
                单客户端链接导入并发数
                <NumberInput
                  min={1}
                  max={128}
                  value={settings.link_image.concurrency}
                  onChange={(value) => updateLinkImage({ concurrency: value })}
                />
              </label>
              <label>
                入库转码初始质量
                <NumberInput
                  min={1}
                  max={100}
                  value={settings.normalize.quality}
                  onChange={(value) => updateNormalize({ quality: value })}
                />
              </label>
              <label>
                质量递减步长
                <NumberInput
                  min={1}
                  max={50}
                  value={settings.normalize.quality_step}
                  onChange={(value) => updateNormalize({ quality_step: value })}
                />
              </label>
              <label>
                最低压缩质量
                <NumberInput
                  min={1}
                  max={100}
                  value={settings.normalize.min_quality}
                  onChange={(value) => updateNormalize({ min_quality: value })}
                />
              </label>
              <label>
                跳过转码阈值 KB
                <NumberInput
                  min={0}
                  max={102400}
                  value={settings.normalize.skip_webp_under_kb}
                  onChange={(value) => updateNormalize({ skip_webp_under_kb: value })}
                />
              </label>
              <label>
                入库长边上限 px
                <NumberInput
                  min={512}
                  max={32768}
                  value={settings.normalize.max_long_edge}
                  onChange={(value) => updateNormalize({ max_long_edge: value })}
                />
              </label>
              <label>
                入库目标体积 KB
                <NumberInput
                  min={50}
                  max={102400}
                  value={settings.normalize.max_size_kb}
                  onChange={(value) => updateNormalize({ max_size_kb: value })}
                />
              </label>
              <label>
                缩略图长边 px
                <NumberInput
                  min={64}
                  max={4096}
                  value={settings.thumbnail.long_edge}
                  onChange={(value) => updateThumbnail({ long_edge: value })}
                />
              </label>
              <label>
                缩略图压缩质量
                <NumberInput
                  min={1}
                  max={100}
                  value={settings.thumbnail.quality}
                  onChange={(value) => updateThumbnail({ quality: value })}
                />
              </label>
            </div>
            <div className="settings-toggle-grid">
              <label>
                <input
                  type="checkbox"
                  checked={settings.image_detail.title_opens_image}
                  onChange={(event) => setSettings({ ...settings, image_detail: { title_opens_image: event.target.checked } })}
                />
                图片详情标题点击打开图片直链
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={settings.link_image.fill_original_url}
                  onChange={(event) => updateLinkImage({ fill_original_url: event.target.checked })}
                />
                链接导入自动填入原图 URL
              </label>
            </div>
          </section>
        </div>
      </div>
      <OverlayScrollbar targetRef={scrollRef} pageEdge />
      {feedback && (
        <ActionFeedback feedback={feedback} placement="floating" onClose={() => setFeedback(null)} />
      )}
    </section>
  );
}
