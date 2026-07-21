import { useEffect, useRef, useState } from "react";
import type { RuntimeConfig } from "@imageshow/shared";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { api } from "../../../lib/api/client.js";
import { invalidateRuntimeData } from "../../../lib/api/query-invalidation.js";
import { adminApiBasePath } from "../../../lib/constants.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import type { RuntimeConfigChangeSummary } from "../../../lib/types.js";
import { Icon } from "../../../components/icon/Icon.js";
import { AsyncActionButton } from "../../../components/actions/AsyncActionButton.js";
import {
  createActionFeedback,
  type ActionFeedbackState
} from "../../../components/feedback/ActionFeedback.js";
import {
  ActionFeedbackOutlet,
  ActionFeedbackRegion,
  useActionFeedbackTarget
} from "../../../components/feedback/ActionFeedbackRegion.js";
import { ConfirmDialog } from "../../../components/feedback/ConfirmDialog.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { useQueryClient } from "@tanstack/react-query";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";

type RuntimeConfigResponse = {
  config: RuntimeConfig;
  changes?: RuntimeConfigChangeSummary;
};

const formatConfig = (config: unknown) => JSON.stringify(config, null, 2);
const jsonExtensions = [json(), EditorView.lineWrapping];

const formatPresentation = {
  idle: { icon: "file-list-line", label: "格式化" },
  pending: { icon: "file-list-line", label: "格式化中" },
  success: { icon: "check-line", label: "格式化完成" },
  error: { icon: "close-line", label: "格式错误" }
} as const;

const reloadPresentation = {
  idle: { icon: "refresh-line", label: "重新读取" },
  pending: { icon: "refresh-line", label: "读取中" },
  success: { icon: "check-line", label: "读取成功" },
  error: { icon: "close-line", label: "读取失败" }
} as const;

const validatePresentation = {
  idle: { icon: "save-3-line", label: "保存配置" },
  pending: { icon: "save-3-line", label: "校验中" },
  success: { icon: "check-line", label: "校验通过" },
  error: { icon: "close-line", label: "校验失败" }
} as const;

function saveConfirmationDescription(changes: RuntimeConfigChangeSummary) {
  const messages = ["将使用编辑器内容完整替换当前 config.json。"];
  if (changes.access_changes.length) {
    messages.push("站点域名将发生变化，保存后当前地址可能无法继续访问。 ");
  }
  return messages.join(" ").trim();
}

export function RuntimeConfigEditor({ reloadToken }: {
  reloadToken: number;
}) {
  const client = useQueryClient();
  const editorScrollRef = useRef<HTMLElement | null>(null);
  const [text, setText] = useState("");
  const [baseline, setBaseline] = useState("");
  const [action, setAction] = useState<"" | "load" | "validate" | "save">("load");
  const [confirmation, setConfirmation] = useState<"" | "reload" | "save">("");
  const [candidate, setCandidate] = useState<RuntimeConfig | null>(null);
  const [changes, setChanges] = useState<RuntimeConfigChangeSummary | null>(null);
  const [editorScrollReady, setEditorScrollReady] = useState(false);
  const [loadFeedback, setLoadFeedback] = useState<ActionFeedbackState | null>(null);
  const loadFeedbackTarget = useActionFeedbackTarget("advanced-config-card");
  const formatStatus = useAsyncActionStatus();
  const reloadStatus = useAsyncActionStatus();
  const validateStatus = useAsyncActionStatus({ successDurationMs: null });
  const isDirty = text !== baseline;
  const actionPending = Boolean(action)
    || formatStatus.pending
    || reloadStatus.pending
    || validateStatus.pending;

  const bindEditorScroll = (view: EditorView) => {
    editorScrollRef.current = view.scrollDOM;
    setEditorScrollReady(true);
  };

  const loadConfig = async (origin: "automatic" | "manual"): Promise<boolean> => {
    setAction("load");
    if (origin === "manual") setLoadFeedback(null);
    try {
      const response = await api<RuntimeConfigResponse>(`${adminApiBasePath}/advanced-config/runtime`);
      const formatted = formatConfig(response.config);
      setText(formatted);
      setBaseline(formatted);
      setLoadFeedback(null);
      return true;
    } catch (error) {
      reportAdminUiError("advanced_config.runtime_load", error);
      if (origin === "automatic") {
        setLoadFeedback(createActionFeedback("完整配置读取失败，请稍后重试", "error"));
      }
      return false;
    } finally {
      setAction("");
    }
  };

  useEffect(() => {
    void loadConfig("automatic");
  }, [reloadToken]);

  const formatEditor = async () => {
    await formatStatus.run(async () => {
      try {
        setText(formatConfig(JSON.parse(text) as unknown));
        return true;
      } catch (error) {
        reportAdminUiError("advanced_config.json_format", error);
        return false;
      }
    });
  };

  const requestReload = () => {
    setLoadFeedback(null);
    if (isDirty) setConfirmation("reload");
    else void reloadStatus.run(() => loadConfig("manual"));
  };

  const validateForSave = async () => {
    let parsed: RuntimeConfig;
    try {
      parsed = JSON.parse(text) as RuntimeConfig;
    } catch (error) {
      reportAdminUiError("advanced_config.json_parse", error);
      await validateStatus.run(async () => false);
      return;
    }

    await validateStatus.run(async () => {
      setAction("validate");
      try {
        const response = await api<{ changes: RuntimeConfigChangeSummary }>(
          `${adminApiBasePath}/advanced-config/runtime/validate`,
          { method: "POST", body: JSON.stringify({ config: parsed }) }
        );
        setCandidate(parsed);
        setChanges(response.changes);
        setConfirmation("save");
        return true;
      } catch (error) {
        reportAdminUiError("advanced_config.runtime_validate", error);
        return false;
      } finally {
        setAction("");
      }
    });
  };

  const saveConfig = async (): Promise<boolean> => {
    if (!candidate) return false;
    setAction("save");
    try {
      const response = await api<Required<RuntimeConfigResponse>>(
        `${adminApiBasePath}/advanced-config/runtime`,
        { method: "POST", body: JSON.stringify({ config: candidate }) }
      );
      const formatted = formatConfig(response.config);
      setText(formatted);
      setBaseline(formatted);
      await invalidateRuntimeData(client);
      return true;
    } catch (error) {
      reportAdminUiError("advanced_config.runtime_save", error);
      return false;
    } finally {
      setAction("");
    }
  };

  const closeSaveConfirmation = () => {
    setCandidate(null);
    setChanges(null);
    setConfirmation("");
  };

  return (
    <section className="advanced-config-editor">
      <div className="advanced-config-editor-head">
        <h2
          title="精准编辑当前实例的全部运行时配置，缺少字段或多余字段均会拒绝保存。"
          aria-description="精准编辑当前实例的全部运行时配置，缺少字段或多余字段均会拒绝保存。"
        >
          <Icon name="settings-3-line" />完整 config.json
        </h2>
        <div className="advanced-config-editor-head-status">
          <ActionFeedbackRegion
            className="advanced-config-feedback-region"
            target={loadFeedbackTarget}
            variant="card"
          />
          {isDirty && <span className="advanced-config-dirty">未保存</span>}
        </div>
      </div>
      <div className="advanced-config-code-editor">
        <CodeMirror
          className="advanced-config-codemirror"
          aria-label="完整 config.json"
          value={text}
          height="100%"
          theme="dark"
          extensions={jsonExtensions}
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            bracketMatching: true,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            searchKeymap: true,
            tabSize: 2
          }}
          editable={action !== "load" || Boolean(text)}
          indentWithTab
          onCreateEditor={bindEditorScroll}
          onChange={setText}
        />
        {editorScrollReady && <OverlayScrollbar targetRef={editorScrollRef} tone="dark" />}
      </div>
      <div className="advanced-config-editor-footer">
        <div className="advanced-config-editor-actions">
          <AsyncActionButton
            type="button"
            status={formatStatus.status}
            presentation={formatPresentation}
            disabled={actionPending || !text}
            onClick={() => void formatEditor()}
          />
          <AsyncActionButton
            type="button"
            status={reloadStatus.status}
            presentation={reloadPresentation}
            disabled={actionPending}
            onClick={requestReload}
          />
          <AsyncActionButton
            className="button"
            type="button"
            status={validateStatus.status}
            presentation={validatePresentation}
            disabled={actionPending || !isDirty}
            onClick={() => void validateForSave()}
          />
        </div>
      </div>

      {loadFeedback && (
        <ActionFeedbackOutlet
          feedback={loadFeedback}
          target={loadFeedbackTarget}
          onClose={() => setLoadFeedback(null)}
        />
      )}

      {confirmation === "reload" && (
        <ConfirmDialog
          title="放弃未保存修改"
          description="重新读取会覆盖编辑器中的未保存内容。"
          confirmLabel="放弃并重新读取"
          confirmIcon="refresh-line"
          busy={action === "load"}
          onClose={() => setConfirmation("")}
          onConfirm={() => reloadStatus.run(() => loadConfig("manual"))}
        />
      )}
      {confirmation === "save" && changes && (
        <ConfirmDialog
          title="保存完整配置"
          description={saveConfirmationDescription(changes)}
          confirmLabel="确认保存"
          confirmIcon="save-3-line"
          danger={changes.access_changes.length > 0}
          busy={action === "save"}
          onClose={closeSaveConfirmation}
          onConfirm={saveConfig}
        />
      )}
    </section>
  );
}
