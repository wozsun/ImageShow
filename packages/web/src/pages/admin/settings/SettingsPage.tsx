import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type RuntimeConfigResponseDto, type RuntimeConfigSaveRequestDto, adminApiBasePath } from "@imageshow/shared/browser";
import { api, apiValidationIssues } from "../../../lib/api/client.js";
import { queryKeys } from "../../../lib/api/query-keys.js";
import { invalidateRuntimeData } from "../../../lib/api/query-invalidation.js";
import { reportAdminUiError } from "../../../lib/ui/error-reporting.js";
import { AsyncActionButton } from "../../../components/actions/AsyncActionButton.js";
import { ConfirmDialog } from "../../../components/dialog/ConfirmDialog.js";
import { QueryErrorState } from "../../../components/feedback/QueryErrorState.js";
import { WorkspaceScrollBody } from "../../../components/layout/WorkspaceScrollBody.js";
import { WorkspaceHeader } from "../../../components/layout/WorkspaceHeader.js";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";
import { useWorkspaceToolbarCollapse } from "../../../hooks/useWorkspaceToolbarCollapse.js";
import { WorkspaceToolbarScrollbar } from "../../../components/layout/WorkspaceToolbarScrollbar.js";
import {
  ActionFeedbackOutlet,
  useActionFeedbackTarget
} from "../../../components/feedback/ActionFeedbackRegion.js";
import { createActionFeedback, type ActionFeedbackState } from "../../../lib/ui/action-feedback.js";
import { SettingsFieldControl } from "./SettingsFieldControl.js";
import {
  replaceSettingsField,
  settingsFieldEntries,
  settingsFieldValue,
  settingsGroupEntries,
  settingsSections,
  settingsValidationFailure,
  type SettingsFieldPath
} from "./settings-fields.js";
import "../../../styles/admin/settings.css";

const reloadPresentation = {
  idle: { icon: "refresh-line", label: "读取配置文件" },
  pending: { icon: "refresh-line", label: "读取中" },
  success: { icon: "check-line", label: "读取配置成功" },
  error: { icon: "close-line", label: "读取配置失败" }
} as const;
const savePresentation = {
  idle: { icon: "save-3-line", label: "保存应用配置" },
  pending: { icon: "save-3-line", label: "保存中" },
  success: { icon: "check-line", label: "保存配置成功" },
  error: { icon: "close-line", label: "保存配置失败" }
} as const;

type SettingsAction = ({ kind: "save" } & RuntimeConfigSaveRequestDto) | { kind: "reload" };

export function SettingsPage() {
  const query = useQuery({
    queryKey: queryKeys.runtimeConfig,
    queryFn: ({ signal }) => api<RuntimeConfigResponseDto>(
      `${adminApiBasePath}/settings/runtime`,
      { signal }
    ),
    gcTime: 0
  });
  if (query.data) return <SettingsPageContent snapshot={query.data} />;
  if (query.isError) {
    return (
      <QueryErrorState
        error={query.error}
        onRetry={() => void query.refetch()}
        fullPage
        reportContext="settings.load"
      />
    );
  }
  return <div className="center" role="status">加载中</div>;
}

function SettingsPageContent({ snapshot }: { snapshot: RuntimeConfigResponseDto }) {
  const serverConfig = snapshot.config;
  const client = useQueryClient();
  const [draft, setDraft] = useState<RuntimeConfigSaveRequestDto | null>(null);
  const current = draft ?? { config: serverConfig, revision: snapshot.revision };
  const config = current.config;
  const configRef = useRef(current);
  configRef.current = current;
  const [actionError, setActionError] = useState("");
  const [actionFeedback, setActionFeedback] = useState<ActionFeedbackState | null>(null);
  // 保存失败时各配置项的问题；对应输入框标红，修改该项后清除。
  const [fieldErrors, setFieldErrors] = useState<ReadonlyMap<SettingsFieldPath, string>>(
    () => new Map()
  );
  const feedbackTarget = useActionFeedbackTarget("settings");
  const [confirmation, setConfirmation] = useState<SettingsAction | null>(null);
  const actionRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const workspaceToolbarRef = useWorkspaceToolbarCollapse();
  const returnFocusRef = useRef<HTMLButtonElement | null>(null);
  const reloadStatus = useAsyncActionStatus();
  const saveStatus = useAsyncActionStatus();
  const busy = reloadStatus.pending || saveStatus.pending;
  const dirty = JSON.stringify(config) !== JSON.stringify(serverConfig);
  const locked = busy || confirmation !== null;
  useEffect(() => () => actionRef.current?.abort(), []);

  const settleField = () => {
    // 数字和多行列表先结算失焦编辑，再冻结提交快照。
    flushSync(() => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && scrollRef.current?.contains(focused)) {
        focused.blur();
      }
    });
    return structuredClone(configRef.current);
  };

  const runAction = async (action: SettingsAction) => {
    if (busy || actionRef.current) return false;
    const controller = new AbortController();
    actionRef.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    setActionError("");
    setActionFeedback(null);
    setFieldErrors(new Map());
    const status = action.kind === "reload" ? reloadStatus : saveStatus;
    return status.run(async () => {
      try {
        const response = await api<RuntimeConfigResponseDto>(
          `${adminApiBasePath}/settings${action.kind === "reload" ? "/reload" : ""}`,
          {
            method: "POST",
            signal,
            body: action.kind === "save"
              ? JSON.stringify({ config: action.config, revision: action.revision } satisfies RuntimeConfigSaveRequestDto)
              : undefined
          }
        );
        signal.throwIfAborted();
        await Promise.all([
          client.cancelQueries({ queryKey: queryKeys.settings, exact: true }),
          client.cancelQueries({ queryKey: queryKeys.runtimeConfig, exact: true })
        ]);
        signal.throwIfAborted();
        client.setQueryData(queryKeys.runtimeConfig, response);
        setDraft(null);
        void invalidateRuntimeData(client, response.settings).catch((error) => {
          reportAdminUiError("settings.refresh", error);
        });
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        const validation = signal.aborted
          ? null
          : settingsValidationFailure(apiValidationIssues(error));
        if (validation) setFieldErrors(validation.fieldErrors);
        const message = signal.aborted
          ? "请求超时，草稿已保留。可重试保存或读取配置文件确认结果。"
          : validation
            ? validation.message
            : error instanceof Error
              ? error.message
              : "操作失败，草稿已保留。";
        setActionError(message);
        setActionFeedback(createActionFeedback(message, "error"));
        reportAdminUiError(`settings.${action.kind}`, error);
        return false;
      } finally {
        if (actionRef.current === controller) actionRef.current = null;
      }
    });
  };

  const requestAction = (kind: SettingsAction["kind"], trigger: HTMLButtonElement) => {
    if (locked || actionRef.current) return;
    const submitted = settleField();
    returnFocusRef.current = trigger;
    const action: SettingsAction = kind === "save" ? { kind, ...submitted } : { kind };
    const changesDomain = submitted.config.site.domain.trim().toLowerCase() !== serverConfig.site.domain;
    const discardsDraft = JSON.stringify(submitted.config) !== JSON.stringify(serverConfig);
    if ((kind === "save" && changesDomain) || (kind === "reload" && discardsDraft)) {
      setActionError("");
      setConfirmation(action);
    } else {
      void runAction(action);
    }
  };

  const renderField = ([path, field]: (typeof settingsFieldEntries)[number]) => (
    <SettingsFieldControl
      key={path}
      field={field}
      value={settingsFieldValue(config, path)}
      disabled={locked}
      error={fieldErrors.get(path)}
      onChange={(value) => {
        if (locked || actionRef.current) return;
        if (fieldErrors.has(path)) {
          setFieldErrors((current) => {
            const next = new Map(current);
            next.delete(path);
            return next;
          });
        }
        const next = { config: replaceSettingsField(configRef.current.config, path, value), revision: configRef.current.revision };
        configRef.current = next;
        setDraft(JSON.stringify(next.config) === JSON.stringify(serverConfig) ? null : next);
      }}
    />
  );

  const renderSections = (column: "left" | "right" | "wide") => Object.entries(settingsSections)
    .filter(([, section]) => section.column === column)
    .map(([section, { title, description }]) => (
      <section key={section} className={`settings-card settings-card-${section}`}>
        <header className="settings-card-heading">
          <div className="settings-heading-row">
            <h2>{title}</h2>
            {settingsFieldEntries.filter(([, field]) => field.kind === "toggle" && field.heading === "card"
              && settingsGroupEntries.some(([key, group]) => key === field.group && group.section === section))
              .map(renderField)}
          </div>
          <p className="hint">{description}</p>
        </header>
        <div className="settings-groups">
          {settingsGroupEntries
            .filter(([, group]) => group.section === section)
            .map(([key, group]) => {
              const fields = settingsFieldEntries.filter(([, field]) => field.group === key);
              const controls = fields.filter(([, field]) => field.kind !== "toggle");
              const headingToggles = fields.filter(([, field]) => field.kind === "toggle" && field.heading === "group");
              const toggles = fields.filter(([, field]) => field.kind === "toggle" && !field.heading);
              return (
                <div key={key} className={`settings-group${group.wide ? " settings-group-wide" : ""}`}>
                  {group.title && (
                    <div className="settings-heading-row">
                      <h3>{group.title}</h3>
                      {headingToggles.map(renderField)}
                    </div>
                  )}
                  {controls.length > 0 && (
                    <div className={`settings-field-grid${group.singleColumn ? " settings-field-grid-single" : ""}`}>
                      {controls.map(renderField)}
                    </div>
                  )}
                  {toggles.length > 0 && (
                    <div className="settings-toggle-grid">{toggles.map(renderField)}</div>
                  )}
                </div>
              );
            })}
        </div>
      </section>
    ));

  return (
    <section
      ref={workspaceToolbarRef}
      className="workspace workspace-contained workspace-has-toolbar settings-page"
    >
      <WorkspaceHeader
        title="站点配置"
        description={dirty ? "有未保存的修改" : "全部应用运行配置"}
        feedbackTarget={feedbackTarget}
        actionsClassName="settings-head-actions"
        actions={(
          <>
            <AsyncActionButton
              type="button"
              className="settings-config-button"
              status={reloadStatus.status}
              presentation={reloadPresentation}
              disabled={locked}
              onClick={(event) => requestAction("reload", event.currentTarget)}
            />
            <AsyncActionButton
              type="button"
              className="button settings-config-button"
              status={saveStatus.status}
              presentation={savePresentation}
              disabled={locked}
              onClick={(event) => requestAction("save", event.currentTarget)}
            />
          </>
        )}
      />
      <WorkspaceScrollBody ref={scrollRef} className="settings-scroll-region">
        <fieldset className="settings-grid" disabled={locked} aria-busy={busy}>
          <div className="settings-columns">
            <div className="settings-column">{renderSections("left")}</div>
            <div className="settings-column">{renderSections("right")}</div>
          </div>
          {renderSections("wide")}
        </fieldset>
      </WorkspaceScrollBody>
      {actionFeedback && (
        <ActionFeedbackOutlet
          feedback={actionFeedback}
          target={feedbackTarget}
          onClose={() => setActionFeedback(null)}
        />
      )}
      {confirmation && (
        <ConfirmDialog
          title={confirmation.kind === "reload" ? "读取配置文件" : "变更站点域名"}
          description={confirmation.kind === "reload"
            ? "读取成功后将以配置文件替换当前未保存的修改，并应用到后续请求。"
            : `主站域名将变为 ${confirmation.config.site.domain.trim() || "任意有效 Host"}。请确认域名已接入；保存后可能需要从新域名重新登录。`}
          confirmLabel={confirmation.kind === "reload" ? "读取并替换" : "确认保存"}
          confirmIcon={confirmation.kind === "reload" ? "refresh-line" : "save-3-line"}
          pendingLabel="处理中"
          successLabel="操作成功"
          errorLabel="操作失败"
          errorMessage={actionError}
          danger={false}
          busy={busy}
          returnFocusRef={returnFocusRef}
          onClose={() => setConfirmation(null)}
          onConfirm={() => runAction(confirmation)}
        />
      )}
      <WorkspaceToolbarScrollbar />
    </section>
  );
}
