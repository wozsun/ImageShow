import { SlugComboInput } from "./SlugComboInput.js";
import type { FacetOption } from "../lib/types.js";

// Theme picker: a single-select slug typeahead over the theme vocabulary. A new slug is created
// on submit; a slug colliding with a reserved subdomain prefix is flagged invalid (the server
// rejects it). Thin wrapper over the shared SlugComboInput — see it for the full behavior.
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
