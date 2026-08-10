import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { UploadCleanupMenu } from "./UploadCleanupMenu.js";
import { UploadWorkflowSourcePicker } from "./UploadWorkflowSourcePicker.js";
import type { UploadCleanupActionId } from "./upload-cleanup-actions.js";
import type {
  UploadWorkflowHeaderController,
  UploadWorkflowWindowController
} from "./upload-workflow-controller.js";

export function UploadWorkflowHeader({
  mode,
  busy,
  queue,
  jsonlErrorCount,
  controller,
  onSelectCleanup,
  onRequestClose
}: {
  mode: UploadWorkflowWindowController["mode"];
  busy: boolean;
  queue: UploadWorkflowWindowController["queue"];
  jsonlErrorCount: number;
  controller: UploadWorkflowHeaderController;
  onSelectCleanup: (
    actionId: UploadCleanupActionId,
    returnFocusTarget: HTMLElement
  ) => void;
  onRequestClose: () => void;
}) {
  const {
    readyJobs,
    duplicateJobs,
    runningJobs,
    doneJobs,
    failedJobs
  } = queue.summary;
  const modeTitle = mode === "file" ? "上传图片" : "导入图片";
  const emptySubtitle = mode === "file"
    ? "选择后立即上传并在服务端准备图片"
    : "输入来源后立即创建并准备图片任务";

  return (
    <header className="upload-window-header">
      <div className="upload-head-copy">
        <h1>{modeTitle}</h1>
        {queue.jobs.length ? (
          <p className="upload-task-summary">
            <span className="upload-summary-primary">
              共 {queue.jobs.length} 张图片，{runningJobs} 张处理中，
              {readyJobs.length} 张待提交；
            </span>
            <span className="upload-summary-secondary">
              {doneJobs} 张成功，{failedJobs} 张失败，
              {duplicateJobs} 张重复待确认
              {jsonlErrorCount ? `，${jsonlErrorCount} 行解析失败` : ""}
            </span>
          </p>
        ) : (
          <p className="upload-empty-subtitle">{emptySubtitle}</p>
        )}
      </div>
      <div className="upload-head-actions">
        <div className="upload-clear-actions">
          {controller.cleanupActions.map((action) => (
            <button
              key={action.id}
              type="button"
              className="clear-button"
              disabled={!action.enabled}
              onClick={(event) => {
                onSelectCleanup(action.id, event.currentTarget);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
        <div className="upload-primary-actions">
          <UploadCleanupMenu
            actions={controller.cleanupActions}
            onSelect={onSelectCleanup}
          />
          <UploadWorkflowSourcePicker
            mode={mode}
            busy={busy}
            controller={controller}
          />
          <button
            ref={controller.closeButtonRef}
            className="icon close pressable upload-close-button"
            type="button"
            title="关闭"
            onClick={() => onRequestClose()}
            disabled={busy}
          >
            <AdminIcon name="close-line" />
          </button>
        </div>
      </div>
    </header>
  );
}
