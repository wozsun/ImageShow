import { unsetSelector, type FacetOptionDto } from "@imageshow/shared/browser";
import { SlugComboInput } from "./SlugComboInput.js";
import { parseFacetSlug } from "../../lib/ui/facet-input.js";

function parseNamedSlug(value: string) {
  const slug = parseFacetSlug(value);
  return slug === unsetSelector ? "" : slug;
}

/** Theme or author input: offers named slugs only, and typing the unset selector clears it. */
export function NamedSlugInput({
  options,
  value,
  placeholder,
  ...rest
}: {
  options: FacetOptionDto[];
  noun: string;
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  publishTypedChanges?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  return (
    <SlugComboInput
      options={options.filter((item) => item.slug !== unsetSelector)}
      parseSlug={parseNamedSlug}
      value={value ?? ""}
      placeholder={value === null ? "未设置" : placeholder}
      {...rest}
    />
  );
}
