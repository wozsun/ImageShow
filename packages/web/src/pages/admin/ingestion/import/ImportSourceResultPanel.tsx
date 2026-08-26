import { AdminIcon } from "../../../../components/icon/AdminIcon.js";
import { copyTextToClipboard } from "../../../../lib/ui/clipboard.js";
import type {
  JsonlManifestParseError,
  WeiboImportParseError
} from "../queue/ingestion-api.js";
import type { ParsedImportSourceResult } from "./import-source-adapters.js";
import {
  urlImportIssuePreviewMessage,
  urlImportIssueText
} from "./import-source-model.js";

const importIssuePreviewMaxItems = 200;

function issuePreviewSuffix(totalCount: number, visibleCount: number) {
  if (visibleCount >= totalCount) return "";
  return visibleCount > 0
    ? `（仅显示前 ${visibleCount} 条）`
    : "（明细未显示）";
}

function parseErrorText(errors: JsonlManifestParseError[]) {
  return errors
    .map((error) => `第 ${error.line} 行：${error.error}\n${error.raw}`)
    .join("\n\n");
}

function weiboErrorText(errors: WeiboImportParseError[]) {
  return errors
    .map((error) => `第 ${error.line} 行：${error.error}\n${error.url}`)
    .join("\n\n");
}

function ImportIssuePreview({
  summary,
  copyLabel,
  getCopyText,
  items
}: {
  summary: string;
  copyLabel: string;
  getCopyText: () => string;
  items: Array<{ key: string; line: number; message: string }>;
}) {
  return (
    <div className="jsonl-preview">
      <div className="jsonl-preview-summary">
        <span>{summary}</span>
        <button
          type="button"
          className="button secondary"
          onClick={() => void copyTextToClipboard(
            getCopyText()
          ).catch(() => undefined)}
        >
          <AdminIcon name="file-copy-line" />{copyLabel}
        </button>
      </div>
      {items.length > 0 && (
        <ol className="jsonl-error-list">
          {items.slice(0, importIssuePreviewMaxItems).map((item) => (
            <li key={item.key}>
              <strong>第 {item.line} 行</strong>
              <span>{item.message}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function ImportSourceResultSummary({
  result
}: {
  result: ParsedImportSourceResult;
}) {
  const warning = result.submitCount === 0 || result.blockingIssueCount > 0;
  return (
    <p
      className={`hint import-source-result-summary${warning ? " is-warning" : ""}`}
      role="status"
      title={result.summary}
    >
      {result.summary}
    </p>
  );
}

export function ImportSourceResultPanel({
  result
}: {
  result: ParsedImportSourceResult;
}) {
  const urlIssues = result.mode === "urls"
    ? result.result.issues.filter((issue) => issue.type === "invalid")
    : [];
  const visibleUrlIssues = urlIssues.slice(0, importIssuePreviewMaxItems);
  const weiboErrors = result.mode === "weibo" ? result.result.errors : [];
  const visibleWeiboErrors = weiboErrors.slice(0, importIssuePreviewMaxItems);
  const manifest = result.mode === "jsonl"
    ? result.manifest
    : result.mode === "weibo"
      ? result.result.manifest
      : null;
  const manifestPreviewBudget = result.mode === "weibo"
    ? importIssuePreviewMaxItems - visibleWeiboErrors.length
    : importIssuePreviewMaxItems;
  const visibleManifestErrors = manifest?.errors.slice(
    0,
    manifestPreviewBudget
  ) ?? [];

  return (
    <>
      {urlIssues.length > 0 && (
        <ImportIssuePreview
          summary={`${urlIssues.length} 条链接已忽略${issuePreviewSuffix(
            urlIssues.length,
            visibleUrlIssues.length
          )}`}
          copyLabel={`复制 ${urlIssues.length} 条问题`}
          getCopyText={() => urlImportIssueText(urlIssues)}
          items={visibleUrlIssues.map((issue, index) => ({
            key: `${issue.line}:${issue.type}:${index}`,
            line: issue.line,
            message: urlImportIssuePreviewMessage(issue)
          }))}
        />
      )}
      {weiboErrors.length > 0 && (
        <ImportIssuePreview
          summary={`${weiboErrors.length} 条微博解析失败${issuePreviewSuffix(
            weiboErrors.length,
            visibleWeiboErrors.length
          )}`}
          copyLabel={`复制 ${weiboErrors.length} 条错误`}
          getCopyText={() => weiboErrorText(weiboErrors)}
          items={visibleWeiboErrors.map((error) => ({
            key: `${error.line}:${error.url}`,
            line: error.line,
            message: error.error
          }))}
        />
      )}
      {manifest && manifest.errors.length > 0 && (
        <ImportIssuePreview
          summary={`${manifest.errors.length} 条图片清单解析失败${issuePreviewSuffix(
            manifest.errors.length,
            visibleManifestErrors.length
          )}`}
          copyLabel={`复制 ${manifest.errors.length} 条错误`}
          getCopyText={() => parseErrorText(manifest.errors)}
          items={visibleManifestErrors.map((error) => ({
            key: String(error.line),
            line: error.line,
            message: error.error
          }))}
        />
      )}
    </>
  );
}
