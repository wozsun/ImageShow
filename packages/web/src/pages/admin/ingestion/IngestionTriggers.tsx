import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { preloadIntentProps } from "../../../lib/ui/preload-intent.js";
import { ImportSplitButton } from "./import/ImportSplitButton.js";

export function IngestionTriggers({
  pending,
  onPreloadWorkflow,
  onPreloadImportSource,
  onOpenWorkflow,
  onOpenUrls,
  onOpenJsonl,
  onOpenWeibo,
  onOpenFiles
}: {
  pending: boolean;
  onPreloadWorkflow: () => void;
  onPreloadImportSource: () => void;
  onOpenWorkflow: (opener: HTMLButtonElement) => void;
  onOpenUrls: (opener: HTMLButtonElement) => void;
  onOpenJsonl: (opener: HTMLButtonElement) => void;
  onOpenWeibo: (opener: HTMLButtonElement) => void;
  onOpenFiles: (opener: HTMLButtonElement) => void;
}) {
  return (
    <div className="ingestion-triggers">
      <ImportSplitButton
        pending={pending}
        onPreloadWorkflow={onPreloadWorkflow}
        onPreloadImportSource={onPreloadImportSource}
        onOpenWorkflow={onOpenWorkflow}
        onOpenUrls={onOpenUrls}
        onOpenJsonl={onOpenJsonl}
        onOpenWeibo={onOpenWeibo}
      />
      <button
        className="button ingestion-trigger"
        type="button"
        disabled={pending}
        aria-busy={pending || undefined}
        {...preloadIntentProps(onPreloadWorkflow)}
        onClick={(event) => onOpenFiles(event.currentTarget)}
      >
        <AdminIcon name="upload-cloud-2-line" />上传图片
      </button>
    </div>
  );
}
