import { SelectMenu } from "./SelectMenu.js";
import { ThemeInput } from "./ThemeInput.js";
import { TagInput } from "./TagInput.js";
import { AuthorInput } from "./AuthorInput.js";
import type { SelectOption } from "../lib/select-options.js";
import type { Device, FacetOption, ImageDraft } from "../lib/types.js";

// Shared three-row metadata editor used by both the uploader cards and the batch-edit
// rows so they lay out identically: 标题·设备·亮度·主题·标签 on the first row, 原图/来源 URL
// on the second, and the (multi-line) 详情描述 on the third. Device/brightness option
// sets differ per caller (the uploader cards vs the batch bar's 不变/自动 leads), so they
// come in as props. `title` lets a caller override the title input (value/placeholder/
// disabled); omit it to bind straight to draft.title.
export function ImageDraftFields({
  draft,
  onPatch,
  themes,
  allTags,
  authors,
  deviceOptions,
  brightnessOptions,
  disabled = false,
  ariaPrefix,
  title,
  changed = {}
}: {
  draft: ImageDraft;
  onPatch: (patch: Partial<ImageDraft>) => void;
  themes: FacetOption[];
  allTags: FacetOption[];
  authors: FacetOption[];
  deviceOptions: readonly SelectOption[];
  brightnessOptions: readonly SelectOption[];
  disabled?: boolean;
  ariaPrefix: string;
  title?: { value: string; placeholder: string; disabled: boolean };
  // Per-field "edited from the saved value" flags; set by the batch editor to tint changed
  // controls amber. Omitted by the uploader (new uploads have nothing to diff against).
  changed?: Partial<Record<"title" | "device" | "brightness" | "theme" | "tags" | "author" | "original" | "source" | "description", boolean>>;
}) {
  const c = changed;
  return (
    <div className="image-fields">
      <div className="image-fields-row image-fields-primary">
        <input
          className={`image-fields-title${c.title ? " is-changed" : ""}`}
          value={title ? title.value : draft.title}
          onChange={(event) => onPatch({ title: event.target.value })}
          placeholder={title?.placeholder ?? "标题"}
          disabled={title ? title.disabled : disabled}
        />
        <SelectMenu
          className={`image-fields-device${c.device ? " is-changed" : ""}`}
          value={draft.device}
          onChange={(value) => onPatch({ device: value as Device })}
          disabled={disabled}
          options={deviceOptions}
          ariaLabel={`${ariaPrefix} 设备`}
        />
        <SelectMenu
          className={`image-fields-brightness${c.brightness ? " is-changed" : ""}`}
          value={draft.brightness}
          onChange={(value) => onPatch({ brightness: value as ImageDraft["brightness"] })}
          disabled={disabled}
          options={brightnessOptions}
          ariaLabel={`${ariaPrefix} 亮度`}
        />
        <ThemeInput
          className={`image-fields-theme${c.theme ? " is-changed" : ""}`}
          value={draft.theme}
          onChange={(theme) => onPatch({ theme })}
          themes={themes}
          placeholder="主题"
          disabled={disabled}
          ariaLabel={`${ariaPrefix} 主题`}
        />
        <TagInput
          className={`image-fields-tags${c.tags ? " is-changed" : ""}`}
          value={draft.tags}
          onChange={(tags) => onPatch({ tags })}
          suggestions={allTags}
          disabled={disabled}
          ariaLabel={`${ariaPrefix} 标签`}
          placeholder="标签"
        />
        <AuthorInput
          className={`image-fields-author${c.author ? " is-changed" : ""}`}
          value={draft.author}
          onChange={(author) => onPatch({ author })}
          authors={authors}
          placeholder="作者"
          disabled={disabled}
          ariaLabel={`${ariaPrefix} 作者`}
        />
      </div>
      <div className="image-fields-row image-fields-urls">
        <input
          className={c.original ? "is-changed" : undefined}
          value={draft.original}
          onChange={(event) => onPatch({ original: event.target.value })}
          placeholder="原图 URL"
          disabled={disabled}
        />
        <input
          className={c.source ? "is-changed" : undefined}
          value={draft.source}
          onChange={(event) => onPatch({ source: event.target.value })}
          placeholder="来源 URL"
          disabled={disabled}
        />
      </div>
      <textarea
        className={`image-fields-desc${c.description ? " is-changed" : ""}`}
        value={draft.description}
        onChange={(event) => onPatch({ description: event.target.value })}
        placeholder="详情描述"
        disabled={disabled}
      />
    </div>
  );
}
