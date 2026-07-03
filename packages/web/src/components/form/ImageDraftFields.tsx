import { SelectMenu } from "./SelectMenu.js";
import { ThemeInput } from "./ThemeInput.js";
import { TagInput } from "./TagInput.js";
import { AuthorInput } from "./AuthorInput.js";
import type { SelectOption } from "../../lib/ui/select-options.js";
import type { Device, FacetOption, ImageDraft } from "../../lib/types.js";

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
