import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { Icon } from "../../components/Icon.js";
import { PasswordInput } from "../../components/PasswordInput.js";
import { adminApiBasePath, queryKeys } from "../../lib/constants.js";
import { errorMessage } from "../../lib/formatters.js";
import { isValidAdminPassword, passwordPolicyHint } from "../../lib/password.js";
import type { AuthState } from "../../lib/types.js";

// Self-service password change, available to every signed-in admin (both super and image
// roles). For image admins — who have no other settings access — this is their dedicated
// settings page. Takes the current password once plus the new one twice (confirm).
export function AccountSettings() {
  const { data: auth } = useQuery<AuthState>({ queryKey: queryKeys.me, queryFn: () => api(`${adminApiBasePath}/auth/me`) });
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const isSuper = auth?.role === "super";
  // Flag the new-password field red (+ hint) once something's typed that breaks the policy.
  const nextInvalid = next.length > 0 && !isValidAdminPassword(next);
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && isValidAdminPassword(next) && next === confirm && !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError("");
    setDone(false);
    try {
      await api(`${adminApiBasePath}/auth/password`, { method: "POST", body: JSON.stringify({ current_password: current, new_password: next }) });
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="workspace">
      <header className="workspace-head">
        <div>
          <h1>账户设置</h1>
          <p>当前账户「{auth?.username || "—"}」· 修改登录密码</p>
        </div>
      </header>
      <form className="account-form" onSubmit={submit} autoComplete="off">
        <label>
          当前密码
          <PasswordInput
            value={current}
            onChange={(value) => { setCurrent(value); setDone(false); }}
            placeholder="输入当前密码"
            disabled={busy}
            maxLength={128}
            autoComplete="current-password"
          />
        </label>
        <label>
          新密码
          <PasswordInput
            value={next}
            onChange={(value) => { setNext(value); setDone(false); }}
            placeholder={passwordPolicyHint}
            disabled={busy}
            maxLength={128}
            autoComplete="new-password"
            ariaInvalid={nextInvalid}
          />
          {nextInvalid && <p className="field-error">{passwordPolicyHint}</p>}
        </label>
        <label>
          确认新密码
          <PasswordInput
            value={confirm}
            onChange={(value) => { setConfirm(value); setDone(false); }}
            placeholder="再次输入新密码"
            disabled={busy}
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        {mismatch && <p className="error">两次输入的新密码不一致。</p>}
        {error && <p className="error">{error}</p>}
        {done && <p className="form-success"><Icon name="checkbox-circle-line" />密码已更新。</p>}
        {isSuper && <p className="muted account-note">超级管理员密码可通过修改环境变量并重启容器来强制覆盖。</p>}
        <button className="button" type="submit" disabled={!canSubmit}>
          <Icon name="key-2-line" />{busy ? "保存中…" : "修改密码"}
        </button>
      </form>
    </section>
  );
}
