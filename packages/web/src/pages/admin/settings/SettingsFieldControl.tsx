import { NumberInput } from "../../../components/form/NumberInput.js";
import { SelectMenu } from "../../../components/form/SelectMenu.js";
import { FieldError } from "../../../components/form/FieldError.js";
import type { SettingsField } from "./settings-fields.js";

/** 单个配置项的表单控件；保存失败时 error 为该项的问题，控件标红并在下方写明。 */
export function SettingsFieldControl({
  field,
  value,
  disabled,
  error,
  onChange
}: {
  field: SettingsField;
  value: unknown;
  disabled: boolean;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const invalid = Boolean(error);
  const errorText = <FieldError message={error} />;
  const className = [
    "settings-field",
    field.wide ? "settings-field-wide" : "",
    field.kind === "textarea" || field.kind === "lines" ? "settings-field-multiline" : ""
  ].filter(Boolean).join(" ");
  const rangeText = field.kind === "number" || field.kind === "range"
    ? field.kind === "number" && field.exclusiveMin
      ? `大于 ${field.min}，不超过 ${field.max}`
      : `${field.min}–${field.max}`
    : "";
  const hint = field.hint && <span className="hint">{field.hint}</span>;
  if (field.kind === "range") {
    const values = value as [number, number];
    return (
      <fieldset className={`${className} settings-compound-field`}>
        <legend>{field.label}</legend>
        <div className="settings-range">
          {([0, 1] as const).map((index) => (
            <label key={index} className="settings-range-end">
              <span>{index === 0 ? "最小值" : "最大值"}</span>
              <NumberInput
                ariaLabel={`${field.label}${index === 0 ? "最小值" : "最大值"}`}
                value={values[index]}
                min={field.min}
                max={field.max}
                placeholder={rangeText}
                disabled={disabled}
                ariaInvalid={invalid}
                onChange={(next) => onChange(index === 0 ? [next, values[1]] : [values[0], next])}
              />
            </label>
          ))}
        </div>
        {errorText}
        <span className="hint settings-field-range">范围：{rangeText}{field.hint && `；${field.hint}`}</span>
      </fieldset>
    );
  }
  if (field.kind === "choices") {
    const values = value as string[];
    return (
      <fieldset className={`${className} settings-compound-field`}>
        <legend>{field.label}</legend>
        <div className="settings-choice-options">
          {Object.entries(field.options).map(([key, label]) => (
            <label key={key} className="settings-toggle">
              <input
                type="checkbox"
                checked={values.includes(key)}
                disabled={disabled}
                onChange={(event) => onChange(event.target.checked
                  ? [...values, key]
                  : values.filter((item) => item !== key))}
              />
              {label}
            </label>
          ))}
        </div>
        {errorText}
        {hint}
      </fieldset>
    );
  }
  if (field.kind === "toggle") {
    return (
      <label className="settings-toggle">
        <input
          type="checkbox"
          aria-label={field.label}
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{field.label}{errorText}{hint}</span>
      </label>
    );
  }
  return (
    <label className={className}>
      <span className="settings-field-label">{field.label}</span>
      {field.kind === "number" ? (
        <NumberInput
          value={Number(value)}
          min={field.min}
          max={field.max}
          step={field.step}
          placeholder={rangeText}
          ariaLabel={field.label}
          ariaInvalid={invalid}
          disabled={disabled}
          onChange={onChange}
        />
      ) : field.kind === "select" ? (
        <SelectMenu
          value={String(value)}
          ariaLabel={field.label}
          ariaInvalid={invalid}
          disabled={disabled}
          options={Object.entries(field.options).map(([key, label]) => ({ value: key, label }))}
          onChange={onChange}
        />
      ) : field.kind === "lines" ? (
        <textarea
          aria-label={field.label}
          aria-invalid={invalid || undefined}
          rows={5}
          value={(value as string[]).join("\n")}
          disabled={disabled}
          placeholder={field.placeholder}
          onChange={(event) => onChange(event.target.value.split("\n"))}
          onBlur={(event) => onChange(
            event.target.value.split("\n").map((line) => line.trim()).filter(Boolean)
          )}
        />
      ) : field.kind === "textarea" ? (
        <textarea
          aria-label={field.label}
          aria-invalid={invalid || undefined}
          rows={5}
          value={String(value)}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          aria-label={field.label}
          aria-invalid={invalid || undefined}
          value={String(value)}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {errorText}
      {rangeText && <span className="hint settings-field-range">范围：{rangeText}</span>}
      {hint}
    </label>
  );
}
