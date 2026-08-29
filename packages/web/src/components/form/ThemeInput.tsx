import { SlugComboInput } from "./SlugComboInput.js";
import type { FacetOption } from "../../lib/types.js";

export function ThemeInput({ themes, value, className, ...rest }: {
  value: string;
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
  const unsetClass = value === "none" ? " is-placeholder-value" : "";
  return (
    <SlugComboInput
      options={themes}
      noun="主题"
      value={value}
      className={`${className ?? ""}${unsetClass}`.trim()}
      {...rest}
    />
  );
}
