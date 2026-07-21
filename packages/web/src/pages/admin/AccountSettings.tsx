import { useState, type FormEvent } from "react";
import { api } from "../../lib/api/client.js";
import { AsyncActionButton } from "../../components/actions/AsyncActionButton.js";
import { PasswordInput } from "../../components/form/PasswordInput.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { isValidAdminPassword, passwordPolicyHint } from "../../lib/auth/password.js";
import { useAuthMe } from "../../lib/api/site-data.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";

const updatePasswordPresentation = {
  idle: { icon: "key-2-line", label: "修改密码" },
  pending: { icon: "key-2-line", label: "保存中" },
  success: { icon: "check-line", label: "密码已更新" },
  error: { icon: "close-line", label: "密码修改失败" }
} as const;

export function AccountSettings() {
  const { data: auth } = useAuthMe();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const updatePasswordStatus = useAsyncActionStatus();
  const isSuper = auth?.role === "super";

  const nextInvalid = next.length > 0 && !isValidAdminPassword(next);
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0
    && isValidAdminPassword(next)
    && next === confirm
    && !updatePasswordStatus.pending;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    await updatePasswordStatus.run(async () => {
      try {
        await api(`${adminApiBasePath}/auth/password`, {
          method: "POST",
          body: JSON.stringify({ current_password: current, new_password: next })
        });
        setCurrent("");
        setNext("");
        setConfirm("");
        return true;
      } catch (error) {
        reportAdminUiError("account.password_update", error);
        return false;
      }
    });
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
            onChange={setCurrent}
            placeholder="输入当前密码"
            disabled={updatePasswordStatus.pending}
            maxLength={128}
            autoComplete="current-password"
          />
        </label>
        <label>
          新密码
          <PasswordInput
            value={next}
            onChange={setNext}
            placeholder={passwordPolicyHint}
            disabled={updatePasswordStatus.pending}
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
            onChange={setConfirm}
            placeholder="再次输入新密码"
            disabled={updatePasswordStatus.pending}
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        {mismatch && <p className="error" role="alert">两次输入的新密码不一致。</p>}
        {isSuper && <p className="muted account-note">无法登录时，可在容器终端使用 imageshow reset-password 恢复超级管理员密码。</p>}
        <AsyncActionButton
          className="button"
          type="submit"
          status={updatePasswordStatus.status}
          presentation={updatePasswordPresentation}
          disabled={!canSubmit}
        />
      </form>
    </section>
  );
}
