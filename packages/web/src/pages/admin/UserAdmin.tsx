import { useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, isApiClientError } from "../../lib/api/client.js";
import { Icon } from "../../components/icon/Icon.js";
import { AsyncActionButton } from "../../components/actions/AsyncActionButton.js";
import { StableButtonLabel } from "../../components/data-display/StableButtonLabel.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { ConfirmDialog } from "../../components/feedback/ConfirmDialog.js";
import { DialogFrame } from "../../components/feedback/DialogFrame.js";
import { adminApiBasePath, slugFormatHint, slugPattern } from "../../lib/constants.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { PasswordInput } from "../../components/form/PasswordInput.js";
import { SlugChip } from "../../components/data-display/SlugChip.js";
import { WorkspaceHeader } from "../../components/layout/WorkspaceHeader.js";
import { generateAdminPassword, isValidAdminPassword, passwordPolicyHint } from "../../lib/auth/password.js";
import type { AdminUser } from "../../lib/types.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { useAsyncActionStatus } from "../../hooks/useAsyncActionStatus.js";

const generatePasswordPresentation = {
  idle: { icon: "shuffle-line", label: "生成随机密码" },
  pending: { icon: "shuffle-line", label: "正在生成密码" },
  success: { icon: "check-line", label: "密码生成成功" },
  error: { icon: "close-line", label: "密码复制失败" }
} as const;

const resetPasswordPresentation = {
  idle: { icon: "key-2-line", label: "重置密码" },
  pending: { icon: "key-2-line", label: "重置中" },
  success: { icon: "check-line", label: "重置成功" },
  error: { icon: "close-line", label: "重置失败" }
} as const;

export function UserAdmin() {
  const client = useQueryClient();
  const { data, error: listError, isError: listFailed, isFetching, refetch } = useQuery<{ items: AdminUser[] }>({ queryKey: queryKeys.users, queryFn: ({ signal }) => api(`${adminApiBasePath}/users`, { signal }) });
  const users = data?.items ?? [];
  const refresh = () => client.invalidateQueries({ queryKey: queryKeys.users });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [mutation, setMutation] = useState<"" | "delete">("");
  const [createError, setCreateError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<AdminUser | null>(null);
  const [resetting, setResetting] = useState<AdminUser | null>(null);
  const resetPasswordTriggerRef = useRef<HTMLButtonElement | null>(null);
  const createAction = useAsyncActionStatus({ resultDurationMs: null });
  const generatePasswordStatus = useAsyncActionStatus();
  const listRef = useRef<HTMLDivElement | null>(null);
  const usernameInvalid = username.length > 0 && !slugPattern.test(username);
  const usernameError = usernameInvalid ? slugFormatHint : createError;
  const usernameValid = username.trim().length > 0 && slugPattern.test(username.trim());
  const passwordInvalid = password.length > 0 && !isValidAdminPassword(password);
  const createFormBusy = Boolean(mutation)
    || createAction.pending
    || generatePasswordStatus.pending;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const name = username.trim();
    if (
      !usernameValid
      || !isValidAdminPassword(password)
      || Boolean(mutation)
      || createAction.pending
      || generatePasswordStatus.pending
    ) return;
    if (users.some((user) => user.username === name)) {
      setCreateError("用户名已存在");
      return;
    }

    setCreateError("");
    await createAction.run(async () => {
      try {
        await api(`${adminApiBasePath}/users`, {
          method: "POST",
          body: JSON.stringify({ username: name, password })
        });
        setUsername("");
        setPassword("");
        await refresh();
        return true;
      } catch (error) {
        reportAdminUiError("user_admin.create", error);
        setCreateError(
          isApiClientError(error) && (error.status === 409 || error.code === "username_taken")
            ? "用户名已存在"
            : "管理员创建失败，请稍后重试"
        );
        return false;
      }
    });
  };

  const generatePassword = async () => {
    if (mutation || createAction.pending || generatePasswordStatus.pending) return;
    const pwd = generateAdminPassword();
    setPassword(pwd);
    const name = username.trim();
    await generatePasswordStatus.run(async () => {
      try {
        await navigator.clipboard.writeText(`用户名：${name}\n密码：${pwd}`);
        return true;
      } catch (error) {
        reportAdminUiError("user_admin.copy_generated_password", error);
        return false;
      }
    });
  };

  const remove = async () => {
    if (!confirmDelete) return false;
    setMutation("delete");
    try {
      await api(`${adminApiBasePath}/users/${encodeURIComponent(confirmDelete.username)}/delete`, { method: "POST" });
      await refresh();
      return true;
    } catch (err) {
      reportAdminUiError("user_admin.delete", err);
      return false;
    } finally {
      setMutation("");
    }
  };

  return (
    <section className="workspace">
      <WorkspaceHeader
        title="用户管理"
        description={`共 ${users.length} 个管理员${isFetching ? " · 加载中" : ""} · 在此新增与管理图片管理员`}
      />
      <form className="admin-create-form" onSubmit={create}>
        <div className="admin-create-field entity-slug-field">
          <input
            className="entity-create-slug"
            value={username}
            onChange={(event) => {
              setUsername(event.target.value.toLowerCase());
              setCreateError("");
            }}
            placeholder="用户名"
            disabled={createFormBusy}
            maxLength={32}
            autoComplete="off"
            aria-invalid={Boolean(usernameError)}
          />
          {usernameError && <p className="field-error" role="alert">{usernameError}</p>}
        </div>
        <div className="admin-create-field user-password-field">
          <PasswordInput
            value={password}
            onChange={setPassword}
            placeholder={`密码（${passwordPolicyHint}）`}
            disabled={createFormBusy}
            maxLength={128}
            autoComplete="new-password"
            ariaInvalid={passwordInvalid}
          />
          {passwordInvalid && <p className="field-error">{passwordPolicyHint}</p>}
        </div>
        <AsyncActionButton
          type="button"
          className="button secondary"
          status={generatePasswordStatus.status}
          presentation={generatePasswordPresentation}
          disabled={createFormBusy}
          onClick={() => void generatePassword()}
        />
        <button
          className="button"
          type="submit"
          disabled={createFormBusy || !usernameValid || !isValidAdminPassword(password)}
        >
          <Icon name="user-add-line" />
          <StableButtonLabel
            idle="新建图片管理员"
            busyText="新建中"
            busy={createAction.pending}
          />
        </button>
      </form>
      <div className="entity-admin-grid admin-scroll-list" ref={listRef}>
        {users.map((user) => (
          <UserCard
            key={user.username}
            user={user}
            onResetPassword={(trigger) => {
              resetPasswordTriggerRef.current = trigger;
              setResetting(user);
            }}
            onDelete={() => setConfirmDelete(user)}
          />
        ))}
        {listFailed && <QueryErrorState error={listError} onRetry={() => void refetch()} reportContext="user_admin.load" />}
        {!listFailed && !users.length && !isFetching && <p className="muted">还没有管理员</p>}
      </div>
      <OverlayScrollbar targetRef={listRef} />
      {confirmDelete && (
        <ConfirmDialog
          title="删除管理员"
          description={`删除图片管理员「${confirmDelete.username}」，该账号将无法再登录，此操作无法撤销。`}
          confirmLabel="删除"
          busy={mutation === "delete"}
          onClose={() => setConfirmDelete(null)}
          onConfirm={remove}
        />
      )}
      {resetting && (
        <ResetPasswordModal
          username={resetting.username}
          returnFocusRef={resetPasswordTriggerRef}
          onClose={() => setResetting(null)}
          onError={(error) => reportAdminUiError("user_admin.reset_password", error)}
        />
      )}
    </section>
  );
}

function UserCard({ user, onResetPassword, onDelete }: {
  user: AdminUser;
  onResetPassword: (trigger: HTMLButtonElement) => void;
  onDelete: () => void;
}) {
  const isSuper = user.role === "super";
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
              onClick={(event) => onResetPassword(event.currentTarget)}
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

function ResetPasswordModal({ username, returnFocusRef, onClose, onError }: {
  username: string;
  returnFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onError: (error: unknown) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const [password, setPassword] = useState("");
  const resetPasswordStatus = useAsyncActionStatus({ successDurationMs: null });
  const passwordInvalid = password.length > 0 && !isValidAdminPassword(password);

  const submit = async (event: FormEvent, requestClose: () => void) => {
    event.preventDefault();
    if (!isValidAdminPassword(password) || resetPasswordStatus.pending) return;
    const succeeded = await resetPasswordStatus.run(async () => {
      try {
        await api(`${adminApiBasePath}/users/${encodeURIComponent(username)}/password`, {
          method: "POST",
          body: JSON.stringify({ password })
        });
        return true;
      } catch (error) {
        onError(error);
        return false;
      }
    });
    if (succeeded) requestClose();
  };

  return (
    <DialogFrame
      className="modal edit-modal"
      titleId={titleId}
      descriptionId={descriptionId}
      busy={resetPasswordStatus.pending}
      initialFocusRef={passwordInputRef}
      returnFocusRef={returnFocusRef}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <form className="operation-modal" onSubmit={(event) => void submit(event, requestClose)}>
          <header>
            <div>
              <h2 id={titleId}>重置密码</h2>
              <p id={descriptionId}>
                为图片管理员「{username}」设置新密码（{passwordPolicyHint}）。
              </p>
            </div>
            <button
              className="icon close pressable"
              type="button"
              title="关闭"
              disabled={resetPasswordStatus.pending}
              onClick={() => requestClose()}
            >
              <Icon name="close-line" />
            </button>
          </header>
          <div className="operation-body">
            <label>
              新密码
              <PasswordInput
                inputRef={passwordInputRef}
                value={password}
                onChange={setPassword}
                placeholder={passwordPolicyHint}
                disabled={resetPasswordStatus.pending}
                maxLength={128}
                autoComplete="new-password"
                autoFocus
                ariaInvalid={passwordInvalid}
              />
              {passwordInvalid && <p className="field-error">{passwordPolicyHint}</p>}
            </label>
          </div>
          <footer>
            <button type="button" disabled={resetPasswordStatus.pending} onClick={() => requestClose()}>取消</button>
            <AsyncActionButton
              className="button"
              type="submit"
              status={resetPasswordStatus.status}
              presentation={resetPasswordPresentation}
              disabled={resetPasswordStatus.pending || !isValidAdminPassword(password)}
            />
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}
