import {
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject
} from "react";
import {
  AsyncActionButton,
  type AsyncActionPresentation
} from "../../../components/actions/AsyncActionButton.js";
import { DialogFrame } from "../../../components/dialog/DialogFrame.js";
import { FieldError } from "../../../components/form/FieldError.js";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import type { ImageEditorIntent, ImageEditorOpenResult } from "../../../components/image/editor/image-editor-capability-loader.js";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";
import { readEditableImageSnapshots } from "../../../lib/api/image-edit.js";
import {
  imageIdInputMaxItems,
  parseImageIdInput
} from "./image-id-input.js";
import type { EditableImageSnapshotDto } from "@imageshow/shared/browser";
import "../../../styles/admin/import-source-dialog.css";

type ParsedImageIds = {
  items: EditableImageSnapshotDto[];
  invalid: string[];
  missing: string[];
};

const intentPresentation = {
  edit: { icon: "pencil-line", heading: "编辑图片", action: "编辑" },
  delete: { icon: "delete-bin-line", heading: "删除图片", action: "删除" }
} as const;

/**
 * 按完整图片 ID 指定要编辑或删除的图片。快照接口只返回未删除的图片，其余 ID
 * 统一列为未找到或在回收站中；全部可用时直接交给编辑弹窗。
 */
export function ImageIdInputDialog({
  intent,
  onClose,
  onResolved,
  returnFocusRef
}: {
  intent: ImageEditorIntent;
  onClose: () => void;
  /** 打开编辑弹窗；成功时由调用方在同一次渲染中关闭本弹窗。 */
  onResolved: (items: EditableImageSnapshotDto[]) => Promise<ImageEditorOpenResult>;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const inputId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedImageIds | null>(null);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const parseAction = useAsyncActionStatus({
    minimumPendingMs: 0,
    resultDurationMs: null
  });
  const presentation = intentPresentation[intent];
  const issueCount = parsed ? parsed.invalid.length + parsed.missing.length : 0;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const issuesId = `${inputId}-issues`;
  const describedBy = [
    hintId,
    error ? errorId : "",
    issueCount ? issuesId : ""
  ].filter(Boolean).join(" ");

  useEffect(() => () => requestControllerRef.current?.abort(), []);

  const close = () => {
    requestControllerRef.current?.abort();
    onClose();
  };

  const openEditor = async (items: EditableImageSnapshotDto[]) => {
    setOpening(true);
    const result = await onResolved(items);
    if (result === "opened") return true;
    setOpening(false);
    setError(result === "failed"
      ? "编辑器加载失败，请重新加载页面"
      : "未能打开编辑弹窗，请关闭后重试");
    return false;
  };

  const changeText = (value: string) => {
    setText(value);
    setParsed(null);
    setError("");
  };

  const parse = async () => {
    const { ids, invalid } = parseImageIdInput(text);
    const termCount = ids.length + invalid.length;
    if (termCount > imageIdInputMaxItems) {
      setError(`已输入 ${termCount} 项，最多 ${imageIdInputMaxItems} 项，请拆分后再操作`);
      return false;
    }
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    setError("");
    try {
      const snapshots: EditableImageSnapshotDto[] = ids.length
        ? (await readEditableImageSnapshots(ids, controller.signal)).items
        : [];
      if (controller.signal.aborted) return false;
      const itemById = new Map(snapshots.map((item) => [item.id, item]));
      const items = ids.flatMap((id) => {
        const item = itemById.get(id);
        return item ? [item] : [];
      });
      const missing = ids.filter((id) => !itemById.has(id));
      if (items.length && !invalid.length && !missing.length) {
        return await openEditor(items);
      }
      setParsed({ items, invalid, missing });
      return true;
    } catch {
      if (!controller.signal.aborted) setError("图片读取失败，请稍后重试");
      return false;
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  };

  const submit = async () => {
    const items = parsed?.items;
    if (parsed && !items?.length) return;
    await parseAction.run(() => items ? openEditor(items) : parse());
  };

  const actionPresentation: AsyncActionPresentation = {
    // 与导入来源弹窗相同：数量用等宽占位，解析前后与数量变化时按钮宽度不变。
    idle: parsed
      ? {
          label: (
            <span className="import-source-submit-label">
              <span>{presentation.action}</span>
              <span className="import-source-submit-count">{parsed.items.length}</span>
              <span>张</span>
            </span>
          ),
          ariaLabel: `${presentation.action} ${parsed.items.length} 张`
        }
      : { icon: "search-line", label: "解析" },
    pending: opening
      ? { icon: presentation.icon, label: "打开中" }
      : { icon: "search-line", label: "解析中" },
    success: { icon: "check-line", label: "解析完成" },
    error: { icon: "close-line", label: "解析失败" }
  };

  return (
    <DialogFrame
      className="modal import-source-overlay"
      ariaLabel={presentation.heading}
      animateClose={false}
      busy={opening}
      initialFocusRef={inputRef}
      returnFocusRef={returnFocusRef}
      onClose={close}
    >
      {({ requestClose }) => (
        <>
          <div
            ref={cardRef}
            className="import-source-card"
            tabIndex={-1}
            aria-busy={parseAction.pending}
          >
            <div className="import-source-head">
              <h2>
                <AdminIcon name={presentation.icon} />
                {presentation.heading}
              </h2>
              <button
                type="button"
                className="icon close"
                title="关闭"
                disabled={opening}
                onClick={() => requestClose()}
              >
                <AdminIcon name="close-line" />
              </button>
            </div>
            <div className="import-source-panel">
              <p className="hint import-source-hint" id={hintId}>
                填写完整的图片 UUID，可用换行、空格或逗号分隔，最多 {imageIdInputMaxItems} 项。
              </p>
              <div className="import-source-input-region">
                <textarea
                  ref={inputRef}
                  id={inputId}
                  aria-label="图片 ID"
                  aria-describedby={describedBy}
                  className="import-source-textarea"
                  aria-invalid={Boolean(error) || issueCount > 0 || undefined}
                  value={text}
                  disabled={parseAction.pending}
                  onChange={(event) => changeText(event.target.value)}
                  placeholder="0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b"
                  rows={9}
                />
              </div>
              <FieldError id={errorId} message={error} announce />
              {parsed && issueCount > 0 && (
                <div className="import-issue-preview" id={issuesId}>
                  <div className="import-issue-preview-summary">
                    <span>{issueCount} 项不计入</span>
                  </div>
                  <ol className="import-issue-list">
                    {parsed.invalid.map((term) => (
                      <li key={`invalid:${term}`}>
                        <strong>{term}</strong>
                        <span>不是有效的图片 ID</span>
                      </li>
                    ))}
                    {parsed.missing.map((id) => (
                      <li key={`missing:${id}`}>
                        <strong>{id}</strong>
                        <span>未找到或在回收站中</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              <div className="import-source-actions">
                {parsed && (
                  <p
                    className={`hint import-source-result-summary${parsed.items.length ? "" : " is-warning"}`}
                    role="status"
                  >
                    {parsed.items.length
                      ? `找到 ${parsed.items.length} 张图片`
                      : "没有可用的图片"}
                  </p>
                )}
                <div className="import-source-action-buttons">
                  <button
                    type="button"
                    disabled={opening}
                    onClick={() => requestClose()}
                  >
                    取消
                  </button>
                  <AsyncActionButton
                    type="button"
                    className="button import-source-submit-button"
                    status={parseAction.status}
                    presentation={actionPresentation}
                    disabled={
                      parseAction.pending
                      || !text.trim()
                      || (parsed !== null && !parsed.items.length)
                    }
                    onClick={() => void submit()}
                  />
                </div>
              </div>
            </div>
          </div>
          <OverlayScrollbar targetRef={cardRef} />
        </>
      )}
    </DialogFrame>
  );
}
