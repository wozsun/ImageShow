import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api.js";
import { Icon } from "../../components/Icon.js";
import { OverlayScrollbar } from "../../components/OverlayScrollbar.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { useAnimatedClose } from "../../components/useAnimatedClose.js";
import { useBodyScrollLock } from "../../components/useBodyScrollLock.js";
import { adminApiBasePath, queryKeys, slugCharset, slugFormatHint } from "../../lib/constants.js";
import { errorMessage } from "../../lib/formatters.js";
import { PasswordInput } from "../../components/PasswordInput.js";
import { SlugChip } from "../../components/SlugChip.js";
import { PageToast } from "../../components/PageToast.js";
import { generateAdminPassword, isValidAdminPassword, passwordPolicyHint } from "../../lib/password.js";
import type { AdminUser } from "../../lib/types.js";

export function UserAdmin() {
  const client = useQueryClient();
  const { data, isFetching } = useQuery<{ items: AdminUser[] }>({ queryKey: queryKeys.users, queryFn: () => api(`${adminApiBasePath}/users`) });
  const users = data?.items ?? [];
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.users });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  // One toast slot for both errors and the generate-password success notice.
  const [toast, setToast] = useState<{ message: string; kind: "error" | "success" }>({ message: "", kind: "error" });
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const showError = (message: string) => setToast({ message, kind: "error" });
  const clearToast = () => setToast((current) => ({ message: "", kind: current.kind }));
  // Username reuses the theme/tag/author slug rule; password the credential policy. Each flags a
  // red border + hint once it holds something invalid.
  const usernameInvalid = username.length > 0 && !slugCharset.test(username);
  const usernameValid = username.trim().length > 0 && slugCharset.test(username.trim());
  const passwordInvalid = password.length > 0 && !isValidAdminPassword(password);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const name = username.trim();
    if (!usernameValid || !isValidAdminPassword(password) || busy) return;
    setBusy(true);
    clearToast();
    try {
      await api(`${adminApiBasePath}/users`, { method: "POST", body: JSON.stringify({ username: name, password }) });
      setUsername("");
      setPassword("");
      refresh();
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Fills the password with a fresh random one and copies the username + password together, so
  // the super admin can hand both to the new user in a single paste.
  const generatePassword = async () => {
    if (busy) return;
    const pwd = generateAdminPassword();
    setPassword(pwd);
    const name = username.trim();
    try {
      await navigator.clipboard.writeText(`用户名：${name}\n密码：${pwd}`);
      setToast({ message: name ? "已生成随机密码，并复制用户名与密码" : "已生成随机密码并复制（用户名未填）", kind: "success" });
    } catch {
      setToast({ message: "已生成随机密码（自动复制失败，请手动复制）", kind: "error" });
    }
  };

  const remove = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await api(`${adminApiBasePath}/users/${encodeURIComponent(confirmDelete.username)}/delete`, { method: "POST" });
      setConfirmDelete(null);
      refresh();
    } catch (err) {
      showError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="workspace">
      <header className="workspace-head">
        <div>
          <h1>用户管理</h1>
          <p>共 {users.length} 个管理员{isFetching ? " · 加载中" : ""} · 在此新增与管理图片管理员</p>
        </div>
      </header>
      <form className="theme-create-form" onSubmit={create}>
        <div className="theme-create-field entity-slug-field">
          <input
            className="entity-create-slug"
            value={username}
            onChange={(event) => setUsername(event.target.value.toLowerCase())}
            placeholder="用户名"
            disabled={busy}
            maxLength={32}
            autoComplete="off"
            aria-invalid={usernameInvalid}
          />
          {usernameInvalid && <p className="field-error">{slugFormatHint}</p>}
        </div>
        <div className="theme-create-field user-password-field">
          <PasswordInput
            value={password}
            onChange={setPassword}
            placeholder={`密码（${passwordPolicyHint}）`}
            disabled={busy}
            maxLength={128}
            autoComplete="new-password"
            ariaInvalid={passwordInvalid}
          />
          {passwordInvalid && <p className="field-error">{passwordPolicyHint}</p>}
        </div>
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={generatePassword}
        >
          <Icon name="shuffle-line" />生成随机密码
        </button>
        <button
          className="button"
          type="submit"
          disabled={busy || !usernameValid || !isValidAdminPassword(password)}
        >
          <Icon name="user-add-line" />新建图片管理员
        </button>
      </form>
      <PageToast message={toast.message} kind={toast.kind} onClose={clearToast} />
      <div className="entity-admin-grid admin-scroll-list" ref={listRef}>
        {users.map((user) => (
          <UserCard
            key={user.username}
            user={user}
            onResetPassword={() => setResetting(user)}
            onDelete={() => setConfirmDelete(user)}
          />
        ))}
        {!users.length && !isFetching && <p className="muted">还没有管理员</p>}
      </div>
      <OverlayScrollbar targetRef={listRef} />
      {confirmDelete && (
        <ConfirmDialog
          title="删除管理员"
          description={`删除图片管理员「${confirmDelete.username}」，该账号将无法再登录，此操作无法撤销。`}
          confirmLabel="删除"
          busy={busy}
          onClose={() => setConfirmDelete(null)}
          onConfirm={remove}
        />
      )}
      {resetting && (
        <ResetPasswordModal
          username={resetting.username}
          onClose={() => setResetting(null)}
          onError={showError}
        />
      )}
    </section>
  );
}

function UserCard({ user, onResetPassword, onDelete }: { user: AdminUser; onResetPassword: () => void; onDelete: () => void }) {
  const isSuper = user.role === "super";
  // The super admin is env-managed and can't be edited/deleted here, so its card is rendered
  // read-only and greyed (reusing the pinned-sentinel look from the 未设置 theme/作者 cards).
  return (
    <div className={`entity-card user-card${isSuper ? " is-pinned" : ""}`}>
      <div className="entity-card-row">
        <SlugChip value={user.username} ariaLabel="用户名" />
        <span className={`role-badge ${isSuper ? "role-super" : "role-image"}`}>{isSuper ? "超级管理员" : "图片管理员"}</span>
      </div>
      <div className="entity-card-foot">
        {isSuper ? (
          <span className="muted">不可修改</span>
        ) : (
          <>
            <button
              className="icon"
              type="button"
              title="重置密码"
              onClick={onResetPassword}
            >
              <Icon name="key-2-line" />
            </button>
            <button
              className="icon danger-button"
              type="button"
              title="删除管理员"
              onClick={onDelete}
            >
              <Icon name="delete-bin-6-line" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ResetPasswordModal({ username, onClose, onError }: { username: string; onClose: () => void; onError: (message: string) => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const passwordInvalid = password.length > 0 && !isValidAdminPassword(password);
  const exit = useAnimatedClose(onClose);
  useBodyScrollLock();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isValidAdminPassword(password) || busy) return;
    setBusy(true);
    onError("");
    try {
      await api(`${adminApiBasePath}/users/${encodeURIComponent(username)}/password`, { method: "POST", body: JSON.stringify({ password }) });
      exit.requestClose();
    } catch (err) {
      onError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div
      className={`modal edit-modal ${exit.closing ? "is-closing" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="重置密码"
      onAnimationEnd={exit.onAnimationEnd}
      onClick={busy ? undefined : () => exit.requestClose()}
    >
      <form className="operation-modal" onSubmit={submit} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>重置密码</h2>
            <p>为图片管理员「{username}」设置新密码（{passwordPolicyHint}）。</p>
          </div>
          <button
            className="icon close pressable"
            type="button"
            title="关闭"
            disabled={busy}
            onClick={() => exit.requestClose()}
          >
            <Icon name="close-line" />
          </button>
        </header>
        <div className="operation-body">
          <label>
            新密码
            <PasswordInput
              value={password}
              onChange={setPassword}
              placeholder={passwordPolicyHint}
              disabled={busy}
              maxLength={128}
              autoComplete="new-password"
              autoFocus
              ariaInvalid={passwordInvalid}
            />
            {passwordInvalid && <p className="field-error">{passwordPolicyHint}</p>}
          </label>
        </div>
        <footer>
          <button type="button" disabled={busy} onClick={() => exit.requestClose()}>取消</button>
          <button className="button" type="submit" disabled={busy || !isValidAdminPassword(password)}>
            <Icon name="key-2-line" />{busy ? "重置中…" : "重置密码"}
          </button>
        </footer>
      </form>
    </div>
  );
}
