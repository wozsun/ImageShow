import { useCallback, useRef, useState } from "react";
import { ConfirmDialog } from "../../../components/feedback/ConfirmDialog.js";
import { DialogFrame } from "../../../components/feedback/DialogFrame.js";
// 上传能力本身已经按需加载；不足 6 KiB（压缩后）的详情共享样式与逻辑留在
// 同一能力块，避免任务首击再产生一个懒加载边界。
import { ImageDetailModal } from "../../../components/image/ImageDetailModal.js";
import { ImagePreviewModal } from "../../../components/image/ImagePreviewModal.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { UploadWorkflowDefaults } from "./UploadWorkflowDefaults.js";
import { UploadWorkflowFooter } from "./UploadWorkflowFooter.js";
import { UploadWorkflowHeader } from "./UploadWorkflowHeader.js";
import { UploadWorkflowTaskList } from "./UploadWorkflowTaskList.js";
import type { UploadCleanupActionId } from "./upload-cleanup-actions.js";
import type { UploadWorkflowWindowController } from "./upload-workflow-controller.js";

export function UploadWorkflowWindow({
  controller
}: {
  controller: UploadWorkflowWindowController;
}) {
  const {
    mode,
    busy,
    queue,
    listRef,
    returnFocusRef,
    header,
    defaults,
    tasks,
    footer,
    overlays
  } = controller;
  const SourceDialog = overlays.source.component;
  const modeTitle = mode === "file" ? "上传图片" : "导入图片";
  const [pendingCleanupActionId, setPendingCleanupActionId] =
    useState<UploadCleanupActionId | null>(null);
  const cleanupReturnFocusRef = useRef<HTMLElement | null>(null);
  const cleanupActionsRef = useRef(header.cleanupActions);
  cleanupActionsRef.current = header.cleanupActions;
  const pendingCleanupAction = pendingCleanupActionId
    ? header.cleanupActions.find(
        (action) => action.id === pendingCleanupActionId
      )
    : undefined;

  const selectCleanupAction = useCallback(
    (
      actionId: UploadCleanupActionId,
      returnFocusTarget: HTMLElement
    ) => {
      const action = cleanupActionsRef.current.find(
        (candidate) => candidate.id === actionId
      );
      if (!action?.enabled) return;
      if (!action.confirmation) {
        action.run();
        return;
      }
      cleanupReturnFocusRef.current = returnFocusTarget;
      setPendingCleanupActionId(actionId);
    },
    []
  );

  const confirmCleanupAction = useCallback(async () => {
    const action = cleanupActionsRef.current.find(
      (candidate) => candidate.id === pendingCleanupActionId
    );
    if (!action?.confirmation || !action.enabled || action.count === 0) {
      return false;
    }
    action.run();
    return true;
  }, [pendingCleanupActionId]);

  return (
    <DialogFrame
      className="upload-overlay"
      ariaLabel={modeTitle}
      busy={busy}
      paused={Boolean(
        overlays.detail.item
        || overlays.preview.target
        || overlays.source.open
        || pendingCleanupActionId
      )}
      initialFocusRef={header.closeButtonRef}
      returnFocusRef={returnFocusRef}
      onClose={controller.onClose}
    >
      {({ requestClose }) => (
        <>
          <section
            className="upload-window image-workflow-window"
            tabIndex={-1}
          >
            <UploadWorkflowHeader
              mode={mode}
              busy={busy}
              queue={queue}
              jsonlErrorCount={tasks.jsonlErrors.length}
              controller={header}
              onSelectCleanup={selectCleanupAction}
              onRequestClose={requestClose}
            />
            <UploadWorkflowDefaults
              busy={busy}
              queue={queue}
              controller={defaults}
            />
            <UploadWorkflowTaskList
              mode={mode}
              busy={busy}
              queue={queue}
              listRef={listRef}
              sourceController={header}
              controller={tasks}
            />
            <UploadWorkflowFooter
              busy={busy}
              queue={queue}
              controller={footer}
              onRequestClose={requestClose}
            />
          </section>
          <OverlayScrollbar targetRef={listRef} />
          {overlays.detail.item && (
            <ImageDetailModal
              item={overlays.detail.item}
              admin
              storageLabel={tasks.storageName(
                overlays.detail.item.storage_slug
              )}
              onClose={overlays.detail.onClose}
              onDeleted={(imageId) => {
                overlays.detail.returnFocusRef.current = null;
                queue.removeLibraryDuplicate(imageId);
              }}
              returnFocusRef={overlays.detail.returnFocusRef}
            />
          )}
          {overlays.preview.target && (
            <ImagePreviewModal
              src={overlays.preview.target.src}
              thumbSrc={overlays.preview.target.thumbSrc}
              width={overlays.preview.target.width}
              height={overlays.preview.target.height}
              onClose={overlays.preview.onClose}
              returnFocusRef={overlays.preview.returnFocusRef}
            />
          )}
          {overlays.source.open && SourceDialog && (
            <SourceDialog
              initialMode={overlays.source.mode}
              autoImportAfterParse={overlays.source.autoImportAfterParse}
              maxItems={overlays.source.maxItems}
              weiboMaxItems={overlays.source.weiboMaxItems}
              onClose={overlays.source.onClose}
              onSubmit={overlays.source.onSubmit}
              returnFocusRef={overlays.source.returnFocusRef}
            />
          )}
          {pendingCleanupAction?.confirmation && (
            <ConfirmDialog
              title={pendingCleanupAction.confirmation.title}
              description={pendingCleanupAction.confirmation.description(
                pendingCleanupAction.count
              )}
              confirmLabel={pendingCleanupAction.confirmation.confirmLabel(
                pendingCleanupAction.count
              )}
              pendingLabel="清空中"
              successLabel="已清空"
              confirmDisabled={!pendingCleanupAction.enabled}
              closeOnBackdrop
              returnFocusRef={cleanupReturnFocusRef}
              onClose={() => setPendingCleanupActionId(null)}
              onConfirm={confirmCleanupAction}
            />
          )}
        </>
      )}
    </DialogFrame>
  );
}
