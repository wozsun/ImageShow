import { StableButtonLabel } from "../../../components/data-display/StableButtonLabel.js";
import { SelectMenu } from "../../../components/form/SelectMenu.js";
import { AdminPagination } from "../../../components/navigation/AdminPagination.js";
import type {
  UploadWorkflowFooterController,
  UploadWorkflowWindowController
} from "./upload-workflow-controller.js";

export function UploadWorkflowFooter({
  busy,
  queue,
  controller,
  onRequestClose
}: {
  busy: boolean;
  queue: UploadWorkflowWindowController["queue"];
  controller: UploadWorkflowFooterController;
  onRequestClose: () => void;
}) {
  const readyJobs = queue.summary.readyJobs;
  return (
    <footer
      className={`image-workflow-footer${
        queue.totalPages > 1 ? " has-pagination" : ""
      }`}
    >
      <div className="upload-footer-left image-workflow-leading-actions">
        <div className="upload-backend">
          <SelectMenu
            className="is-storage-select"
            value={controller.activeBackend}
            onChange={controller.onBackendChange}
            options={controller.backendOptions}
            ariaLabel="新任务存储位置"
          />
        </div>
        <small className="upload-storage-hint">仅影响之后添加的新任务</small>
      </div>
      {queue.totalPages > 1 && (
        <AdminPagination
          className="image-workflow-pagination"
          ariaLabel="导入任务列表分页"
          page={queue.page}
          totalPages={queue.totalPages}
          onPageChange={queue.setPage}
        />
      )}
      <div className="modal-footer-actions">
        <button
          type="button"
          onClick={() => void controller.onCancelAll().then(onRequestClose)}
          disabled={busy}
        >
          取消
        </button>
        <button
          className="button workflow-submit-button"
          type="button"
          disabled={!readyJobs.length || busy}
          onClick={controller.onCommitReady}
        >
          <StableButtonLabel
            idle={readyJobs.length ? `提交 ${readyJobs.length} 张` : "提交"}
            busyText="提交中"
            busy={busy}
          />
        </button>
      </div>
    </footer>
  );
}
