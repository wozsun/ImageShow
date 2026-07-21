import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api/client.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import type { AdvancedConfigPreview } from "../../lib/types.js";
import { Icon } from "../../components/icon/Icon.js";
import { AsyncActionButton } from "../../components/actions/AsyncActionButton.js";
import { ConfirmDialog } from "../../components/feedback/ConfirmDialog.js";
import { ConfigPackageImportDialog } from "./advanced-config/ConfigPackageImportDialog.js";
import { RuntimeConfigEditor } from "./advanced-config/RuntimeConfigEditor.js";
import { invalidateRuntimeData } from "../../lib/api/query-invalidation.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";

const maxPackageBytes = 1024 * 1024;
const packageFileReadOverheadBytes = 64 * 1024;

const previewPackagePresentation = {
  idle: { icon: "upload-cloud-2-line", label: "导入配置包" },
  pending: { icon: "upload-cloud-2-line", label: "正在校验" },
  success: { icon: "check-line", label: "校验通过" },
  error: { icon: "close-line", label: "配置包无效" }
} as const;

export function AdvancedConfigPage() {
  const client = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<unknown | null>(null);
  const [preview, setPreview] = useState<AdvancedConfigPreview | null>(null);
  const [busy, setBusy] = useState<"" | "export" | "preview" | "import">("");
  const [exportConfirmation, setExportConfirmation] = useState(false);
  const [runtimeConfigReloadToken, setRuntimeConfigReloadToken] = useState(0);
  const previewPackageStatus = useAsyncActionStatus({ successDurationMs: null });

  const clearImport = () => {
    setSelectedPackage(null);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const downloadPackage = async (): Promise<boolean> => {
    setBusy("export");
    try {
      const response = await fetch(`${adminApiBasePath}/advanced-config/export`, {
        credentials: "same-origin"
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filename = /filename="?([^";]+)"?/i.exec(disposition)?.[1] ?? "imageshow-config.json";
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      return true;
    } catch (error) {
      reportAdminUiError("advanced_config.package_export", error);
      return false;
    } finally {
      setBusy("");
    }
  };

  const selectPackage = async (file?: File) => {
    if (!file || busy) return;
    clearImport();
    await previewPackageStatus.run(async () => {
      setBusy("preview");
      try {
        if (file.size > maxPackageBytes + packageFileReadOverheadBytes) {
          throw new Error("配置包文件过大");
        }
        const parsed = JSON.parse(await file.text()) as unknown;
        const response = await api<{ preview: AdvancedConfigPreview }>(
          `${adminApiBasePath}/advanced-config/preview`,
          { method: "POST", body: JSON.stringify({ package: parsed }) }
        );
        setSelectedPackage(parsed);
        setPreview(response.preview);
        return true;
      } catch (error) {
        reportAdminUiError("advanced_config.package_preview", error);
        return false;
      } finally {
        setBusy("");
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    });
  };

  const applyPackage = async (slugMappings: Record<string, string>) => {
    if (!selectedPackage || busy) return false;
    setBusy("import");
    try {
      await api<{ result: { imported_backends: string[] } }>(
        `${adminApiBasePath}/advanced-config/import`,
        {
          method: "POST",
          body: JSON.stringify({ package: selectedPackage, slug_mappings: slugMappings })
        }
      );
      await invalidateRuntimeData(client);
      setRuntimeConfigReloadToken((current) => current + 1);
      return true;
    } catch (error) {
      reportAdminUiError("advanced_config.package_import", error);
      return false;
    } finally {
      setBusy("");
    }
  };

  return (
    <section className="workspace advanced-config-page">
      <header className="workspace-head">
        <div>
          <h1>高级配置</h1>
          <p className="muted">编辑当前实例完整配置，或通过版本化配置包迁移可移植设置。</p>
        </div>
        <div className="advanced-config-head-actions">
          <input
            ref={fileInputRef}
            className="advanced-config-file-input"
            type="file"
            accept=".json"
            onChange={(event) => void selectPackage(event.target.files?.[0])}
          />
          <AsyncActionButton
            type="button"
            status={previewPackageStatus.status}
            presentation={previewPackagePresentation}
            disabled={Boolean(busy) || previewPackageStatus.pending}
            onClick={() => fileInputRef.current?.click()}
          />
          <button className="button" type="button" disabled={Boolean(busy)} onClick={() => setExportConfirmation(true)}>
            <Icon name="download-cloud-2-line" />导出配置包
          </button>
        </div>
      </header>

      <RuntimeConfigEditor reloadToken={runtimeConfigReloadToken} />

      {preview && (
        <ConfigPackageImportDialog
          preview={preview}
          busy={busy === "import"}
          onClose={clearImport}
          onImport={applyPackage}
        />
      )}
      {exportConfirmation && (
        <ConfirmDialog
          title="导出敏感配置包"
          description="配置包包含明文存储凭据（S3 Secret Key 和 WebDAV 密码），请仅在可信设备上导出并妥善保管。"
          confirmLabel="确认导出"
          confirmIcon="download-cloud-2-line"
          danger={false}
          busy={busy === "export"}
          pendingLabel="正在导出"
          successLabel="导出成功"
          errorLabel="导出失败"
          onClose={() => setExportConfirmation(false)}
          onConfirm={downloadPackage}
        />
      )}
    </section>
  );
}
