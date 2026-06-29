import { useState } from "react";
import { Icon } from "./Icon.js";

// A password <input> with a small eye button that toggles plaintext visibility. onChange passes
// the raw string so callers can do extra work (e.g. clearing a "saved" flag). Reused by every
// password field — login, account password change, and user create / reset.
export function PasswordInput({
  value,
  onChange,
  placeholder,
  disabled = false,
  maxLength,
  autoComplete,
  autoFocus = false,
  ariaInvalid = false
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  maxLength?: number;
  autoComplete?: string;
  autoFocus?: boolean;
  ariaInvalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="password-input">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        type={show ? "text" : "password"}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        aria-invalid={ariaInvalid || undefined}
      />
      <button
        type="button"
        className="password-toggle"
        title={show ? "隐藏密码" : "显示密码"}
        aria-label={show ? "隐藏密码" : "显示密码"}
        disabled={disabled}
        // Keep the toggle out of the tab order so Tab goes input → submit, not via the eye.
        tabIndex={-1}
        onClick={() => setShow((current) => !current)}
      >
        <Icon name={show ? "eye-off-line" : "eye-line"} />
      </button>
    </div>
  );
}
