import { SlugComboInput } from "./SlugComboInput.js";
import type { FacetOption } from "../lib/types.js";

// Author picker: the single-select sibling of ThemeInput (an image has one author). A new slug is
// created on submit; no reserved-subdomain check (authors aren't subdomains). Thin wrapper over
// the shared SlugComboInput — see it for the full behavior.
export function AuthorInput({ authors, ...rest }: {
  value: string;
  onChange: (value: string) => void;
  authors: FacetOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return <SlugComboInput options={authors} noun="作者" {...rest} />;
}
