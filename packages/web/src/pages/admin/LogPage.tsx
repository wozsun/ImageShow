import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api/client.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { Icon } from "../../components/icon/Icon.js";
import { StableLabel } from "../../components/data-display/StableLabel.js";
import { adminApiBasePath, queryKeys } from "../../lib/constants.js";
import { errorMessage, formatBytes, formatDate } from "../../lib/ui/formatters.js";
import type { SelectOption } from "../../lib/ui/select-options.js";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "OFF";

type LogFileSummary = {
  name: string;
  size: number;
  modified_at: string;
};

type AdminLogPayload = {
  level: LogLevel;
  files: LogFileSummary[];
  selected: string;
  limit_bytes: number;
  content: string;
  truncated: boolean;
  bytes_read: number;
};

const logLevelOptions: SelectOption[] = [
  { value: "DEBUG", label: "DEBUG" },
  { value: "INFO", label: "INFO" },
  { value: "WARN", label: "WARN" },
  { value: "ERROR", label: "ERROR" },
  { value: "OFF", label: "OFF" }
];

function logsPath(file: string) {
  const params = new URLSearchParams();
  if (file) params.set("file", file);
  const query = params.toString();
  return `${adminApiBasePath}/logs${query ? `?${query}` : ""}`;
}

export function LogPage() {
  const [selectedFile, setSelectedFile] = useState("");
  const [level, setLevel] = useState<LogLevel>("WARN");
  const [savingLevel, setSavingLevel] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; status: "pending" | "success" | "error" } | null>(null);
  const query = useQuery<AdminLogPayload>({
    queryKey: [...queryKeys.logs, selectedFile],
    queryFn: () => api(logsPath(selectedFile))
  });

  useEffect(() => {
    if (query.data?.level && !savingLevel) setLevel(query.data.level);
  }, [query.data?.level, savingLevel]);

  const fileOptions = useMemo<SelectOption[]>(() => {
    const files = query.data?.files ?? [];
    if (!files.length) return [{ value: query.data?.selected ?? "app.log", label: query.data?.selected ?? "app.log" }];
    return files.map((file) => ({ value: file.name, label: file.name }));
  }, [query.data]);

  const effectiveFile = selectedFile || query.data?.selected || fileOptions[0]?.value || "app.log";
  const selectedSummary = query.data?.files.find((file) => file.name === effectiveFile);
  const loadError = query.error ? errorMessage(query.error) : "";

  const changeLevel = async (nextLevel: string) => {
    if (savingLevel || nextLevel === level) return;
    const previousLevel = level;
    setLevel(nextLevel as LogLevel);
    setSavingLevel(true);
    setFeedback({ text: "正在更新日志等级...", status: "pending" });
    try {
      const response = await api<{ level: LogLevel }>(`${adminApiBasePath}/logs/level`, {
        method: "POST",
        body: JSON.stringify({ level: nextLevel })
      });
      setLevel(response.level);
      setFeedback({ text: `日志等级已切换为 ${response.level}`, status: "success" });
      void query.refetch();
    } catch (error) {
      setLevel(previousLevel);
      setFeedback({ text: `更新失败：${errorMessage(error)}`, status: "error" });
    } finally {
      setSavingLevel(false);
    }
  };

  return (
    <section className="workspace log-page">
      <header className="workspace-head">
        <div>
          <h1>日志</h1>
          <p>查看应用日志，并实时调整写入等级</p>
        </div>
        <div className="log-head-actions">
          {feedback && (
            <div className={`settings-feedback is-inline ${feedback.status === "success" ? "ok" : feedback.status === "error" ? "error" : ""}`}>
              <span>{feedback.text}</span>
            </div>
          )}
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
          <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
            <Icon name="refresh-line" />
            <StableLabel idle="刷新" busyText="刷新中" busy={query.isFetching} />
          </button>
        </div>
      </header>
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
      {loadError && <div className="settings-feedback error"><span>读取失败：{loadError}</span></div>}
      <pre className={`log-viewer${query.data?.content ? "" : " is-empty"}`}>
        {query.data?.content || (query.isFetching ? "正在读取日志..." : "暂无日志")}
      </pre>
    </section>
  );
}
