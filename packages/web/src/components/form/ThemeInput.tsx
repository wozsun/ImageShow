import { unsetThemeFilter } from "@imageshow/shared/browser";
import { SlugComboInput } from "./SlugComboInput.js";
import type { FacetOption } from "../../lib/types.js";
import { parseFacetSlug } from "../../lib/ui/facet-input.js";

function parseThemeInput(value: string) {
  const slug = parseFacetSlug(value);
  return slug === unsetThemeFilter ? "" : slug;
}

export function ThemeInput({ themes, value, className, placeholder, ...rest }: {
  value: string | null;
  onChange: (value: string) => void;
  themes: FacetOption[];
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
      options={themes.filter((item) => item.slug !== unsetThemeFilter)}
      noun="主题"
      parseSlug={parseThemeInput}
      value={value ?? ""}
      placeholder={value === null ? "未设置" : placeholder}
      className={className}
      {...rest}
    />
  );
}
