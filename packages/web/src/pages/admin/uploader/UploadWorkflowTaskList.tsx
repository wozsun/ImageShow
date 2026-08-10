import type { RefObject } from "react";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { copyTextToClipboard } from "../../../lib/ui/clipboard.js";
import { preloadIntentProps } from "../../../lib/ui/preload-intent.js";
import { ImportJobList } from "./ImportJobList.js";
import type {
  UploadWorkflowHeaderController,
  UploadWorkflowTasksController,
  UploadWorkflowWindowController
} from "./upload-workflow-controller.js";

export function UploadWorkflowTaskList({
  mode,
  busy,
  queue,
  listRef,
  sourceController,
  controller
}: {
  mode: UploadWorkflowWindowController["mode"];
  busy: boolean;
  queue: UploadWorkflowWindowController["queue"];
  listRef: RefObject<HTMLDivElement | null>;
  sourceController: UploadWorkflowHeaderController;
  controller: UploadWorkflowTasksController;
}) {
  return (
    <div
      className="modal-scroll-list image-workflow-list upload-list"
      ref={listRef}
    >
      {controller.jsonlErrors.length > 0 && (
        <div className="jsonl-import-report">
          <span>{controller.jsonlErrors.length} 行未创建任务</span>
          <button
            type="button"
            onClick={() => void copyTextToClipboard(
              controller.jsonlErrors
                .map((error) => (
                  `第 ${error.line} 行：${error.error}\n${error.raw}`
                ))
                .join("\n\n")
            ).catch(() => undefined)}
          >
            <AdminIcon name="file-copy-line" />复制错误
          </button>
          <button type="button" onClick={controller.onClearJsonlErrors}>
            清除
          </button>
        </div>
      )}
      <ImportJobList
        jobs={queue.visibleJobs}
        allJobs={queue.jobs}
        busy={busy}
        storageName={controller.storageName}
        themes={controller.themes}
        tags={controller.tags}
        authors={controller.authors}
        onPatch={controller.onPatchJob}
        onCancel={controller.onCancelJob}
        onRetry={controller.onRetryJob}
        onRemove={controller.onRemoveJob}
        onConfirmDuplicate={controller.onConfirmDuplicateJob}
        onOpenDetail={controller.onOpenDetail}
        onPreview={controller.onOpenPreview}
      />
      {!queue.jobs.length && (mode === "link" ? (
        <button
          type="button"
          className="upload-empty-state upload-dropzone"
          disabled={sourceController.source.pending}
          {...preloadIntentProps(sourceController.source.onPreload)}
          onClick={() => sourceController.source.onOpen("urls")}
        >
          <AdminIcon name="download-cloud-2-line" />
          <span>还没有导入任务，点击此处选择图片来源</span>
        </button>
      ) : (
        <button
          type="button"
          className={`upload-empty-state upload-dropzone${
            controller.dragOver ? " is-dragover" : ""
          }`}
          onClick={() => sourceController.file.inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            controller.onDragOverChange(true);
          }}
          onDragLeave={() => controller.onDragOverChange(false)}
          onDrop={(event) => {
            event.preventDefault();
            controller.onDragOverChange(false);
            controller.onAddFiles(event.dataTransfer.files);
          }}
        >
          <AdminIcon name="image-line" />
          <span>还没有选择图片，点击此处选择，或将图片拖到这里</span>
        </button>
      ))}
    </div>
  );
}
