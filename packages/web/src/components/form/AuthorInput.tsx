import { SlugComboInput } from "./SlugComboInput.js";
import type { FacetOption } from "../../lib/types.js";

export function AuthorInput({ authors, ...rest }: {
  value: string;
  onChange: (value: string) => void;
  authors: FacetOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  publishTypedChanges?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  return <SlugComboInput options={authors} noun="作者" {...rest} />;
}
