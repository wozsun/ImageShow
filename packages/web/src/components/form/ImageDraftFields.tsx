import { imageDescriptionMaxLength, imageTitleMaxLength } from "@imageshow/shared/browser";
import { useId } from "react";
import { SelectMenu } from "./SelectMenu.js";
import { ThemeInput } from "./ThemeInput.js";
import { TagInput } from "./TagInput.js";
import { AuthorInput } from "./AuthorInput.js";
import type { SelectOption } from "../../lib/ui/select-options.js";
import type { FacetOption, ImageDraft } from "../../lib/types.js";

export type ImageDraftDeferredField =
  | "title"
  | "theme"
  | "author"
  | "original"
  | "source"
  | "description";

type ImageDraftDeferredPlainField = Exclude<
  ImageDraftDeferredField,
  "theme" | "author"
>;

export type ImageDraftDeferredEditing = Readonly<{
  values: Pick<ImageDraft, ImageDraftDeferredPlainField>;
  onFocus: (field: ImageDraftDeferredField) => void;
  onTextChange: (field: ImageDraftDeferredPlainField, value: string) => void;
  onCommit: (field: ImageDraftDeferredField, value: string) => void;
  onBlur: (field: ImageDraftDeferredField) => void;
}>;

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
  changed = {},
  deferredEditing
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
  deferredEditing?: ImageDraftDeferredEditing;
}) {
  const changedFields = changed;
  const fieldGroupId = useId();
  return (
    <div className="image-fields">
      <div className="image-fields-row image-fields-primary">
        <input
          id={`${fieldGroupId}-title`}
          className={`image-fields-title${changedFields.title ? " is-changed" : ""}`}
          value={title
            ? title.value
            : deferredEditing?.values.title ?? draft.title}
          onFocus={deferredEditing
            ? () => deferredEditing.onFocus("title")
            : undefined}
          onChange={(event) => {
            if (deferredEditing) {
              deferredEditing.onTextChange("title", event.target.value);
            } else {
              onPatch({ title: event.target.value });
            }
          }}
          onBlur={deferredEditing
            ? () => deferredEditing.onBlur("title")
            : undefined}
          maxLength={imageTitleMaxLength}
          placeholder={title?.placeholder ?? "标题"}
          disabled={title ? title.disabled : disabled}
        />
        <SelectMenu
          className={`image-fields-device${changedFields.device ? " is-changed" : ""}`}
          value={draft.device}
          onChange={(value) => onPatch({ device: value as ImageDraft["device"] })}
          disabled={disabled}
          options={deviceOptions}
          ariaLabel={`${ariaPrefix} 设备`}
        />
        <SelectMenu
          className={`image-fields-brightness${changedFields.brightness ? " is-changed" : ""}`}
          value={draft.brightness}
          onChange={(value) => onPatch({ brightness: value as ImageDraft["brightness"] })}
          disabled={disabled}
          options={brightnessOptions}
          ariaLabel={`${ariaPrefix} 亮度`}
        />
        <ThemeInput
          className={`image-fields-theme${changedFields.theme ? " is-changed" : ""}`}
          value={draft.theme}
          onChange={(theme) => {
            if (deferredEditing) deferredEditing.onCommit("theme", theme);
            else onPatch({ theme });
          }}
          publishTypedChanges={!deferredEditing}
          onFocus={deferredEditing
            ? () => deferredEditing.onFocus("theme")
            : undefined}
          onBlur={deferredEditing
            ? () => deferredEditing.onBlur("theme")
            : undefined}
          themes={themes}
          placeholder="主题"
          disabled={disabled}
          ariaLabel={`${ariaPrefix} 主题`}
        />
        <AuthorInput
          className={`image-fields-author${changedFields.author ? " is-changed" : ""}`}
          value={draft.author}
          onChange={(author) => {
            if (deferredEditing) deferredEditing.onCommit("author", author);
            else onPatch({ author });
          }}
          publishTypedChanges={!deferredEditing}
          onFocus={deferredEditing
            ? () => deferredEditing.onFocus("author")
            : undefined}
          onBlur={deferredEditing
            ? () => deferredEditing.onBlur("author")
            : undefined}
          authors={authors}
          placeholder="作者"
          disabled={disabled}
          ariaLabel={`${ariaPrefix} 作者`}
        />
        <TagInput
          className={`image-fields-tags${changedFields.tags ? " is-changed" : ""}`}
          value={draft.tags}
          onChange={(tags) => onPatch({ tags })}
          suggestions={allTags}
          disabled={disabled}
          ariaLabel={`${ariaPrefix} 标签`}
          placeholder="标签"
        />
      </div>
      <div className="image-fields-row image-fields-urls">
        <input
          id={`${fieldGroupId}-original`}
          className={changedFields.original ? "is-changed" : undefined}
          value={deferredEditing?.values.original ?? draft.original}
          onFocus={deferredEditing
            ? () => deferredEditing.onFocus("original")
            : undefined}
          onChange={(event) => {
            if (deferredEditing) {
              deferredEditing.onTextChange("original", event.target.value);
            } else {
              onPatch({ original: event.target.value });
            }
          }}
          onBlur={deferredEditing
            ? () => deferredEditing.onBlur("original")
            : undefined}
          placeholder="原图 URL"
          disabled={disabled}
        />
        <input
          id={`${fieldGroupId}-source`}
          className={changedFields.source ? "is-changed" : undefined}
          value={deferredEditing?.values.source ?? draft.source}
          onFocus={deferredEditing
            ? () => deferredEditing.onFocus("source")
            : undefined}
          onChange={(event) => {
            if (deferredEditing) {
              deferredEditing.onTextChange("source", event.target.value);
            } else {
              onPatch({ source: event.target.value });
            }
          }}
          onBlur={deferredEditing
            ? () => deferredEditing.onBlur("source")
            : undefined}
          placeholder="来源 URL"
          disabled={disabled}
        />
      </div>
      <textarea
        id={`${fieldGroupId}-description`}
        className={`image-fields-desc${changedFields.description ? " is-changed" : ""}`}
        value={deferredEditing?.values.description ?? draft.description}
        onFocus={deferredEditing
          ? () => deferredEditing.onFocus("description")
          : undefined}
        onChange={(event) => {
          if (deferredEditing) {
            deferredEditing.onTextChange("description", event.target.value);
          } else {
            onPatch({ description: event.target.value });
          }
        }}
        onBlur={deferredEditing
          ? () => deferredEditing.onBlur("description")
          : undefined}
        maxLength={imageDescriptionMaxLength}
        placeholder="详情描述"
        disabled={disabled}
      />
    </div>
  );
}
