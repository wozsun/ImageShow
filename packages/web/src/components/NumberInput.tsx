import { useEffect, useState } from "react";

type NumberInputProps = {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
};

// A controlled numeric input that keeps a free-form draft string while the field
// is focused, so the value can be cleared and retyped without the bound number
// forcing a stubborn leading 0 (e.g. typing 50 over a 0). The draft is parsed and
// clamped to [min, max] on blur; empty/invalid input reverts to the last value.
export function NumberInput({ value, onChange, min, max, step, placeholder, disabled, className, ariaLabel }: NumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);

  // Resync the draft when the value changes from outside (e.g. a settings reload)
  // and the user isn't mid-edit.
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);

  const commit = (raw: string) => {
    setEditing(false);
    const next = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(next)) {
      setDraft(String(value));
      return;
    }
    let clamped = next;
    if (min !== undefined) clamped = Math.max(min, clamped);
    if (max !== undefined) clamped = Math.min(max, clamped);
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <input
      type="number"
      inputMode="numeric"
      className={className}
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      disabled={disabled}
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => commit(event.target.value)}
    />
  );
}
