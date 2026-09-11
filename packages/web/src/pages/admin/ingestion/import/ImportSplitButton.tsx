import { SplitActionButton } from "../../../../components/actions/SplitActionButton.js";
import { AdminIcon } from "../../../../components/icon/AdminIcon.js";

export function ImportSplitButton({
  pending,
  onPreloadWorkflow,
  onPreloadImportSource,
  onOpenWorkflow,
  onOpenUrls,
  onOpenJsonl,
  onOpenWeibo
}: {
  pending: boolean;
  onPreloadWorkflow: () => void;
  onPreloadImportSource: () => void;
  onOpenWorkflow: (opener: HTMLButtonElement) => void;
  onOpenUrls: (opener: HTMLButtonElement) => void;
  onOpenJsonl: (opener: HTMLButtonElement) => void;
  onOpenWeibo: (opener: HTMLButtonElement) => void;
}) {
  return (
    <SplitActionButton
      className="import-source-split"
      mainClassName="button secondary ingestion-trigger import-source-main"
      menuLabel="更多导入方式"
      disabled={pending}
      onPreload={() => {
        onPreloadWorkflow();
        onPreloadImportSource();
      }}
      onActivate={onOpenWorkflow}
      items={[
        { id: "urls", label: "链接导入", icon: "link", onSelect: onOpenUrls, onPreload: onPreloadImportSource },
        { id: "jsonl", label: "清单导入", icon: "file-list-line", onSelect: onOpenJsonl, onPreload: onPreloadImportSource },
        { id: "weibo", label: "微博导入", icon: "weibo-line", onSelect: onOpenWeibo, onPreload: onPreloadImportSource }
      ]}
    >
      <AdminIcon name="download-cloud-2-line" />导入图片
    </SplitActionButton>
  );
}
