import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { Icon } from "../../components/Icon.js";
import { SelectMenu } from "../../components/SelectMenu.js";
import { adminApiBasePath, defaultSite, queryKeys } from "../../lib/constants.js";
import { storageBackendLabel, storageBackendSelectOptions } from "../../lib/select-options.js";
import type { AdminSettings, SiteSettings, StorageBackend, StorageSettings } from "../../lib/types.js";

type SettingsFeedbackState = {
  scope: "storage" | "application";
  text: string;
  status: "pending" | "success" | "error";
};

export function SettingsPage() {
  const query = useQuery<{ settings: AdminSettings }>({ queryKey: queryKeys.settings, queryFn: () => api(`${adminApiBasePath}/settings`) });
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [feedback, setFeedback] = useState<SettingsFeedbackState | null>(null);
  const [action, setAction] = useState<"" | "test" | "save-storage" | "set-default" | "save-application" | "reload">("");
  const [viewProvider, setViewProvider] = useState<StorageBackend>("local");
  useEffect(() => {
    if (query.data?.settings) {
      setSettings({
        ...query.data.settings,
        random: query.data.settings.random ?? { default_method: "proxy" },
        site: { ...defaultSite, ...query.data.settings.site },
        storage: {
          ...query.data.settings.storage,
          s3: { ...query.data.settings.storage.s3, secret_access_key: "" }
        }
      });
      setViewProvider(query.data.settings.storage.backend);
    }
  }, [query.data]);
  if (!settings) return <section className="workspace"><h1>设置</h1><p className="muted">加载中</p></section>;
  const patchStorage = (patch: Partial<StorageSettings>) => setSettings({ ...settings, storage: { ...settings.storage, ...patch } });
  const patchS3 = (patch: Partial<StorageSettings["s3"]>) => patchStorage({ s3: { ...settings.storage.s3, ...patch } });
  const s3Ready = Boolean(settings.storage.s3.endpoint && settings.storage.s3.bucket && settings.storage.s3.access_key_id && (settings.storage.s3.secret_access_key || settings.storage.s3.secret_access_key_configured));
  const s3Enabled = () => ({ ...settings.storage.s3, enabled: Boolean(settings.storage.s3.endpoint && settings.storage.s3.bucket) });
  const testStorage = async (backend: StorageBackend) => {
    if (action) return;
    setAction("test");
    setFeedback({ scope: "storage", text: "正在测试存储连接...", status: "pending" });
    try {
      const storage = { ...settings.storage, backend, s3: { ...settings.storage.s3, enabled: backend === "s3" } };
      const data = await api(`${adminApiBasePath}/storage/test`, { method: "POST", body: JSON.stringify({ storage }) });
      setFeedback({ scope: "storage", text: JSON.stringify(data, null, 2), status: "success" });
    } catch (error) {
      setFeedback({ scope: "storage", text: `连接测试失败：${error instanceof Error ? error.message : String(error)}`, status: "error" });
    } finally {
      setAction("");
    }
  };
  const saveStorage = async () => {
    if (action) return;
    setAction("save-storage");
    setFeedback({ scope: "storage", text: "正在保存存储配置...", status: "pending" });
    try {
      const storage = { ...settings.storage, s3: s3Enabled() };
      await api(`${adminApiBasePath}/settings`, { method: "POST", body: JSON.stringify({ storage }) });
      setSettings({ ...settings, storage });
      setFeedback({ scope: "storage", text: "S3 配置已保存（可在图片处迁移到此后端）", status: "success" });
      await query.refetch();
    } catch (error) {
      setFeedback({ scope: "storage", text: `保存失败：${error instanceof Error ? error.message : String(error)}`, status: "error" });
    } finally {
      setAction("");
    }
  };
  const setDefaultBackend = async (backend: StorageBackend) => {
    if (action) return;
    setAction("set-default");
    setFeedback({ scope: "storage", text: "正在保存默认上传位置...", status: "pending" });
    try {
      const storage = { ...settings.storage, backend, s3: { ...s3Enabled(), enabled: backend === "s3" || Boolean(settings.storage.s3.endpoint && settings.storage.s3.bucket) } };
      await api(`${adminApiBasePath}/settings`, { method: "POST", body: JSON.stringify({ storage }) });
      setSettings({ ...settings, storage });
      setFeedback({ scope: "storage", text: `默认上传位置已设为${storageBackendLabel(backend)}`, status: "success" });
      await query.refetch();
    } catch (error) {
      setFeedback({ scope: "storage", text: `保存失败：${error instanceof Error ? error.message : String(error)}`, status: "error" });
    } finally {
      setAction("");
    }
  };
  const saveApplication = async () => {
    if (action) return;
    setAction("save-application");
    setFeedback({ scope: "application", text: "正在保存应用配置...", status: "pending" });
    try {
      await api(`${adminApiBasePath}/settings`, {
        method: "POST",
        body: JSON.stringify({ site: settings.site, home: settings.home, upload: settings.upload, admin: settings.admin, gallery: settings.gallery, random: settings.random })
      });
      setFeedback({ scope: "application", text: "应用配置已保存", status: "success" });
      await query.refetch();
    } catch (error) {
      setFeedback({ scope: "application", text: `保存失败：${error instanceof Error ? error.message : String(error)}`, status: "error" });
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
      setFeedback({ scope: "application", text: "已读取并应用最新配置文件", status: "success" });
    } catch (error) {
      setFeedback({ scope: "application", text: `读取失败：${error instanceof Error ? error.message : String(error)}`, status: "error" });
    } finally {
      setAction("");
    }
  };
  return (
    <section className="workspace">
      <header className="workspace-head">
        <div><h1>设置</h1><p>存储与应用配置</p></div>
      </header>
      <div className="settings-grid">
        <section>
          <h2><Icon name="hard-drive-2-line" />存储</h2>
          <p className="hint">每张图片记录自己所在的存储后端，本地与 S3 可并存。选择要查看 / 配置的存储后端，并可将其设为新上传的默认位置。</p>
          <div className="storage-provider-row">
            <label>存储后端<SelectMenu className="is-storage-select" value={viewProvider} onChange={(value) => setViewProvider(value as StorageBackend)} options={storageBackendSelectOptions} ariaLabel="存储后端" /></label>
            <button type="button" disabled={action === "set-default" || settings.storage.backend === viewProvider || (viewProvider === "s3" && !s3Ready)} onClick={() => setDefaultBackend(viewProvider)}>{action === "set-default" ? "保存中" : settings.storage.backend === viewProvider ? "已是默认上传位置" : "设为默认上传位置"}</button>
          </div>
          <p className="storage-default-note">当前默认上传位置 <strong>{storageBackendLabel(settings.storage.backend)}</strong></p>
          {viewProvider === "local" ? (
            <>
              <p className="hint">本地存储无需额外配置，图片保存在容器的存储目录。</p>
              <div className="settings-card-actions">
                <button className="storage-test-button" type="button" disabled={action === "test"} onClick={() => testStorage("local")}><Icon name="flask-line" />{action === "test" ? "测试中" : "本地存储测试"}</button>
              </div>
            </>
          ) : (
            <>
              <p className="hint">Secret Key 保存后只显示已配置；S3 上传固定使用后端签发的浏览器直传 PUT URL。</p>
              <label>Endpoint<input value={settings.storage.s3.endpoint} onChange={(event) => patchS3({ endpoint: event.target.value })} /></label>
              <label>Region<input value={settings.storage.s3.region} onChange={(event) => patchS3({ region: event.target.value })} /></label>
              <label>Bucket<input value={settings.storage.s3.bucket} onChange={(event) => patchS3({ bucket: event.target.value })} /></label>
              <label>Access Key<input value={settings.storage.s3.access_key_id} onChange={(event) => patchS3({ access_key_id: event.target.value })} /></label>
              <label>Secret Key<input type="password" placeholder={settings.storage.s3.secret_access_key_configured ? "已配置" : ""} value={settings.storage.s3.secret_access_key ?? ""} onChange={(event) => patchS3({ secret_access_key: event.target.value })} /></label>
              <label>根目录<input value={settings.storage.s3.root_path} onChange={(event) => patchS3({ root_path: event.target.value })} placeholder="/ 或 /imageshow" /></label>
              <label>Public Base URL<input value={settings.storage.s3.public_base_url} onChange={(event) => patchS3({ public_base_url: event.target.value })} /></label>
              <label><input type="checkbox" checked={settings.storage.s3.force_path_style} onChange={(event) => patchS3({ force_path_style: event.target.checked })} />Path-style</label>
              <div className="settings-card-actions">
                <button className="button" type="button" disabled={action === "save-storage"} onClick={saveStorage}><Icon name="save-3-line" />{action === "save-storage" ? "保存中" : "保存 S3 配置"}</button>
                <button className="storage-test-button" type="button" disabled={action === "test"} onClick={() => testStorage("s3")}><Icon name="flask-line" />{action === "test" ? "测试中" : "S3 连接测试"}</button>
              </div>
            </>
          )}
          {feedback?.scope === "storage" && <SettingsFeedback feedback={feedback} />}
        </section>
        <section>
          <h2><Icon name="database-2-line" />应用</h2>
          <p className="hint">这些非敏感配置只保存到容器配置目录；环境变量仅在配置文件首次生成时读取。</p>
          <label>站点名<input value={settings.site.name} onChange={(event) => setSettings({ ...settings, site: { ...settings.site, name: event.target.value } })} placeholder="ImageShow" /></label>
          <label>站点域名<input value={settings.site.domain} onChange={(event) => setSettings({ ...settings, site: { ...settings.site, domain: event.target.value } })} placeholder="img.example.com" /></label>
          <label>站点 icon<input value={settings.site.icon_url} onChange={(event) => setSettings({ ...settings, site: { ...settings.site, icon_url: event.target.value } })} placeholder="/assets/brand/favicon.svg 或 https://..." /></label>
          <label>根路径跳转<SelectMenu value={settings.site.root_redirect} onChange={(value) => setSettings({ ...settings, site: { ...settings.site, root_redirect: value as SiteSettings["root_redirect"] } })} options={[{ value: "home", label: "首页 /home" }, { value: "gallery", label: "画廊 /gallery" }]} ariaLabel="根路径跳转" /></label>
          <label>单文件大小限制 MB<input type="number" min={1} max={200} step={1} value={settings.upload.max_file_size_mb} onChange={(event) => setSettings({ ...settings, upload: { ...settings.upload, max_file_size_mb: Number(event.target.value) } })} /></label>
          <label>图片长边限制 px<input type="number" min={512} max={32768} step={128} value={settings.upload.max_long_edge} onChange={(event) => setSettings({ ...settings, upload: { ...settings.upload, max_long_edge: Number(event.target.value) } })} /></label>
          <label>上传与批量编辑每页数量<input type="number" min={5} max={100} value={settings.upload.list_page_size} onChange={(event) => setSettings({ ...settings, upload: { ...settings.upload, list_page_size: Number(event.target.value) } })} /></label>
          <label>画廊每次加载数量<input type="number" min={1} max={200} value={settings.gallery.default_limit} onChange={(event) => setSettings({ ...settings, gallery: { default_limit: Number(event.target.value) } })} /></label>
          <label>图片管理每页数量<input type="number" min={10} max={200} value={settings.admin.image_page_size} onChange={(event) => setSettings({ ...settings, admin: { image_page_size: Number(event.target.value) } })} /></label>
          <label>随机图默认模式<SelectMenu value={settings.random.default_method} onChange={(value) => setSettings({ ...settings, random: { default_method: value as "proxy" | "redirect" } })} options={[{ value: "proxy", label: "代理返回" }, { value: "redirect", label: "302 跳转" }]} ariaLabel="随机图默认模式" /></label>
          <div className="settings-card-actions">
            <button className="button" type="button" disabled={action === "save-application"} onClick={saveApplication}><Icon name="save-3-line" />{action === "save-application" ? "保存中" : "保存应用配置"}</button>
            <button type="button" disabled={action === "reload"} onClick={reloadConfig}><Icon name="refresh-line" />{action === "reload" ? "读取中" : "读取配置文件"}</button>
          </div>
          {feedback?.scope === "application" && <SettingsFeedback feedback={feedback} />}
        </section>
      </div>
    </section>
  );
}

function SettingsFeedback({ feedback }: { feedback: SettingsFeedbackState }) {
  return (
    <div className={`settings-feedback ${feedback.status === "success" ? "ok" : feedback.status === "error" ? "error" : ""}`}>
      {feedback.text.trim().startsWith("{") ? <pre>{feedback.text}</pre> : <span>{feedback.text}</span>}
    </div>
  );
}
