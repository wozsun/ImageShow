import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Icon, type IconName } from "../../../../components/icon/Icon.js";
import { SelectMenu } from "../../../../components/form/SelectMenu.js";
import { OverlayScrollbar } from "../../../../components/layout/OverlayScrollbar.js";
import { useDialogFocus } from "../../../../hooks/useDialogFocus.js";
import { parseImportUrlInput, type ImportUrlParseResult } from "../import-job-utils.js";
import {
  parseImportJsonl,
  parseWeiboImport,
  type JsonlManifestParseError,
  type JsonlManifestResult,
  type WeiboImportParseError,
  type WeiboImportResult
} from "../import-api.js";
import {
  formatUrlImportSummary,
  linkInputLimitState,
  linkInputTextareaRows,
  parseWeiboImportLines,
  type LinkInputMode
} from "./link-input.js";

export type LinkImportMode = "download" | "proxy";
export type { LinkInputMode } from "./link-input.js";

export type LinkDialogSubmission =
  | { inputMode: "urls"; urls: string[]; mode: LinkImportMode }
  | { inputMode: "jsonl"; manifest: JsonlManifestResult; mode: LinkImportMode }
  | { inputMode: "weibo"; result: WeiboImportResult; mode: LinkImportMode };

const modeOptions = [
  { value: "download", label: "下载图片" },
  { value: "proxy", label: "代理链接" }
] as const;

const inputModePresentation: Record<LinkInputMode, {
  heading: string;
  icon: IconName;
  label: string;
  placeholder: string;
}> = {
  urls: {
    heading: "链接导入",
    icon: "link",
    label: "URL 列表",
    placeholder: "https://example.com/a.jpg\nhttps://example.com/b.png"
  },
  jsonl: {
    heading: "清单导入",
    icon: "file-list-line",
    label: "JSONL 清单",
    placeholder: '{"original":"https://img.example.com/a.jpg","source":"https://example.com/post/1","image_time":"2020-05-01T00:00:00+08:00","tags":["2020"]}'
  },
  weibo: {
    heading: "微博导入",
    icon: "weibo-line",
    label: "微博链接",
    placeholder: "https://weibo.com/用户ID/微博短码\nhttps://weibo.com/用户ID/另一条微博"
  }
};

function parseErrorText(errors: JsonlManifestParseError[]) {
  return errors.map((error) => `第 ${error.line} 行：${error.error}\n${error.raw}`).join("\n\n");
}

function weiboErrorText(errors: WeiboImportParseError[]) {
  return errors.map((error) => `第 ${error.line} 行：${error.error}\n${error.url}`).join("\n\n");
}

export function LinkUrlDialog({ initialInputMode, maxItems, weiboMaxItems, onClose, onSubmit, returnFocusRef }: {
  initialInputMode: LinkInputMode;
  maxItems: number;
  weiboMaxItems: number;
  onClose: () => void;
  onSubmit: (submission: LinkDialogSubmission) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const inputId = useId();
  const importCardRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<LinkImportMode>("download");
  const [inputMode, setInputMode] = useState<LinkInputMode>(initialInputMode);
  const [urlParseResult, setUrlParseResult] = useState<ImportUrlParseResult | null>(null);
  const [jsonlManifest, setJsonlManifest] = useState<JsonlManifestResult | null>(null);
  const [weiboResult, setWeiboResult] = useState<WeiboImportResult | null>(null);
  const [parsedText, setParsedText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");

  const close = () => {
    requestControllerRef.current?.abort();
    onClose();
  };

  useDialogFocus({
    containerRef: importCardRef,
    initialFocusRef: closeButtonRef,
    returnFocusRef,
    onEscape: close,
  });
  useEffect(() => () => requestControllerRef.current?.abort(), []);

  const weiboInputLines = inputMode === "weibo" ? parseWeiboImportLines(text) : [];
  const weiboUrls = weiboInputLines.map((entry) => entry.url);
  const urlParseResultCurrent = inputMode === "urls" && parsedText === text
    ? urlParseResult
    : null;
  const jsonlManifestCurrent = inputMode === "jsonl" && parsedText === text
    ? jsonlManifest
    : null;
  const weiboResultCurrent = inputMode === "weibo" && parsedText === text
    ? weiboResult
    : null;
  const limitState = linkInputLimitState(inputMode, text, {
    link: maxItems,
    weibo: weiboMaxItems
  }, urlParseResultCurrent);
  const manifestCurrent = jsonlManifestCurrent ?? weiboResultCurrent?.manifest ?? null;
  const presentation = inputModePresentation[inputMode];
  const noValidUrls = Boolean(urlParseResultCurrent && !urlParseResultCurrent.urls.length);
  const resultSummary = urlParseResultCurrent
    ? noValidUrls
      ? "没有可导入的有效链接"
      : formatUrlImportSummary(urlParseResultCurrent)
    : weiboResultCurrent
      ? `已解析 ${weiboResultCurrent.posts.length} 条微博，共 ${weiboResultCurrent.manifest.items.length} 张可导入图片`
      : "";

  const resetParsedResult = () => {
    setUrlParseResult(null);
    setJsonlManifest(null);
    setWeiboResult(null);
    setParsedText("");
    setParseError("");
  };

  const changeText = (value: string) => {
    setText(value);
    resetParsedResult();
  };

  const changeInputMode = (value: LinkInputMode) => {
    setInputMode(value);
    setText("");
    resetParsedResult();
  };

  const parseInput = async () => {
    if (inputMode === "urls") {
      setParseError("");
      setUrlParseResult(parseImportUrlInput(text));
      setParsedText(text);
      return;
    }

    const controller = new AbortController();
    requestControllerRef.current = controller;
    setParsing(true);
    setParseError("");
    try {
      if (inputMode === "jsonl") {
        setJsonlManifest(await parseImportJsonl(text, controller.signal));
      } else if (inputMode === "weibo") {
        const result = await parseWeiboImport(weiboUrls, controller.signal);
        setWeiboResult({
          ...result,
          errors: result.errors.map((error) => ({
            ...error,
            line: weiboInputLines[error.line - 1]?.line ?? error.line
          }))
        });
      }
      if (!controller.signal.aborted) setParsedText(text);
    } catch (error) {
      if (!controller.signal.aborted) setParseError((error as Error).message);
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
      if (!controller.signal.aborted) setParsing(false);
    }
  };

  const submit = async () => {
    if (limitState.overLimit) {
      setParseError(`${presentation.label}最多允许 ${limitState.maxItems} 条，请拆分后再导入`);
      return;
    }
    if (inputMode === "urls") {
      if (!urlParseResultCurrent) {
        await parseInput();
        return;
      }
      if (!urlParseResultCurrent.urls.length) return;
      onSubmit({ inputMode, urls: urlParseResultCurrent.urls, mode });
      close();
      return;
    }
    if (!text.trim()) return;
    if (!manifestCurrent) {
      await parseInput();
      return;
    }
    if (!manifestCurrent.items.length) return;
    if (inputMode === "jsonl" && jsonlManifestCurrent) {
      onSubmit({ inputMode, manifest: jsonlManifestCurrent, mode });
    }
    if (inputMode === "weibo" && weiboResultCurrent) {
      onSubmit({ inputMode, result: weiboResultCurrent, mode });
    }
    close();
  };

  const submitCount = inputMode === "urls"
    ? urlParseResultCurrent?.urls.length ?? 0
    : manifestCurrent?.items.length ?? 0;
  const readyToImport = inputMode === "urls"
    ? Boolean(urlParseResultCurrent)
    : Boolean(manifestCurrent);
  const missingInput = inputMode === "urls"
    ? !text.trim()
    : inputMode === "weibo"
      ? !weiboUrls.length
      : !text.trim();
  const parsedWithoutItems = inputMode === "urls"
    ? Boolean(urlParseResultCurrent && !urlParseResultCurrent.urls.length)
    : Boolean(manifestCurrent && !manifestCurrent.items.length);
  const submitText = parsing
    ? "解析中"
    : inputMode === "urls" && !urlParseResultCurrent
      ? "解析链接"
      : inputMode === "jsonl" && !jsonlManifestCurrent
        ? "解析清单"
        : inputMode === "weibo" && !weiboResultCurrent
          ? "解析微博"
          : `导入${submitCount ? ` ${submitCount} 张` : ""}`;

  return (
    <div className="modal link-url-overlay" role="dialog" aria-modal="true" aria-label="导入内容输入">
      <div ref={importCardRef} className="link-import-card" tabIndex={-1} aria-busy={parsing}>
        <div className="link-import-head">
          <h2><Icon name={presentation.icon} />{presentation.heading}</h2>
          <div className="link-import-head-status">
            {parsing && <span>{inputMode === "weibo" ? "正在获取微博内容…" : "正在解析清单…"}</span>}
            <button ref={closeButtonRef} type="button" className="icon close" title="关闭" onClick={close}>
              <Icon name="close-line" />
            </button>
          </div>
        </div>
        <div className="link-input-tabs" role="tablist" aria-label="输入模式">
          {(["urls", "jsonl", "weibo"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              disabled={parsing}
              aria-selected={inputMode === value}
              className={inputMode === value ? "is-active" : ""}
              onClick={() => changeInputMode(value)}
            >
              {inputModePresentation[value].label}
            </button>
          ))}
        </div>
        <p className="hint link-input-hint">
          {inputMode === "jsonl"
            ? `每行一个 JSON，最多 ${maxItems} 条；行内字段优先于当前默认属性，创建任务后可批量修改。`
            : inputMode === "weibo"
              ? `每行一条公开微博链接，最多 ${weiboMaxItems} 条；默认使用微博元数据，创建任务后可批量修改。`
              : `每行一个 URL，最多 ${maxItems} 条；缺省元数据项使用当前默认属性。`}
        </p>
        <div className={`link-import-input-region${resultSummary ? " has-result-summary" : ""}`}>
          <textarea
            id={inputId}
            className="link-import-urls"
            value={text}
            disabled={parsing}
            onChange={(event) => changeText(event.target.value)}
            placeholder={presentation.placeholder}
            rows={linkInputTextareaRows}
          />
          {resultSummary && (
            <p
              className={`hint link-import-result-summary${noValidUrls ? " is-warning" : ""}`}
              role="status"
            >
              {resultSummary}
            </p>
          )}
        </div>
        {(parseError || limitState.overLimit) && (
          <p className="form-error">
            {parseError || `已输入 ${limitState.count} 条，最多允许 ${limitState.maxItems} 条，请拆分后再导入`}
          </p>
        )}
        {weiboResultCurrent && weiboResultCurrent.errors.length > 0 && (
          <div className="jsonl-preview">
            <div className="jsonl-preview-summary">
              <span>{weiboResultCurrent.errors.length} 条微博解析失败</span>
              <button type="button" className="button secondary" onClick={() => void navigator.clipboard.writeText(weiboErrorText(weiboResultCurrent.errors)).catch(() => undefined)}>
                <Icon name="file-copy-line" />复制 {weiboResultCurrent.errors.length} 条错误
              </button>
            </div>
            <ol className="jsonl-error-list">
              {weiboResultCurrent.errors.map((error) => <li key={`${error.line}:${error.url}`}><strong>第 {error.line} 行</strong><span>{error.error}</span></li>)}
            </ol>
          </div>
        )}
        {manifestCurrent && manifestCurrent.errors.length > 0 && (
          <div className="jsonl-preview">
            <div className="jsonl-preview-summary">
              <span>{manifestCurrent.errors.length} 条图片清单解析失败</span>
              <button type="button" className="button secondary" onClick={() => void navigator.clipboard.writeText(parseErrorText(manifestCurrent.errors)).catch(() => undefined)}>
                <Icon name="file-copy-line" />复制 {manifestCurrent.errors.length} 条错误
              </button>
            </div>
            <ol className="jsonl-error-list">
              {manifestCurrent.errors.map((error) => <li key={error.line}><strong>第 {error.line} 行</strong><span>{error.error}</span></li>)}
            </ol>
          </div>
        )}
        <p className="hint link-import-mode-hint">
          {mode === "download"
            ? "下载图片：服务端下载、压缩并保存图片，原始下载数据不会保留。"
            : "代理链接：仅保存缩略图和外链，查看图片时由服务端代理访问。"}
        </p>
        <div className="link-import-actions">
          <SelectMenu
            className="link-import-mode"
            value={mode}
            onChange={(value) => setMode(value as LinkImportMode)}
            options={modeOptions}
            ariaLabel="链接导入模式"
          />
          <div className="link-import-action-buttons">
            <button type="button" onClick={close}>取消</button>
            <button
              type="button"
              className="button link-import-submit-button"
              disabled={parsing || limitState.overLimit || missingInput || parsedWithoutItems}
              onClick={() => void submit()}
            >
              {!readyToImport && <Icon name={presentation.icon} />}
              {readyToImport ? (
                <span className="link-import-submit-label">
                  <span>导入</span>
                  <span className="link-import-submit-count">{submitCount}</span>
                  <span>张</span>
                </span>
              ) : submitText}
            </button>
          </div>
        </div>
      </div>
      <OverlayScrollbar targetRef={importCardRef} />
    </div>
  );
}
