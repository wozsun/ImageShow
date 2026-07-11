import { useRef, useState } from "react";
import { Icon } from "../../../../components/icon/Icon.js";
import { SelectMenu } from "../../../../components/form/SelectMenu.js";
import { parseImportUrls } from "../import-job-utils.js";
import { parseImportJsonl, type JsonlManifestParseError, type JsonlManifestResult } from "../import-api.js";
import { linkInputLimitState, linkInputTextareaRows, type LinkInputMode } from "./link-input.js";
import { OverlayScrollbar } from "../../../../components/layout/OverlayScrollbar.js";

export type LinkImportMode = "download" | "proxy";
export type { LinkInputMode } from "./link-input.js";

export type LinkDialogSubmission =
  | { inputMode: "urls"; urls: string[]; mode: LinkImportMode }
  | { inputMode: "jsonl"; manifest: JsonlManifestResult; mode: LinkImportMode };

const modeOptions = [
  { value: "download", label: "下载图片" },
  { value: "proxy", label: "代理链接" }
] as const;

function parseErrorText(errors: JsonlManifestParseError[]) {
  return errors.map((error) => `第 ${error.line} 行：${error.error}\n${error.raw}`).join("\n\n");
}

export function LinkUrlDialog({ initialInputMode, urlListMaxItems, jsonlMaxItems, onClose, onSubmit }: {
  initialInputMode: LinkInputMode;
  urlListMaxItems: number;
  jsonlMaxItems: number;
  onClose: () => void;
  onSubmit: (submission: LinkDialogSubmission) => void;
}) {
  const importCardRef = useRef<HTMLDivElement | null>(null);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<LinkImportMode>("download");
  const [inputMode, setInputMode] = useState<LinkInputMode>(initialInputMode);
  const [manifest, setManifest] = useState<JsonlManifestResult | null>(null);
  const [parsedText, setParsedText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState("");
  const urls = inputMode === "urls" ? parseImportUrls(text) : [];
  const limitState = linkInputLimitState(inputMode, text, { urlList: urlListMaxItems, jsonl: jsonlMaxItems });
  const manifestCurrent = inputMode === "jsonl" && parsedText === text ? manifest : null;

  const changeText = (value: string) => {
    setText(value);
    setParseError("");
  };

  const changeInputMode = (value: LinkInputMode) => {
    setInputMode(value);
    setText("");
    setManifest(null);
    setParsedText("");
    setParseError("");
  };

  const submit = async () => {
    if (limitState.overLimit) {
      setParseError(`${inputMode === "urls" ? "URL 列表" : "JSONL 清单"}最多允许 ${limitState.maxItems} 条图片记录，请拆分后再导入`);
      return;
    }
    if (inputMode === "urls") {
      if (!urls.length) return;
      onSubmit({ inputMode, urls, mode });
      onClose();
      return;
    }
    if (!text.trim()) return;
    if (!manifestCurrent) {
      setParsing(true);
      setParseError("");
      try {
        const result = await parseImportJsonl(text);
        setManifest(result);
        setParsedText(text);
      } catch (error) {
        setParseError((error as Error).message);
      } finally {
        setParsing(false);
      }
      return;
    }
    if (!manifestCurrent.items.length) return;
    onSubmit({ inputMode, manifest: manifestCurrent, mode });
    onClose();
  };

  const submitCount = inputMode === "urls" ? urls.length : manifestCurrent?.items.length ?? 0;

  return (
    <div className="modal link-url-overlay">
      <div ref={importCardRef} className="link-import-card">
        <div className="link-import-head">
          <h2><Icon name={inputMode === "jsonl" ? "file-copy-line" : "download-cloud-2-line"} />{inputMode === "jsonl" ? "批量导入" : "导入链接"}</h2>
          <div className="link-import-head-status">
            <button type="button" className="icon close" title="关闭" onClick={onClose}>
              <Icon name="close-line" />
            </button>
          </div>
        </div>
        <div className="link-input-tabs" role="tablist" aria-label="输入模式">
          <button type="button" role="tab" aria-selected={inputMode === "urls"} className={inputMode === "urls" ? "is-active" : ""} onClick={() => changeInputMode("urls")}>URL 列表</button>
          <button type="button" role="tab" aria-selected={inputMode === "jsonl"} className={inputMode === "jsonl" ? "is-active" : ""} onClick={() => changeInputMode("jsonl")}>JSONL 清单</button>
        </div>
        <p className="hint link-input-hint">
          {inputMode === "jsonl"
            ? `每行一个 JSON，最多 ${jsonlMaxItems} 条；行内字段优先于“应用到全部”。`
            : `每行一个 URL，最多 ${urlListMaxItems} 条；缺省元数据项使用“应用到全部”。`}
        </p>
        <textarea
          className="link-import-urls"
          value={text}
          onChange={(event) => changeText(event.target.value)}
          placeholder={inputMode === "jsonl"
            ? '{"original":"https://img.example.com/a.jpg","source":"https://example.com/post/1","image_time":"2020-05-01T00:00:00+08:00","tags":["2020"]}'
            : "https://example.com/a.jpg\nhttps://example.com/b.png"}
          rows={linkInputTextareaRows}
        />
        {(parseError || limitState.overLimit) && (
          <p className="form-error">
            {parseError || `已输入 ${limitState.count} 条，最多允许 ${limitState.maxItems} 条，请拆分后再导入`}
          </p>
        )}
        {manifestCurrent && manifestCurrent.errors.length > 0 && (
          <div className="jsonl-preview">
            <div className="jsonl-preview-summary">
              <span>{manifestCurrent.errors.length} 条解析失败</span>
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
            <button type="button" onClick={onClose}>取消</button>
            <button type="button" className="button" disabled={parsing || limitState.overLimit || (inputMode === "urls" ? !urls.length : !text.trim() || Boolean(manifestCurrent && !manifestCurrent.items.length))} onClick={() => void submit()}>
              <Icon name={inputMode === "jsonl" ? "file-copy-line" : "download-cloud-2-line"} />
              {parsing ? "解析中" : inputMode === "jsonl" && !manifestCurrent ? "解析清单" : `导入${submitCount ? ` ${submitCount} 个` : ""}`}
            </button>
          </div>
        </div>
      </div>
      <OverlayScrollbar targetRef={importCardRef} />
    </div>
  );
}
