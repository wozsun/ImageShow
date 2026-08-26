import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject
} from "react";
import {
  AsyncActionButton,
  type AsyncActionPresentation
} from "../../../../components/actions/AsyncActionButton.js";
import { DialogFrame } from "../../../../components/feedback/DialogFrame.js";
import { AdminIcon } from "../../../../components/icon/AdminIcon.js";
import { OverlayScrollbar } from "../../../../components/layout/OverlayScrollbar.js";
import { useAsyncActionStatus } from "../../../../hooks/useAsyncActionStatus.js";
import {
  mobileViewportMediaQuery,
  useMediaQuery
} from "../../../../hooks/useMediaQuery.js";
import {
  importSourceModeAdapters,
  type ImportSourceSubmission,
  type ParsedImportSourceResult
} from "./import-source-adapters.js";
import {
  importSourceLimitState,
  importSourceTextareaRows,
  type ImportSourceMode
} from "./import-source-model.js";
import {
  ImportSourceResultPanel,
  ImportSourceResultSummary
} from "./ImportSourceResultPanel.js";
import { parseImportUrlInput } from "../queue/model/ingestion-job-utils.js";

export type { ImportSourceSubmission } from "./import-source-adapters.js";
export type { ImportSourceMode } from "./import-source-model.js";

const importSourceModes: ImportSourceMode[] = ["urls", "jsonl", "weibo"];

export function ImportSourceDialog({
  initialMode,
  autoImportAfterParse,
  maxItems,
  weiboMaxItems,
  onClose,
  onSubmit,
  returnFocusRef
}: {
  initialMode: ImportSourceMode;
  autoImportAfterParse: boolean;
  maxItems: number;
  weiboMaxItems: number;
  onClose: () => void;
  onSubmit: (submission: ImportSourceSubmission) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const inputId = useId();
  const importCardRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const submittedRef = useRef(false);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<ImportSourceMode>(initialMode);
  const [parsedResult, setParsedResult] =
    useState<ParsedImportSourceResult | null>(null);
  const [parseError, setParseError] = useState("");
  const parseAction = useAsyncActionStatus({
    minimumPendingMs: 0,
    resultDurationMs: null
  });
  const mobileLayout = useMediaQuery(mobileViewportMediaQuery);
  const adapter = importSourceModeAdapters[mode];
  const urlParseResult = useMemo(
    () => mode === "urls" ? parseImportUrlInput(text) : undefined,
    [mode, text]
  );
  const limitState = importSourceLimitState(
    mode,
    text,
    { link: maxItems, weibo: weiboMaxItems },
    urlParseResult
  );
  const readyToImport = parsedResult !== null;
  const parsedWithoutItems = Boolean(
    parsedResult && parsedResult.submitCount === 0
  );

  const close = () => {
    requestControllerRef.current?.abort();
    onClose();
  };

  useEffect(() => () => requestControllerRef.current?.abort(), []);

  const resetParsedResult = () => {
    setParsedResult(null);
    setParseError("");
  };

  const changeText = (value: string) => {
    setText(value);
    resetParsedResult();
  };

  const changeMode = (nextMode: ImportSourceMode) => {
    if (nextMode === mode) {
      inputRef.current?.focus();
      return;
    }
    setMode(nextMode);
    setText("");
    resetParsedResult();
    inputRef.current?.focus();
  };

  const parseInput = async () => {
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    setParseError("");
    try {
      const result = await adapter.parse(
        text,
        controller.signal,
        urlParseResult
      );
      if (controller.signal.aborted) return null;
      setParsedResult(result);
      return result;
    } catch (error) {
      if (!controller.signal.aborted) {
        setParseError((error as Error).message);
      }
      return null;
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  };

  const importSubmission = (
    submission: ImportSourceSubmission,
    requestClose: () => void
  ) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onSubmit(submission);
    requestClose();
  };

  const importParsedResultWhenEnabled = (
    result: ParsedImportSourceResult,
    requestClose: () => void
  ) => {
    if (
      !autoImportAfterParse
      || result.blockingIssueCount > 0
      || !result.submission
    ) {
      return;
    }
    importSubmission(result.submission, requestClose);
  };

  const submit = async (requestClose: () => void) => {
    if (limitState.overLimit) {
      setParseError(
        `${adapter.presentation.label}最多允许 ${limitState.maxItems} 条，请拆分后再导入`
      );
      return;
    }
    if (!readyToImport) {
      let nextResult: ParsedImportSourceResult | null = null;
      const parsed = await parseAction.run(async () => {
        nextResult = await parseInput();
        return nextResult !== null;
      });
      if (parsed && nextResult) {
        importParsedResultWhenEnabled(nextResult, requestClose);
      }
      return;
    }
    if (parsedResult?.submission) {
      importSubmission(parsedResult.submission, requestClose);
    }
  };

  const idleActionPresentation: AsyncActionPresentation["idle"] =
    parsedWithoutItems
      ? { label: adapter.emptySubmitText }
      : parsedResult
        ? {
            label: (
              <span className="import-source-submit-label">
                <span>导入</span>
                <span className="import-source-submit-count">
                  {parsedResult.submitCount}
                </span>
                <span>张</span>
              </span>
            ),
            ariaLabel: `导入 ${parsedResult.submitCount} 张`
          }
        : {
            icon: adapter.presentation.icon,
            label: adapter.parseText
          };
  const actionPresentation: AsyncActionPresentation = {
    idle: idleActionPresentation,
    pending: { icon: adapter.presentation.icon, label: "解析中" },
    success: { icon: "check-line", label: "解析完成" },
    error: { icon: "close-line", label: "解析失败" }
  };

  return (
    <DialogFrame
      className="modal import-source-overlay"
      ariaLabel="导入来源输入"
      animateClose={false}
      initialFocusRef={inputRef}
      returnFocusRef={returnFocusRef}
      onClose={close}
    >
      {({ requestClose }) => (
        <>
          <div
            ref={importCardRef}
            className="import-source-card"
            tabIndex={-1}
            aria-busy={parseAction.pending}
          >
            <div className="import-source-head">
              <h2>
                <AdminIcon name={adapter.presentation.icon} />
                {adapter.presentation.heading}
              </h2>
              <button
                type="button"
                className="icon close"
                title="关闭"
                onClick={() => requestClose()}
              >
                <AdminIcon name="close-line" />
              </button>
            </div>
            <div
              className="import-source-tabs"
              role="tablist"
              aria-label="输入模式"
            >
              {importSourceModes.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  disabled={parseAction.pending}
                  aria-selected={mode === value}
                  className={mode === value ? "is-active" : ""}
                  onClick={() => changeMode(value)}
                >
                  {importSourceModeAdapters[value].presentation.label}
                </button>
              ))}
            </div>
            <p className="hint import-source-hint">
              {adapter.hint(limitState.maxItems)}
            </p>
            <div
              className={`import-source-input-region${parsedResult ? " has-result-summary" : ""}`}
            >
              <textarea
                ref={inputRef}
                id={inputId}
                className="import-source-textarea"
                value={text}
                disabled={parseAction.pending}
                onChange={(event) => changeText(event.target.value)}
                placeholder={adapter.presentation.placeholder}
                rows={importSourceTextareaRows}
              />
              {mobileLayout && parsedResult && (
                <ImportSourceResultSummary result={parsedResult} />
              )}
            </div>
            {(parseError || limitState.overLimit) && (
              <p
                className="form-error"
                role="alert"
                title={parseError || undefined}
              >
                {parseError || (
                  `已输入 ${limitState.count} 条，最多允许 ${limitState.maxItems} 条，请拆分后再导入`
                )}
              </p>
            )}
            {parsedResult && (
              <ImportSourceResultPanel result={parsedResult} />
            )}
            <div className="import-source-actions">
              {!mobileLayout && parsedResult && (
                <ImportSourceResultSummary result={parsedResult} />
              )}
              <div className="import-source-action-buttons">
                <button type="button" onClick={() => requestClose()}>
                  取消
                </button>
                <AsyncActionButton
                  type="button"
                  className="button import-source-submit-button"
                  status={parseAction.status}
                  presentation={actionPresentation}
                  disabled={
                    parseAction.pending
                    || limitState.overLimit
                    || !adapter.hasInput(text)
                    || parsedWithoutItems
                  }
                  onClick={() => void submit(requestClose)}
                />
              </div>
            </div>
          </div>
          <OverlayScrollbar targetRef={importCardRef} />
        </>
      )}
    </DialogFrame>
  );
}
