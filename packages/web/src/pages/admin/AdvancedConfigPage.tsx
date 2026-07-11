import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api/client.js";
import { adminApiBasePath, queryKeys } from "../../lib/constants.js";
import { errorMessage } from "../../lib/ui/formatters.js";
import type { AdvancedConfigPreview } from "../../lib/types.js";
import { Icon } from "../../components/icon/Icon.js";
import {
  ActionFeedback,
  type ActionFeedbackState
} from "../../components/feedback/ActionFeedback.js";
import { ConfirmDialog } from "../../components/feedback/ConfirmDialog.js";
import { ConfigPackageImportDialog } from "./advanced-config/ConfigPackageImportDialog.js";
import { RuntimeConfigEditor } from "./advanced-config/RuntimeConfigEditor.js";

const maxPackageBytes = 1024 * 1024;
const packageFileReadOverheadBytes = 64 * 1024;

export function AdvancedConfigPage() {
  const client = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<unknown | null>(null);
  const [preview, setPreview] = useState<AdvancedConfigPreview | null>(null);
  const [busy, setBusy] = useState<"" | "export" | "preview" | "import">("");
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const [exportConfirmation, setExportConfirmation] = useState(false);
  const [runtimeConfigReloadToken, setRuntimeConfigReloadToken] = useState(0);

  const clearImport = () => {
    setSelectedPackage(null);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const downloadPackage = async () => {
    setBusy("export");
    setFeedback({ text: "正在生成配置包…", status: "pending" });
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
      setFeedback({ text: "配置包已生成", status: "success" });
    } catch (error) {
      setFeedback({ text: `导出失败：${errorMessage(error)}`, status: "error" });
    } finally {
      setBusy("");
      setExportConfirmation(false);
    }
  };

  const selectPackage = async (file?: File) => {
    if (!file || busy) return;
    clearImport();
    setBusy("preview");
    setFeedback({ text: "正在校验配置包…", status: "pending" });
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
      setFeedback(null);
    } catch (error) {
      setFeedback({ text: `配置包无效：${errorMessage(error)}`, status: "error" });
    } finally {
      setBusy("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const applyPackage = async (slugMappings: Record<string, string>) => {
    if (!selectedPackage || busy) return false;
    setBusy("import");
    setFeedback({ text: "正在导入配置包…", status: "pending" });
    try {
      const response = await api<{ result: { imported_backends: string[] } }>(
        `${adminApiBasePath}/advanced-config/import`,
        {
          method: "POST",
          body: JSON.stringify({ package: selectedPackage, slug_mappings: slugMappings })
        }
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.settings }),
        client.invalidateQueries({ queryKey: queryKeys.siteConfig }),
        client.invalidateQueries({ queryKey: queryKeys.me }),
        client.invalidateQueries({ queryKey: ["storage-backends"] }),
        client.invalidateQueries({ queryKey: ["storage-options"] })
      ]);
      setRuntimeConfigReloadToken((current) => current + 1);
      const count = response.result.imported_backends.length;
      setFeedback({ text: `配置导入成功，新增 ${count} 个存储后端`, status: "success" });
      return true;
    } catch (error) {
      setFeedback({ text: `导入失败：${errorMessage(error)}`, status: "error" });
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
            accept="application/json,.json"
            onChange={(event) => void selectPackage(event.target.files?.[0])}
          />
          <button type="button" disabled={Boolean(busy)} onClick={() => fileInputRef.current?.click()}>
            <Icon name="upload-cloud-2-line" />{busy === "preview" ? "正在校验…" : "导入配置包"}
          </button>
          <button className="button" type="button" disabled={Boolean(busy)} onClick={() => setExportConfirmation(true)}>
            <Icon name="download-cloud-2-line" />导出配置包
          </button>
        </div>
      </header>

      {feedback && !preview && <ActionFeedback feedback={feedback} />}
      <RuntimeConfigEditor reloadToken={runtimeConfigReloadToken} />

      {preview && (
        <ConfigPackageImportDialog
          preview={preview}
          busy={busy === "import"}
          feedback={feedback}
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
          onClose={() => setExportConfirmation(false)}
          onConfirm={downloadPackage}
        />
      )}
    </section>
  );
}
