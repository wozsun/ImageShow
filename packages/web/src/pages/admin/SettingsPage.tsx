import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  randomDefaultMethods,
  siteRoots,
  type AdminSettingsResponseDto,
  type RandomDefaultMethod,
  type SiteRoot
} from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import { AdminIcon } from "../../components/icon/AdminIcon.js";
import { AsyncActionButton } from "../../components/actions/AsyncActionButton.js";
import { NumberInput } from "../../components/form/NumberInput.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { AdminSettingsBoundary } from "../../components/feedback/AdminSettingsBoundary.js";
import { galleryOrderSelectOptions } from "../../lib/ui/select-options.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import type { AdminSettings } from "../../lib/types.js";
import { WorkspaceHeader } from "../../components/layout/WorkspaceHeader.js";
import "../../styles/admin/settings.css";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import { invalidateRuntimeData } from "../../lib/api/query-invalidation.js";
import { queryKeys } from "../../lib/api/query-keys.js";

const reloadConfigPresentation = {
  idle: { icon: "refresh-line", label: "读取配置文件" },
  pending: { icon: "refresh-line", label: "读取中" },
  success: { icon: "check-line", label: "读取配置成功" },
  error: { icon: "close-line", label: "读取配置失败" }
} as const;

const saveSettingsPresentation = {
  idle: { icon: "save-3-line", label: "保存应用配置" },
  pending: { icon: "save-3-line", label: "保存中" },
  success: { icon: "check-line", label: "保存配置成功" },
  error: { icon: "close-line", label: "保存配置失败" }
} as const;

const siteRootLabels: Record<SiteRoot, string> = {
  home: "首页 /home",
  show: "展映 /show",
  gallery: "画廊 /gallery"
};
const siteRootOptions = siteRoots.map((value) => ({
  value,
  label: siteRootLabels[value]
}));

const randomMethodLabels: Record<RandomDefaultMethod, string> = {
  proxy: "代理返回",
  redirect: "302 跳转"
};
const randomMethodOptions = randomDefaultMethods.map((value) => ({
  value,
  label: randomMethodLabels[value]
}));

export function SettingsPage() {
  return (
    <AdminSettingsBoundary>
      {(settings) => <SettingsPageContent serverSettings={settings} />}
    </AdminSettingsBoundary>
  );
}

function SettingsPageContent({ serverSettings }: { serverSettings: AdminSettings }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<AdminSettings | null>(null);
  const settings = draft ?? serverSettings;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [actionError, setActionError] = useState("");
  const actionRef = useRef<AbortController | null>(null);
  const reloadConfigStatus = useAsyncActionStatus();
  const saveSettingsStatus = useAsyncActionStatus();
  const scrollRef = useRef<HTMLDivElement>(null);
  const busy = reloadConfigStatus.pending || saveSettingsStatus.pending;
  useEffect(() => () => actionRef.current?.abort(), []);
  const runSettingsAction = async (reload: boolean) => {
    if (busy || actionRef.current) return;
    // NumberInput publishes its edit on blur. Settle it before freezing the
    // request, including activations that do not move browser focus first.
    flushSync(() => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && scrollRef.current?.contains(focused)) focused.blur();
    });
    const submitted = settingsRef.current;
    const controller = new AbortController();
    actionRef.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    setActionError("");
    const status = reload ? reloadConfigStatus : saveSettingsStatus;
    await status.run(async () => {
      try {
        const response = await api<AdminSettingsResponseDto>(
          `${adminApiBasePath}/settings${reload ? "/reload" : ""}`, {
          method: "POST",
          signal,
          body: reload ? undefined : JSON.stringify({
            site: submitted.site,
            ingestion: {
              list_page_size: submitted.ingestion.list_page_size,
              commit_concurrency: submitted.ingestion.commit_concurrency
            },
            upload: {
              browser_concurrency: submitted.upload.browser_concurrency
            },
            normalize: submitted.normalize,
            thumbnail: submitted.thumbnail,
            admin: submitted.admin
          })
        });
        signal.throwIfAborted();
        await client.cancelQueries({ queryKey: queryKeys.settings, exact: true });
        signal.throwIfAborted();
        // The mutation response is the normalized settings snapshot. Refresh
        // other projections without holding the form lock on their requests.
        void invalidateRuntimeData(client, response).catch((error) => {
          reportAdminUiError("settings.refresh", error);
        });
        setDraft(null);
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        if (signal.aborted) {
          setActionError("请求超时，草稿已保留。可重试保存或读取配置文件确认结果。");
        }
        reportAdminUiError(reload ? "settings.reload" : "settings.save", error);
        return false;
      } finally {
        if (actionRef.current === controller) actionRef.current = null;
      }
    });
  };
  const setSettings = (next: AdminSettings) => {
    if (!busy && !actionRef.current) {
      setDraft(JSON.stringify(next) === JSON.stringify(serverSettings) ? null : next);
    }
  };
  const updateSite = (patch: Partial<AdminSettings["site"]>) => setSettings({ ...settings, site: { ...settings.site, ...patch } });
  const updateSiteHome = (patch: Partial<AdminSettings["site"]["home"]>) => updateSite({ home: { ...settings.site.home, ...patch } });
  const updateSiteGallery = (patch: Partial<AdminSettings["site"]["gallery"]>) => updateSite({ gallery: { ...settings.site.gallery, ...patch } });
  const updateIngestion = (patch: Partial<AdminSettings["ingestion"]>) => setSettings({ ...settings, ingestion: { ...settings.ingestion, ...patch } });
  const updateUpload = (patch: Partial<AdminSettings["upload"]>) => setSettings({ ...settings, upload: { ...settings.upload, ...patch } });
  const updateNormalize = (patch: Partial<AdminSettings["normalize"]>) => setSettings({ ...settings, normalize: { ...settings.normalize, ...patch } });
  const updateThumbnail = (patch: Partial<AdminSettings["thumbnail"]>) => setSettings({ ...settings, thumbnail: { ...settings.thumbnail, ...patch } });
  const updateAdmin = (patch: Partial<AdminSettings["admin"]>) => setSettings({ ...settings, admin: { ...settings.admin, ...patch } });
  return (
    <section className="workspace workspace-contained settings-page">
      <WorkspaceHeader
        title="站点配置"
        description="站点信息与应用参数"
        actionsClassName="settings-head-actions"
        actions={
          <>
            <AsyncActionButton
              type="button"
              className="settings-config-button"
              status={reloadConfigStatus.status}
              presentation={reloadConfigPresentation}
              disabled={busy}
              title="读取成功后替换当前未保存的修改"
              onClick={() => void runSettingsAction(true)}
            />
            <AsyncActionButton
              className="button settings-config-button"
              type="button"
              status={saveSettingsStatus.status}
              presentation={saveSettingsPresentation}
              disabled={busy}
              onClick={() => void runSettingsAction(false)}
            />
          </>
        }
      />
      {actionError && <p className="hint" role="alert">{actionError}</p>}
      <div className="settings-scroll-region" ref={scrollRef}>
        <fieldset className="settings-grid" disabled={busy} aria-busy={busy}>
          <section>
            <h2><AdminIcon name="information-line" />站点信息</h2>
            <p className="hint">这些非敏感配置只保存到容器配置目录；环境变量仅在配置文件首次生成时读取。</p>
            <label>
              站点名
              <input
                value={settings.site.name}
                onChange={(event) => updateSite({ name: event.target.value })}
                placeholder="站点名称"
              />
            </label>
            <label>
              首页 Banner 上方标识
              <input
                value={settings.site.home.banner_label}
                onChange={(event) => updateSiteHome({ banner_label: event.target.value })}
                placeholder="首页上方标识"
              />
            </label>
            <label>
              首页 Banner 标题
              <textarea
                rows={2}
                maxLength={80}
                value={settings.site.home.banner_title}
                onChange={(event) => updateSiteHome({ banner_title: event.target.value })}
                placeholder="首页标题，可换行"
              />
            </label>
            <label>
              首页背景图
              <input
                value={settings.site.home.background}
                onChange={(event) => updateSiteHome({ background: event.target.value })}
                placeholder="留空＝站点随机图 API（/random?mode=redirect）"
              />
            </label>
            <label>
              登录页背景图
              <input
                value={settings.admin.login_background}
                onChange={(event) => updateAdmin({ login_background: event.target.value })}
                placeholder="留空＝站点域名的随机图 API（/random?mode=redirect）"
              />
            </label>
          </section>
          <section>
            <h2><AdminIcon name="settings-3-line" />页面行为</h2>
            <label>
              根路径页面
              <SelectMenu
                disabled={busy}
                value={settings.site.root}
                onChange={(value) => updateSite({ root: value as SiteRoot })}
                options={siteRootOptions}
                ariaLabel="根路径页面"
              />
            </label>
            <label>
              画廊每次加载数量
              <NumberInput
                min={1}
                max={200}
                value={settings.site.gallery.limit}
                onChange={(value) => updateSiteGallery({ limit: value })}
              />
            </label>
            <label>
              画廊排序
              <SelectMenu
                disabled={busy}
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
                max={60}
                value={settings.admin.recent_uploads}
                onChange={(value) => updateAdmin({ recent_uploads: value })}
              />
            </label>
            <label>
              随机图默认模式
              <SelectMenu
                value={settings.site.random_method}
                disabled={busy}
                onChange={(value) => updateSite({
                  random_method: value as RandomDefaultMethod
                })}
                options={randomMethodOptions}
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
            <h2><AdminIcon name="image-line" />图片设置</h2>
            <p className="hint">这些配置影响新上传、链接下载、缩略图生成和图片管理列表；已存在图片不会自动重新处理。</p>
            <div className="settings-field-grid">
              <label>
                接入队列与批量编辑每页数量
                <NumberInput
                  min={1}
                  max={100}
                  value={settings.ingestion.list_page_size}
                  onChange={(value) => updateIngestion({ list_page_size: value })}
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
                单页面上传并发数
                <NumberInput
                  min={1}
                  max={8}
                  value={settings.upload.browser_concurrency}
                  onChange={(value) => updateUpload({ browser_concurrency: value })}
                />
              </label>
              <label>
                服务器图片处理并发数
                <NumberInput
                  min={1}
                  max={8}
                  value={settings.normalize.concurrency}
                  onChange={(value) => updateNormalize({ concurrency: value })}
                />
              </label>
              <label>
                服务器最终入库并发数
                <NumberInput
                  min={1}
                  max={16}
                  value={settings.ingestion.commit_concurrency}
                  onChange={(value) => updateIngestion({ commit_concurrency: value })}
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
                  min={300}
                  max={32000}
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
          </section>
        </fieldset>
      </div>
      <OverlayScrollbar targetRef={scrollRef} pageEdge />
    </section>
  );
}
