import { SlugComboInput } from "./SlugComboInput.js";
import type { FacetOption } from "../../lib/types.js";

export function ThemeInput({ themes, ...rest }: {
  value: string;
  onChange: (value: string) => void;
  themes: FacetOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return <SlugComboInput options={themes} noun="主题" checkReserved {...rest} />;
}
