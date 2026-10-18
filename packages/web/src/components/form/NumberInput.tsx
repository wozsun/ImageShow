import { useEffect, useState } from "react";
import { flushSync } from "react-dom";

type FormSubmitter = HTMLButtonElement | HTMLInputElement;

function isFormSubmitter(element: Element): element is FormSubmitter {
  if (element instanceof HTMLButtonElement) return element.type === "submit";
  return (
    element instanceof HTMLInputElement
      && (element.type === "submit" || element.type === "image")
  );
}

function defaultFormSubmitter(form: HTMLFormElement) {
  return Array.from(form.elements).find(isFormSubmitter);
}

type NumberInputProps = {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  ariaInvalid?: boolean;
};

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  disabled,
  ariaLabel,
  ariaInvalid
}: NumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);

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
      inputMode={step === "any" ? "decimal" : "numeric"}
      aria-label={ariaLabel}
      aria-invalid={ariaInvalid || undefined}
      min={min}
      max={max}
      step={step}
      placeholder={placeholder}
      disabled={disabled}
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;

        const form = event.currentTarget.form;
        if (!form) {
          commit(event.currentTarget.value);
          return;
        }

        event.preventDefault();
        const value = event.currentTarget.value;
        // Settle the draft into the form state before submitting, as the settings page does.
        flushSync(() => commit(value));
        if (!form.isConnected) return;
        const submitter = defaultFormSubmitter(form);
        if (submitter) {
          if (submitter.matches(":disabled") || submitter.form !== form) return;
          form.requestSubmit(submitter);
          return;
        }
        form.requestSubmit();
      }}
      onBlur={(event) => commit(event.target.value)}
    />
  );
}
