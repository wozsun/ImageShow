import { WorkflowDefaultFields } from "../../../components/form/WorkflowDefaultFields.js";
import { WorkflowCollapsePanel } from "../../../components/layout/WorkflowCollapsePanel.js";
import {
  uploadCommonBrightnessOptions,
  uploadCommonDeviceOptions
} from "../../../lib/ui/select-options.js";
import type { ImportAttributeDefaults } from "../../../lib/upload/upload-utils.js";
import type { UploadWorkflowDefaultsController } from "./upload-workflow-controller.js";

export function UploadWorkflowDefaults({
  busy,
  queue,
  controller
}: {
  busy: boolean;
  queue: { applyDefaultsToAll: (defaults: ImportAttributeDefaults) => void };
  controller: UploadWorkflowDefaultsController;
}) {
  const { values } = controller;
  return (
    <WorkflowCollapsePanel
      className="upload-defaults-panel"
      contentClassName="upload-defaults workflow-defaults"
      title="默认属性"
      summary={controller.summary}
      expanded={controller.expanded}
      onExpandedChange={controller.onExpandedChange}
    >
      <WorkflowDefaultFields
        values={values}
        onChange={{
          device: (device) => controller.onChange({
            ...values,
            device: device as ImportAttributeDefaults["device"]
          }),
          brightness: (brightness) => controller.onChange({
            ...values,
            brightness: brightness as ImportAttributeDefaults["brightness"]
          }),
          theme: (theme) => controller.onChange({ ...values, theme }),
          author: (author) => controller.onChange({ ...values, author }),
          tags: (tags) => controller.onChange({ ...values, tags })
        }}
        deviceOptions={uploadCommonDeviceOptions}
        brightnessOptions={uploadCommonBrightnessOptions}
        themes={controller.themes}
        authors={controller.authors}
        tags={controller.tags}
        placeholders={{
          theme: "主题",
          author: "默认作者",
          tags: "默认标签"
        }}
        ariaLabels={{
          device: "默认设备",
          brightness: "默认亮度",
          theme: "默认主题",
          author: "默认作者",
          tags: "默认标签"
        }}
        applyDisabled={busy || !controller.canApply}
        onApply={() => queue.applyDefaultsToAll(values)}
      />
    </WorkflowCollapsePanel>
  );
}
