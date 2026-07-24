import { useEffect, useState } from "react";

type FormSubmitter = HTMLButtonElement | HTMLInputElement;

function isFormSubmitter(element: Element): element is FormSubmitter {
  if (element instanceof HTMLButtonElement) return element.type === "submit";
  return element instanceof HTMLInputElement
    && (element.type === "submit" || element.type === "image");
}

function defaultFormSubmitter(form: HTMLFormElement) {
  return Array.from(form.elements).find(isFormSubmitter);
}

type NumberInputProps = {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
};

export function NumberInput({ value, onChange, min, max, placeholder, disabled, className, ariaLabel }: NumberInputProps) {
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
      inputMode="numeric"
      className={className}
      aria-label={ariaLabel}
      min={min}
      max={max}
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
        commit(event.currentTarget.value);
        window.setTimeout(() => {
          if (!form.isConnected) return;
          const submitter = defaultFormSubmitter(form);
          if (submitter) {
            if (submitter.matches(":disabled") || submitter.form !== form) return;
            form.requestSubmit(submitter);
            return;
          }
          form.requestSubmit();
        });
      }}
      onBlur={(event) => commit(event.target.value)}
    />
  );
}
