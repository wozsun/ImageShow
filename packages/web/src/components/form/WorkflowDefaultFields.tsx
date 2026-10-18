import { WorkflowAttributeActions } from "./WorkflowAttributeActions.js";
import type { PrepareImageAttributeClear } from "../../lib/image-draft.js";
import { NamedSlugInput } from "./NamedSlugInput.js";
import { SelectMenu } from "./SelectMenu.js";
import { TagInput } from "./TagInput.js";
import type { SelectOption } from "../../lib/ui/select-options.js";
import type { FacetOptionDto } from "@imageshow/shared/browser";

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
  applyDisabled = false,
  onApply,
  onPrepareClear,
  clearScope,
  clearScopeLabel
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
  themes: FacetOptionDto[];
  authors: FacetOptionDto[];
  tags: FacetOptionDto[];
  placeholders: {
    theme: string;
    author: string;
    tags: string;
  };
  ariaLabels: Record<WorkflowDefaultField, string>;
  changed?: Partial<Record<WorkflowDefaultField, boolean>>;
  applyDisabled?: boolean;
  onApply: () => void;
  onPrepareClear: PrepareImageAttributeClear;
  clearScope: string;
  clearScopeLabel: string;
}) {
  const changedClass = (field: WorkflowDefaultField) => (changed[field] ? " is-changed" : "");

  return (
    <>
      <SelectMenu
        className={`workflow-default-select workflow-default-device${changedClass("device")}`}
        value={values.device}
        onChange={onChange.device}
        options={deviceOptions}
        ariaLabel={ariaLabels.device}
      />
      <SelectMenu
        className={`workflow-default-select workflow-default-brightness${changedClass("brightness")}`}
        value={values.brightness}
        onChange={onChange.brightness}
        options={brightnessOptions}
        ariaLabel={ariaLabels.brightness}
      />
      <div className="workflow-default-pair">
        <NamedSlugInput
          className={`workflow-default-theme${changedClass("theme")}`}
          value={values.theme}
          onChange={onChange.theme}
          options={themes}
          noun="主题"
          placeholder={placeholders.theme}
          ariaLabel={ariaLabels.theme}
        />
        <NamedSlugInput
          className={`workflow-default-author${changedClass("author")}`}
          value={values.author}
          onChange={onChange.author}
          options={authors}
          noun="作者"
          placeholder={placeholders.author}
          ariaLabel={ariaLabels.author}
        />
        <TagInput
          className={`workflow-default-tags${changedClass("tags")}`}
          value={values.tags}
          onChange={onChange.tags}
          suggestions={tags}
          placeholder={placeholders.tags}
          ariaLabel={ariaLabels.tags}
        />
      </div>
      <WorkflowAttributeActions
        key={clearScope}
        disabled={applyDisabled}
        scopeLabel={clearScopeLabel}
        onApply={onApply}
        onPrepareClear={onPrepareClear}
      />
    </>
  );
}
