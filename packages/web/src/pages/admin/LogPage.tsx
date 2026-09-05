import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  logLevels,
  type AdminLogLevelDto,
  type AdminLogPayloadDto,
  type LogLevel
} from "@imageshow/shared/browser";
import { api, isApiClientError } from "../../lib/api/client.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { AsyncActionButton } from "../../components/actions/AsyncActionButton.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { formatBytes, formatDate } from "../../lib/ui/formatters.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { waitForMinimumPendingDuration } from "../../lib/ui/async-action-timing.js";
import type { SelectOption } from "../../lib/ui/select-options.js";
import {
  createActionFeedback,
  type ActionFeedbackState
} from "../../lib/ui/action-feedback.js";
import {
  ActionFeedbackOutlet,
  useActionFeedbackTarget
} from "../../components/feedback/ActionFeedbackRegion.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { WorkspaceHeader } from "../../components/layout/WorkspaceHeader.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";
import "../../styles/admin/logs.css";

const logLevelOptions: SelectOption[] = logLevels.map((level) => ({
  value: level,
  label: level
}));

const refreshLogsPresentation = {
  idle: { icon: "refresh-line", label: "刷新" },
  pending: { icon: "refresh-line", label: "刷新中" },
  success: { icon: "check-line", label: "刷新成功" },
  error: { icon: "close-line", label: "刷新失败" }
} as const;

const duplicateLoadErrorWindowMs = 60_000;

function logLoadErrorFingerprint(error: unknown) {
  if (isApiClientError(error)) {
    return `${error.name}\u0000${error.status}\u0000${error.code}\u0000${error.message}`;
  }
  if (error instanceof Error) return `${error.name}\u0000${error.message}`;
  return `${typeof error}\u0000${String(error)}`;
}

function logsPath(file: string) {
  const params = new URLSearchParams();
  if (file) params.set("file", file);
  const query = params.toString();
  return `${adminApiBasePath}/logs${query ? `?${query}` : ""}`;
}

export function LogPage() {
  const client = useQueryClient();
  const logViewerRef = useRef<HTMLPreElement | null>(null);
  const reportedLoadErrorsRef = useRef(new Map<string, number>());
  const [selectedFile, setSelectedFile] = useState("");
  const [level, setLevel] = useState<LogLevel>("WARN");
  const [savingLevel, setSavingLevel] = useState(false);
  const refreshLogsStatus = useAsyncActionStatus();
  const [feedback, setFeedback] = useState<ActionFeedbackState | null>(null);
  const feedbackTarget = useActionFeedbackTarget("admin-logs");
  const query = useQuery<AdminLogPayloadDto>({
    queryKey: [...queryKeys.logs, selectedFile],
    queryFn: ({ signal }) => api(logsPath(selectedFile), { signal })
  });

  useEffect(() => {
    if (query.data?.level && !savingLevel) setLevel(query.data.level);
  }, [query.data?.level, savingLevel]);

  useEffect(() => {
    if (!query.error) return;
    const now = Date.now();
    const fingerprint = logLoadErrorFingerprint(query.error);
    const lastReportedAt = reportedLoadErrorsRef.current.get(fingerprint) ?? 0;
    if (now - lastReportedAt < duplicateLoadErrorWindowMs) return;

    reportedLoadErrorsRef.current.set(fingerprint, now);
    for (const [knownFingerprint, reportedAt] of reportedLoadErrorsRef.current) {
      if (now - reportedAt >= duplicateLoadErrorWindowMs) {
        reportedLoadErrorsRef.current.delete(knownFingerprint);
      }
    }
    reportAdminUiError("admin_logs.load", query.error);
  }, [query.error, query.errorUpdatedAt]);

  const fileOptions = useMemo<SelectOption[]>(() => {
    const files = query.data?.files ?? [];
    if (!files.length) return [{ value: query.data?.selected ?? "app.log", label: query.data?.selected ?? "app.log" }];
    return files.map((file) => ({ value: file.name, label: file.name }));
  }, [query.data]);

  const effectiveFile = selectedFile || query.data?.selected || fileOptions[0]?.value || "app.log";
  const selectedSummary = query.data?.files.find((file) => file.name === effectiveFile);
  const visibleFeedback = feedback ?? (query.error && !query.data ? {
    id: query.errorUpdatedAt,
    text: "日志读取失败，请稍后重试",
    status: "error" as const
  } : null);

  const refreshLogs = async () => {
    if (query.isFetching || refreshLogsStatus.pending) return;
    await refreshLogsStatus.run(async () => {
      const result = await query.refetch();
      return !result.isError;
    });
  };

  const changeLevel = async (nextLevel: string) => {
    if (savingLevel || nextLevel === level) return;
    const previousLevel = level;
    setLevel(nextLevel as LogLevel);
    setSavingLevel(true);
    setFeedback(createActionFeedback("正在更新日志等级...", "pending"));
    const startedAt = Date.now();
    try {
      const response = await api<AdminLogLevelDto>(`${adminApiBasePath}/logs/level`, {
        method: "POST",
        body: JSON.stringify({ level: nextLevel })
      });
      await client.cancelQueries({ queryKey: queryKeys.logs });
      client.setQueriesData<AdminLogPayloadDto>({ queryKey: queryKeys.logs }, (current) => (
        current ? { ...current, level: response.level } : current
      ));
      setLevel(response.level);
      void client.invalidateQueries({ queryKey: queryKeys.logs });
      await waitForMinimumPendingDuration(startedAt);
      setFeedback(createActionFeedback("日志写入等级已更新", "success"));
    } catch (error) {
      setLevel(previousLevel);
      reportAdminUiError("admin_logs.level_update", error);
      await waitForMinimumPendingDuration(startedAt);
      setFeedback(createActionFeedback("日志等级更新失败，请稍后重试", "error"));
    } finally {
      setSavingLevel(false);
    }
  };

  return (
    <section className="workspace workspace-contained log-page">
      <WorkspaceHeader
        title="日志"
        description="查看应用日志，并实时调整写入等级"
        feedbackTarget={feedbackTarget}
        actionsClassName="log-head-actions"
        actions={
          <>
            <label className="log-control">
              写入等级
              <SelectMenu
                value={level}
                onChange={changeLevel}
                options={logLevelOptions}
                ariaLabel="日志写入等级"
                disabled={savingLevel}
              />
            </label>
            <AsyncActionButton
              type="button"
              status={refreshLogsStatus.status}
              presentation={refreshLogsPresentation}
              disabled={query.isFetching || refreshLogsStatus.pending}
              onClick={() => void refreshLogs()}
            />
          </>
        }
      />
      <div className="log-toolbar">
        <label className="log-control">
          日志文件
          <SelectMenu
            value={effectiveFile}
            onChange={setSelectedFile}
            options={fileOptions}
            ariaLabel="日志文件"
            disabled={query.isFetching && !query.data}
          />
        </label>
        <div className="log-meta">
          {selectedSummary && <span>{formatBytes(selectedSummary.size)}</span>}
          {selectedSummary && <span>{formatDate(selectedSummary.modified_at)}</span>}
          {query.data && <span>读取 {formatBytes(query.data.bytes_read)}</span>}
          {query.data?.truncated && <span>已截取最近 {formatBytes(query.data.limit_bytes)}</span>}
        </div>
      </div>
      <div className="log-viewer-frame">
        <pre ref={logViewerRef} className={`log-viewer${query.data?.content ? "" : " is-empty"}`}>
          {query.data?.content || (query.isFetching ? "正在读取日志..." : "暂无日志")}
        </pre>
        <OverlayScrollbar targetRef={logViewerRef} tone="dark" />
      </div>
      {visibleFeedback && (
        <ActionFeedbackOutlet
          feedback={visibleFeedback}
          target={feedbackTarget}
          onClose={feedback ? () => setFeedback(null) : undefined}
        />
      )}
    </section>
  );
}
