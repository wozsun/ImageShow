import { useEffect, useRef, useState } from "react";
import type { RuntimeConfig } from "@imageshow/shared";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";
import { api } from "../../../lib/api/client.js";
import { adminApiBasePath, queryKeys } from "../../../lib/constants.js";
import { errorMessage } from "../../../lib/ui/formatters.js";
import type { RuntimeConfigChangeSummary } from "../../../lib/types.js";
import { Icon } from "../../../components/icon/Icon.js";
import {
  ActionFeedback,
  type ActionFeedbackState
} from "../../../components/feedback/ActionFeedback.js";
import { ConfirmDialog } from "../../../components/feedback/ConfirmDialog.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { useQueryClient } from "@tanstack/react-query";

type RuntimeConfigResponse = {
  config: RuntimeConfig;
  changes?: RuntimeConfigChangeSummary;
};

const formatConfig = (config: unknown) => JSON.stringify(config, null, 2);
const jsonExtensions = [json(), EditorView.lineWrapping];

const restartLabels: Record<RuntimeConfigChangeSummary["restart_required"][number], string> = {
  port: "监听端口",
  database: "数据库连接",
  redis: "Redis 连接"
};

function saveConfirmationDescription(changes: RuntimeConfigChangeSummary) {
  const messages = ["将使用编辑器内容完整替换当前 config.json。"];
  if (changes.restart_required.length) {
    messages.push(
      `${changes.restart_required.map((field) => restartLabels[field]).join("、")}需要重启容器后完全生效。`
    );
  }
  if (changes.access_changes.length) {
    messages.push("站点域名将发生变化，保存后当前地址可能无法继续访问。 ");
  }
  return messages.join(" ").trim();
}

export function RuntimeConfigEditor({ reloadToken }: { reloadToken: number }) {
  const client = useQueryClient();
  const editorScrollRef = useRef<HTMLElement | null>(null);
  const [text, setText] = useState("");
  const [baseline, setBaseline] = useState("");
  const [action, setAction] = useState<"" | "load" | "validate" | "save">("load");
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const [confirmation, setConfirmation] = useState<"" | "reload" | "save">("");
  const [candidate, setCandidate] = useState<RuntimeConfig | null>(null);
  const [changes, setChanges] = useState<RuntimeConfigChangeSummary | null>(null);
  const [editorScrollReady, setEditorScrollReady] = useState(false);
  const isDirty = text !== baseline;

  const bindEditorScroll = (view: EditorView) => {
    editorScrollRef.current = view.scrollDOM;
    setEditorScrollReady(true);
  };

  const loadConfig = async (showFeedback: boolean) => {
    setAction("load");
    if (showFeedback) setFeedback({ text: "正在重新读取完整配置…", status: "pending" });
    try {
      const response = await api<RuntimeConfigResponse>(`${adminApiBasePath}/advanced-config/runtime`);
      const formatted = formatConfig(response.config);
      setText(formatted);
      setBaseline(formatted);
      if (showFeedback) setFeedback({ text: "已重新读取当前配置", status: "success" });
    } catch (error) {
      setFeedback({ text: `读取失败：${errorMessage(error)}`, status: "error" });
    } finally {
      setAction("");
    }
  };

  useEffect(() => {
    void loadConfig(reloadToken > 0);
  }, [reloadToken]);

  const formatEditor = () => {
    try {
      setText(formatConfig(JSON.parse(text) as unknown));
      setFeedback({ text: "JSON 已格式化", status: "success" });
    } catch (error) {
      setFeedback({ text: `JSON 语法错误：${errorMessage(error)}`, status: "error" });
    }
  };

  const requestReload = () => {
    if (isDirty) setConfirmation("reload");
    else void loadConfig(true);
  };

  const validateForSave = async () => {
    let parsed: RuntimeConfig;
    try {
      parsed = JSON.parse(text) as RuntimeConfig;
    } catch (error) {
      setFeedback({ text: `JSON 语法错误：${errorMessage(error)}`, status: "error" });
      return;
    }

    setAction("validate");
    setFeedback({ text: "正在校验完整配置…", status: "pending" });
    try {
      const response = await api<{ changes: RuntimeConfigChangeSummary }>(
        `${adminApiBasePath}/advanced-config/runtime/validate`,
        { method: "POST", body: JSON.stringify({ config: parsed }) }
      );
      setCandidate(parsed);
      setChanges(response.changes);
      setConfirmation("save");
      setFeedback({ text: "配置校验通过，请确认保存", status: "success" });
    } catch (error) {
      setFeedback({ text: `配置校验失败：${errorMessage(error)}`, status: "error" });
    } finally {
      setAction("");
    }
  };

  const saveConfig = async () => {
    if (!candidate) return;
    setAction("save");
    setFeedback({ text: "正在保存完整配置…", status: "pending" });
    try {
      const response = await api<Required<RuntimeConfigResponse>>(
        `${adminApiBasePath}/advanced-config/runtime`,
        { method: "POST", body: JSON.stringify({ config: candidate }) }
      );
      const formatted = formatConfig(response.config);
      setText(formatted);
      setBaseline(formatted);
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.settings }),
        client.invalidateQueries({ queryKey: queryKeys.siteConfig }),
        client.invalidateQueries({ queryKey: queryKeys.me }),
        client.invalidateQueries({ queryKey: ["storage-options"] })
      ]);
      const restartRequired = response.changes.restart_required.length > 0;
      setFeedback({
        text: restartRequired ? "配置已保存；连接或端口变更需重启容器" : "完整配置已保存并应用",
        status: "success"
      });
    } catch (error) {
      setFeedback({ text: `保存失败：${errorMessage(error)}`, status: "error" });
    } finally {
      setAction("");
      setCandidate(null);
      setChanges(null);
      setConfirmation("");
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
        <div>
          <h2><Icon name="settings-3-line" />完整 config.json</h2>
          <p className="hint">精准编辑当前实例的全部运行时配置，缺少字段或多余字段均会拒绝保存。</p>
        </div>
        {isDirty && <span className="advanced-config-dirty">未保存</span>}
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
          <button type="button" disabled={Boolean(action) || !text} onClick={formatEditor}>格式化</button>
          <button type="button" disabled={Boolean(action)} onClick={requestReload}>
            <Icon name="refresh-line" />重新读取
          </button>
          <button className="button" type="button" disabled={Boolean(action) || !isDirty} onClick={() => void validateForSave()}>
            <Icon name="save-3-line" />{action === "validate" ? "正在校验…" : "保存配置"}
          </button>
        </div>
        {feedback && <ActionFeedback feedback={feedback} inline />}
      </div>

      {confirmation === "reload" && (
        <ConfirmDialog
          title="放弃未保存修改"
          description="重新读取会覆盖编辑器中的未保存内容。"
          confirmLabel="放弃并重新读取"
          confirmIcon="refresh-line"
          busy={action === "load"}
          onClose={() => setConfirmation("")}
          onConfirm={() => loadConfig(true)}
        />
      )}
      {confirmation === "save" && changes && (
        <ConfirmDialog
          title="保存完整配置"
          description={saveConfirmationDescription(changes)}
          confirmLabel="确认保存"
          confirmIcon="save-3-line"
          danger={changes.restart_required.length > 0 || changes.access_changes.length > 0}
          busy={action === "save"}
          onClose={closeSaveConfirmation}
          onConfirm={saveConfig}
        />
      )}
    </section>
  );
}
