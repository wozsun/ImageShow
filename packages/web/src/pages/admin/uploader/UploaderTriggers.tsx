import { Icon } from "../../../components/icon/Icon.js";
import { LinkImportSplitButton } from "./link-import/LinkImportSplitButton.js";

export function UploaderTriggers({
  onOpenWorkflow,
  onOpenUrls,
  onOpenJsonl,
  onOpenWeibo,
  onOpenFiles
}: {
  onOpenWorkflow: (opener: HTMLButtonElement) => void;
  onOpenUrls: (opener: HTMLButtonElement) => void;
  onOpenJsonl: (opener: HTMLButtonElement) => void;
  onOpenWeibo: (opener: HTMLButtonElement) => void;
  onOpenFiles: (opener: HTMLButtonElement) => void;
}) {
  return (
    <div className="upload-triggers">
      <LinkImportSplitButton
        onOpenWorkflow={onOpenWorkflow}
        onOpenUrls={onOpenUrls}
        onOpenJsonl={onOpenJsonl}
        onOpenWeibo={onOpenWeibo}
      />
      <button
        className="button upload-trigger"
        type="button"
        onClick={(event) => onOpenFiles(event.currentTarget)}
      >
        <Icon name="upload-cloud-2-line" />上传图片
      </button>
    </div>
  );
}
