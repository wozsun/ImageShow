import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { LinkImportSplitButton } from "./link-import/LinkImportSplitButton.js";

export function UploaderTriggers({
  pending,
  onPreloadWorkflow,
  onPreloadLinkInput,
  onOpenWorkflow,
  onOpenUrls,
  onOpenJsonl,
  onOpenWeibo,
  onOpenFiles
}: {
  pending: boolean;
  onPreloadWorkflow: () => void;
  onPreloadLinkInput: () => void;
  onOpenWorkflow: (opener: HTMLButtonElement) => void;
  onOpenUrls: (opener: HTMLButtonElement) => void;
  onOpenJsonl: (opener: HTMLButtonElement) => void;
  onOpenWeibo: (opener: HTMLButtonElement) => void;
  onOpenFiles: (opener: HTMLButtonElement) => void;
}) {
  return (
    <div className="upload-triggers">
      <LinkImportSplitButton
        pending={pending}
        onPreloadWorkflow={onPreloadWorkflow}
        onPreloadLinkInput={onPreloadLinkInput}
        onOpenWorkflow={onOpenWorkflow}
        onOpenUrls={onOpenUrls}
        onOpenJsonl={onOpenJsonl}
        onOpenWeibo={onOpenWeibo}
      />
      <button
        className="button upload-trigger"
        type="button"
        disabled={pending}
        aria-busy={pending || undefined}
        onPointerEnter={onPreloadWorkflow}
        onFocus={onPreloadWorkflow}
        onPointerDown={onPreloadWorkflow}
        onClick={(event) => onOpenFiles(event.currentTarget)}
      >
        <AdminIcon name="upload-cloud-2-line" />上传图片
      </button>
    </div>
  );
}
