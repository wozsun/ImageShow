import { AuthorInput } from "./AuthorInput.js";
import { SelectMenu } from "./SelectMenu.js";
import { TagInput } from "./TagInput.js";
import { ThemeInput } from "./ThemeInput.js";
import type { SelectOption } from "../../lib/ui/select-options.js";
import type { FacetOption } from "../../lib/types.js";

export type WorkflowDefaultValues = {
  device: string;
  brightness: string;
  theme: string;
  author: string;
  tags: string[];
};

type WorkflowDefaultField = keyof WorkflowDefaultValues;

export function WorkflowDefaultFields({
  values,
  onChange,
  deviceOptions,
  brightnessOptions,
  themes,
  authors,
  tags,
  placeholders,
  ariaLabels,
  changed = {},
  disabled = false,
  applyDisabled = false,
  applyReady = false,
  onApply
}: {
  values: WorkflowDefaultValues;
  onChange: {
    device: (value: string) => void;
    brightness: (value: string) => void;
    theme: (value: string) => void;
    author: (value: string) => void;
    tags: (value: string[]) => void;
  };
  deviceOptions: readonly SelectOption[];
  brightnessOptions: readonly SelectOption[];
  themes: FacetOption[];
  authors: FacetOption[];
  tags: FacetOption[];
  placeholders: {
    theme: string;
    author: string;
    tags: string;
  };
  ariaLabels: Record<WorkflowDefaultField, string>;
  changed?: Partial<Record<WorkflowDefaultField, boolean>>;
  disabled?: boolean;
  applyDisabled?: boolean;
  applyReady?: boolean;
  onApply: () => void;
}) {
  const changedClass = (field: WorkflowDefaultField) => (
    changed[field] ? " is-changed" : ""
  );

  return (
    <>
      <SelectMenu
        className={`workflow-default-select workflow-default-device${changedClass("device")}`}
        value={values.device}
        onChange={onChange.device}
        options={deviceOptions}
        ariaLabel={ariaLabels.device}
        disabled={disabled}
      />
      <SelectMenu
        className={`workflow-default-select workflow-default-brightness${changedClass("brightness")}`}
        value={values.brightness}
        onChange={onChange.brightness}
        options={brightnessOptions}
        ariaLabel={ariaLabels.brightness}
        disabled={disabled}
      />
      <div className="workflow-default-pair">
        <ThemeInput
          className={`workflow-default-theme${changedClass("theme")}`}
          value={values.theme}
          onChange={onChange.theme}
          themes={themes}
          placeholder={placeholders.theme}
          ariaLabel={ariaLabels.theme}
          disabled={disabled}
        />
        <AuthorInput
          className={`workflow-default-author${changedClass("author")}`}
          value={values.author}
          onChange={onChange.author}
          authors={authors}
          placeholder={placeholders.author}
          ariaLabel={ariaLabels.author}
          disabled={disabled}
        />
        <TagInput
          className={`workflow-default-tags${changedClass("tags")}`}
          value={values.tags}
          onChange={onChange.tags}
          suggestions={tags}
          placeholder={placeholders.tags}
          ariaLabel={ariaLabels.tags}
          disabled={disabled}
        />
      </div>
      <button
        type="button"
        className={`apply-to-all-button${applyReady ? " is-ready" : ""}`}
        disabled={applyDisabled}
        onClick={onApply}
      >
        应用到全部
      </button>
    </>
  );
}
