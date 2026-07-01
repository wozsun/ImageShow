import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { Icon } from "../../components/Icon.js";
import { NumberInput } from "../../components/NumberInput.js";
import { SelectMenu } from "../../components/SelectMenu.js";
import { StableLabel } from "../../components/StableLabel.js";
import { adminApiBasePath, defaultSite, queryKeys } from "../../lib/constants.js";
import { galleryOrderSelectOptions } from "../../lib/select-options.js";
import { errorMessage } from "../../lib/formatters.js";
import type { AdminSettings, SiteSettings } from "../../lib/types.js";

// The inline status line shown after a settings mutation. Shared by the site-config form here
// and the storage-management page (StorageSettings / its edit modal import this).
export type SettingsFeedbackState = {
  scope: "storage" | "application";
  text: string;
  status: "pending" | "success" | "error";
};

// 站点配置：站点信息 + 应用参数（file-backed runtime config）。存储后端管理是独立页（StorageSettings）。
export function SettingsPage() {
  const query = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: () => api(`${adminApiBasePath}/settings`) });
  const client = useQueryClient();
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [feedback, setFeedback] = useState<SettingsFeedbackState | null>(null);
  const [action, setAction] = useState<"" | "save-application" | "reload">("");
  useEffect(() => {
    if (query.data?.settings) {
      setSettings({
        ...query.data.settings,
        random: query.data.settings.random ?? { default_method: "proxy" },
        image_detail: query.data.settings.image_detail ?? { title_opens_image: true },
        site: { ...defaultSite, ...query.data.settings.site }
      });
    }
  }, [query.data]);
  if (!settings) {
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
    setFeedback({ scope: "application", text: "正在保存应用配置...", status: "pending" });
    try {
      await api(`${adminApiBasePath}/settings`, {
        method: "POST",
        body: JSON.stringify({ site: settings.site, home: settings.home, upload: settings.upload, admin: settings.admin, gallery: settings.gallery, random: settings.random, image_detail: settings.image_detail })
      });
      setFeedback({ scope: "application", text: "应用配置已保存", status: "success" });
      await query.refetch();
      // site-config 现为 staleTime:Infinity 的全局缓存，保存后必须显式失效，公共端（站点标题/图标、
      // 画廊顺序、登录背景等）才会刷新到最新值，而不必整页刷新。
      await client.invalidateQueries({ queryKey: queryKeys.siteConfig });
    } catch (error) {
      setFeedback({ scope: "application", text: `保存失败：${errorMessage(error)}`, status: "error" });
    } finally {
      setAction("");
    }
  };
  const reloadConfig = async () => {
    if (action) return;
    setAction("reload");
    setFeedback({ scope: "application", text: "正在读取配置文件...", status: "pending" });
    try {
      await api(`${adminApiBasePath}/settings/reload`, { method: "POST" });
      await query.refetch();
      await client.invalidateQueries({ queryKey: queryKeys.siteConfig });
      setFeedback({ scope: "application", text: "已读取并应用最新配置文件", status: "success" });
    } catch (error) {
      setFeedback({ scope: "application", text: `读取失败：${errorMessage(error)}`, status: "error" });
    } finally {
      setAction("");
    }
  };
  return (
    <section className="workspace">
      <header className="workspace-head">
        <div>
          <h1>站点配置</h1>
          <p>站点信息与应用参数</p>
        </div>
        <div className="settings-head-actions">
          {feedback?.scope === "application" && <SettingsFeedback feedback={feedback} inline />}
          <button
            type="button"
            className="settings-config-button"
            disabled={action === "reload"}
            onClick={reloadConfig}
          >
            <Icon name="refresh-line" />
            <StableLabel idle="读取配置文件" busyText="读取中" busy={action === "reload"} />
          </button>
          <button
            className="button settings-config-button"
            type="button"
            disabled={action === "save-application"}
            onClick={saveApplication}
          >
            <Icon name="save-3-line" />
            <StableLabel idle="保存应用配置" busyText="保存中" busy={action === "save-application"} />
          </button>
        </div>
      </header>
      <div className="settings-grid">
        <section>
          <h2><Icon name="information-line" />站点信息</h2>
          <p className="hint">这些非敏感配置只保存到容器配置目录；环境变量仅在配置文件首次生成时读取。</p>
          <label>
            站点名
            <input
              value={settings.site.name}
              onChange={(event) => setSettings({ ...settings, site: { ...settings.site, name: event.target.value } })}
              placeholder="ImageShow"
            />
          </label>
          <label>
            站点域名
            <input
              value={settings.site.domain}
              onChange={(event) => setSettings({ ...settings, site: { ...settings.site, domain: event.target.value } })}
              placeholder="img.example.com"
            />
          </label>
          <label>
            站点 icon
            <input
              value={settings.site.icon_url}
              onChange={(event) => setSettings({ ...settings, site: { ...settings.site, icon_url: event.target.value } })}
              placeholder="/assets/brand/favicon.svg 或 https://..."
            />
          </label>
          <label>
            根路径跳转
            <SelectMenu
              value={settings.site.root_redirect}
              onChange={(value) => setSettings({ ...settings, site: { ...settings.site, root_redirect: value as SiteSettings["root_redirect"] } })}
              options={[{ value: "home", label: "首页 /home" }, { value: "gallery", label: "画廊 /gallery" }]}
              ariaLabel="根路径跳转"
            />
          </label>
          <label>
            登录页背景图
            <input
              value={settings.site.login_background}
              onChange={(event) => setSettings({ ...settings, site: { ...settings.site, login_background: event.target.value } })}
              placeholder="留空＝站点域名的随机图 API（/random?m=redirect）"
            />
          </label>
          <label>
            首页 hero 背景图
            <input
              value={settings.site.home_hero_background}
              onChange={(event) => setSettings({ ...settings, site: { ...settings.site, home_hero_background: event.target.value } })}
              placeholder="留空＝站点域名的随机图 API（/random?m=redirect）"
            />
          </label>
        </section>
        <section>
          <h2><Icon name="settings-3-line" />应用参数</h2>
          <label>
            首页预览切换间隔 ms
            <NumberInput
              min={0}
              max={30000}
              step={100}
              value={settings.home.preview_delay_ms}
              onChange={(value) => setSettings({ ...settings, home: { ...settings.home, preview_delay_ms: value } })}
            />
          </label>
          <label>
            单文件大小限制 MB
            <NumberInput
              min={1}
              max={200}
              step={1}
              value={settings.upload.max_file_size_mb}
              onChange={(value) => setSettings({ ...settings, upload: { ...settings.upload, max_file_size_mb: value } })}
            />
          </label>
          <label>
            图片长边限制 px
            <NumberInput
              min={512}
              max={32768}
              step={128}
              value={settings.upload.max_long_edge}
              onChange={(value) => setSettings({ ...settings, upload: { ...settings.upload, max_long_edge: value } })}
            />
          </label>
          <label>
            上传与批量编辑每页数量
            <NumberInput
              min={5}
              max={100}
              value={settings.upload.list_page_size}
              onChange={(value) => setSettings({ ...settings, upload: { ...settings.upload, list_page_size: value } })}
            />
          </label>
          <label>
            上传 / 缩略图并发数
            <NumberInput
              min={1}
              max={16}
              value={settings.upload.concurrency}
              onChange={(value) => setSettings({ ...settings, upload: { ...settings.upload, concurrency: value } })}
            />
          </label>
          <label>
            画廊每次加载数量
            <NumberInput
              min={1}
              max={200}
              value={settings.gallery.default_limit}
              onChange={(value) => setSettings({ ...settings, gallery: { ...settings.gallery, default_limit: value } })}
            />
          </label>
          <label>
            画廊排序
            <SelectMenu
              value={settings.gallery.order}
              onChange={(value) => setSettings({ ...settings, gallery: { ...settings.gallery, order: value as AdminSettings["gallery"]["order"] } })}
              options={galleryOrderSelectOptions}
              ariaLabel="画廊排序"
            />
          </label>
          <label>
            图片管理每页数量
            <NumberInput
              min={10}
              max={200}
              value={settings.admin.image_page_size}
              onChange={(value) => setSettings({ ...settings, admin: { ...settings.admin, image_page_size: value } })}
            />
          </label>
          <label>
            总览最近上传展示数量
            <NumberInput
              min={1}
              max={50}
              value={settings.admin.recent_uploads}
              onChange={(value) => setSettings({ ...settings, admin: { ...settings.admin, recent_uploads: value } })}
            />
          </label>
          <label>
            随机图默认模式
            <SelectMenu
              value={settings.random.default_method}
              onChange={(value) => setSettings({ ...settings, random: { default_method: value as "proxy" | "redirect" } })}
              options={[{ value: "proxy", label: "代理返回" }, { value: "redirect", label: "302 跳转" }]}
              ariaLabel="随机图默认模式"
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.admin.show_unset_theme_card}
              onChange={(event) => setSettings({ ...settings, admin: { ...settings.admin, show_unset_theme_card: event.target.checked } })}
            />
            主题管理显示「未设置」卡片
          </label>
          <label>
            <input
              type="checkbox"
              checked={settings.image_detail.title_opens_image}
              onChange={(event) => setSettings({ ...settings, image_detail: { title_opens_image: event.target.checked } })}
            />
            图片详情标题点击打开原图
          </label>
        </section>
      </div>
    </section>
  );
}

// The shared status card (pending/success/error) used in page headers and below them — the
// "保存应用配置" feedback, the storage actions, and the image batch-operation notices. A JSON body
// (the storage connection-test result) renders as a <pre>; everything else as plain text. Takes
// only { text, status } so any page can reuse it (SettingsFeedbackState satisfies that shape).
export function SettingsFeedback({ feedback, inline = false }: {
  feedback: { text: string; status: "pending" | "success" | "error" };
  inline?: boolean;
}) {
  return (
    <div className={`settings-feedback${inline ? " is-inline" : ""} ${feedback.status === "success" ? "ok" : feedback.status === "error" ? "error" : ""}`}>
      {feedback.text.trim().startsWith("{") ? <pre>{feedback.text}</pre> : <span>{feedback.text}</span>}
    </div>
  );
}
