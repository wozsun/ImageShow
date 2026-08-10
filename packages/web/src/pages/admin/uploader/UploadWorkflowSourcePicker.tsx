import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { preloadIntentProps } from "../../../lib/ui/preload-intent.js";
import type { ImportSourceMode } from "./link-import/ImportSourceDialog.js";
import type { UploadWorkflowHeaderController } from "./upload-workflow-controller.js";

const sourceOptions: Array<[ImportSourceMode, string]> = [
  ["urls", "链接"],
  ["jsonl", "清单"],
  ["weibo", "微博"]
];

export function UploadWorkflowSourcePicker({
  mode,
  busy,
  controller
}: {
  mode: "file" | "link";
  busy: boolean;
  controller: UploadWorkflowHeaderController;
}) {
  if (mode === "link") {
    const disabled = busy || controller.source.pending;
    return (
      <div
        className={`upload-source-picker${disabled ? " is-disabled" : ""}`}
        role="group"
        aria-label="选择导入来源"
        aria-disabled={disabled}
      >
        {sourceOptions.map(([sourceMode, label]) => (
          <button
            key={sourceMode}
            ref={
              controller.source.mode === sourceMode
                ? controller.source.pickerRef
                : undefined
            }
            type="button"
            className="upload-source-option pressable"
            disabled={disabled}
            {...preloadIntentProps(controller.source.onPreload)}
            onClick={() => controller.source.onOpen(sourceMode)}
          >
            {label}
          </button>
        ))}
      </div>
    );
  }

  return (
    <label
      className={`button secondary upload-picker pressable${
        busy ? " is-disabled" : ""
      }`}
      aria-disabled={busy}
    >
      <AdminIcon name="upload-cloud-2-line" />
      <input
        id={controller.file.inputId}
        ref={controller.file.inputRef}
        type="file"
        accept="image/*"
        multiple
        disabled={busy}
        onChange={(event) => {
          controller.file.onAdd(event.target.files);
          event.target.value = "";
        }}
      />
      选择图片
    </label>
  );
}
