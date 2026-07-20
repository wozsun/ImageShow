import { useState, type FormEvent } from "react";
import { api } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { PasswordInput } from "../../components/form/PasswordInput.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { errorMessage } from "../../lib/ui/formatters.js";
import { isValidAdminPassword, passwordPolicyHint } from "../../lib/auth/password.js";
import { useAuthMe } from "../../lib/api/site-data.js";

export function AccountSettings() {
  const { data: auth } = useAuthMe();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const isSuper = auth?.role === "super";

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
        {(mismatch || error || done) && (
          <p
            className={done ? "form-success" : "error"}
            role={mismatch || error ? "alert" : "status"}
            title={error || undefined}
          >
            {done && <Icon name="checkbox-circle-line" />}
            {mismatch ? "两次输入的新密码不一致。" : error || "密码已更新。"}
          </p>
        )}
        {isSuper && <p className="muted account-note">无法登录时，可在容器终端使用 imageshow reset-password 恢复超级管理员密码。</p>}
        <button className="button" type="submit" disabled={!canSubmit}>
          <Icon name="key-2-line" />{busy ? "保存中…" : "修改密码"}
        </button>
      </form>
    </section>
  );
}
