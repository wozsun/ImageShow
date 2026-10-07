import { useId, useRef, useState } from "react";
import { AdminIcon } from "../../../components/icon/AdminIcon.js";
import { AsyncActionButton } from "../../../components/actions/AsyncActionButton.js";
import { DialogFrame } from "../../../components/dialog/DialogFrame.js";
import { NumberInput } from "../../../components/form/NumberInput.js";
import { FieldError } from "../../../components/form/FieldError.js";
import { apiValidationIssues } from "../../../lib/api/client.js";
import { OverlayScrollbar } from "../../../components/layout/OverlayScrollbar.js";
import { storageBackendDisplay, storageTypeLabel } from "../../../lib/ui/select-options.js";
import {
  type S3Settings,
  storageBackendEditConfigPatch,
  storageBackendS3AfterSuccessfulSave,
  storageBackendS3FormSettings
} from "./storage-backend-form.js";
import type { StorageBackendAdminDto } from "@imageshow/shared/browser";
import { useAsyncActionStatus } from "../../../hooks/useAsyncActionStatus.js";

const storageTestPresentation = {
  idle: { icon: "flask-line", label: "连接测试" },
  pending: { icon: "flask-line", label: "测试中" },
  success: { icon: "check-line", label: "连接成功" },
  error: { icon: "close-line", label: "连接失败" }
} as const;

type StorageSaveOperation = "create" | "save";

/** 保存或测试连接的结果；失败时附带原始错误，用于标出出错的输入框与说明原因。 */
export type StorageFormOutcome = { succeeded: true } | { succeeded: false; error?: unknown };

type FieldErrorLookup = (field: string) => string | undefined;

// 窗口中有输入框的字段（服务端校验路径）；校验问题落在其余路径时写在窗口顶部。
const storageFormFields = new Set([
  "slug",
  "display_name",
  "public_base_url",
  ...[
    "endpoint",
    "region",
    "bucket",
    "access_key_id",
    "secret_access_key",
    "root_path",
    "public_base_url",
    "force_path_style",
    "connect_timeout_seconds",
    "idle_timeout_seconds",
    "task_timeout_seconds"
  ].map((key) => `s3.${key}`)
]);

export function StorageBackendModal({
  target,
  busy,
  onClose,
  onSave,
  onTest
}: {
  target: StorageBackendAdminDto | "new";
  busy: string;
  onClose: () => void;
  onSave: (
    slug: string,
    payload: Record<string, unknown>,
    isCreate: boolean
  ) => Promise<StorageFormOutcome>;
  onTest: (body: unknown) => Promise<StorageFormOutcome>;
}) {
  const creating = target === "new";
  const backend = creating ? null : target;
  const isLocal = backend?.type === "local";
  const locationLocked = Boolean(
    backend?.image_count
      || backend?.ingestion_session_count
      || backend?.cleanup_job_count
  );
  const locationUsage = backend
    ? [
        backend.image_count ? `${backend.image_count} 张图片` : "",
        backend.ingestion_session_count
          ? `${backend.ingestion_session_count} 个未清理内容接入会话`
          : "",
        backend.cleanup_job_count
          ? `${backend.cleanup_job_count} 个旧对象删除任务`
          : "",
        backend.failed_cleanup_job_count
          ? `${backend.failed_cleanup_job_count} 个删除任务失败`
          : ""
      ]
        .filter(Boolean)
        .join("、")
    : "";
  const locationUnlockGuidance = backend
    ? [
        backend.image_count ? "通过图片存储迁移搬空后端" : "",
        backend.ingestion_session_count ? "等待内容接入会话完成清理" : "",
        backend.exhausted_cleanup_job_count
          ? "关闭窗口后在存储卡片重试已停止自动重试的旧对象删除任务"
          : backend.cleanup_job_count
            ? "等待旧对象删除任务完成"
            : ""
      ]
        .filter(Boolean)
        .join("，并")
    : "";
  const [slug, setSlug] = useState(backend?.slug ?? "");
  const [displayName, setDisplayName] = useState(backend?.display_name ?? "");
  const [localPublicUrl, setLocalPublicUrl] = useState(
    backend?.type === "local" ? backend.public_base_url : ""
  );
  const [s3, setS3] = useState<S3Settings>(() =>
    storageBackendS3FormSettings(backend?.type === "s3" ? backend : undefined)
  );
  const effectiveType = creating ? "s3" : backend!.type;
  const titleId = useId();
  const descriptionId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  // 保存或测试连接失败时的问题：能对应到输入框的按字段标红，其余写在窗口顶部。
  const [fieldErrors, setFieldErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [formError, setFormError] = useState("");
  const errorFor: FieldErrorLookup = (field) => fieldErrors.get(field);
  const clearFieldErrors = (fields: readonly string[]) => {
    setFieldErrors((current) => {
      if (!fields.some((field) => current.has(field))) return current;
      const next = new Map(current);
      for (const field of fields) next.delete(field);
      return next;
    });
  };
  const updateS3 = (next: S3Settings) => {
    clearFieldErrors(
      (Object.keys(next) as (keyof S3Settings)[])
        .filter((key) => next[key] !== s3[key])
        .map((key) => `s3.${key}`)
    );
    setS3(next);
  };
  const runWithFailureDetails = async (operation: () => Promise<StorageFormOutcome>) => {
    setFieldErrors(new Map());
    setFormError("");
    const outcome = await operation();
    if (!outcome.succeeded && outcome.error !== undefined) {
      const issues = apiValidationIssues(outcome.error);
      const fieldIssues = issues.filter((issue) => storageFormFields.has(issue.field));
      setFieldErrors(new Map(fieldIssues.map((issue) => [issue.field, issue.message])));
      setFormError(
        issues.length
          ? issues
            .filter((issue) => !storageFormFields.has(issue.field))
            .map((issue) => issue.message)
            .join("；")
          : outcome.error instanceof Error
            ? outcome.error.message
            : "操作失败，请稍后重试"
      );
    }
    return outcome.succeeded;
  };
  const [saveOperation, setSaveOperation] = useState<StorageSaveOperation>(
    creating ? "create" : "save"
  );
  const connectionTest = useAsyncActionStatus();
  const saveStatus = useAsyncActionStatus();

  const isCreateForm = creating && createdSlug === null;
  const formBusy = Boolean(busy)
    || connectionTest.pending
    || saveStatus.pending;
  const savePresentation = {
    idle: {
      icon: "save-3-line",
      label: isCreateForm ? "新建" : "保存"
    },
    pending: {
      icon: "save-3-line",
      label: saveOperation === "create" ? "新建中" : "保存中"
    },
    success: {
      icon: "check-line",
      label: saveOperation === "create" ? "新建成功" : "保存成功"
    },
    error: {
      icon: "close-line",
      label: saveOperation === "create" ? "新建失败" : "保存失败"
    }
  } as const;
  const configPayload = () => {
    if (isLocal) return {};
    const { secret_access_key, ...settings } = s3;
    if (backend?.type === "s3") {
      return storageBackendEditConfigPatch(backend, s3);
    }
    return {
      s3: secret_access_key ? { ...settings, secret_access_key } : settings
    };
  };
  const submit = async () => {
    const creatingNow = isCreateForm;
    setSaveOperation(creatingNow ? "create" : "save");
    const targetSlug = creatingNow ? slug : (createdSlug ?? backend!.slug);
    const payload = creatingNow
      ? { slug, display_name: displayName, s3 }
      : {
          display_name: displayName,
          ...(isLocal ? { public_base_url: localPublicUrl } : configPayload())
        };
    const succeeded = await saveStatus.run(() =>
      runWithFailureDetails(() => onSave(targetSlug, payload, creatingNow)));
    if (succeeded) {
      setS3(storageBackendS3AfterSuccessfulSave);
      if (creatingNow) setCreatedSlug(slug);
    }
  };
  const testBody = () => ({
    ...(createdSlug || backend?.slug ? { slug: createdSlug ?? backend!.slug } : {}),
    ...configPayload()
  });
  const runConnectionTest = async () => {
    await connectionTest.run(() => runWithFailureDetails(() => onTest(testBody())));
  };
  return (
    <DialogFrame
      className="modal edit-modal is-mobile-fullscreen"
      titleId={titleId}
      descriptionId={isCreateForm ? undefined : descriptionId}
      busy={formBusy}
      initialFocusRef={closeButtonRef}
      onClose={onClose}
    >
      {({ requestClose }) => (
        <form
          className="operation-modal storage-edit-modal"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <header>
            <div>
              <h2 id={titleId}>
                {isCreateForm
                  ? "新增存储后端"
                  : `编辑：${storageBackendDisplay(backend ?? { slug: createdSlug!, display_name: displayName })}`}
              </h2>
              {!isCreateForm && (
                <p id={descriptionId}>
                  {createdSlug ?? backend!.slug} · {storageTypeLabel(effectiveType)}
                </p>
              )}
            </div>
            <button
              ref={closeButtonRef}
              className="icon close pressable"
              type="button"
              title="关闭"
              disabled={formBusy}
              onClick={() => requestClose()}
            >
              <AdminIcon name="close-line" />
            </button>
          </header>
          <div className="operation-body" ref={bodyRef}>
            {formError && (
              <p className="admin-error" role="alert">
                {formError}
              </p>
            )}
            {creating && (
              <label>
                标识 slug
                <input
                  value={slug}
                  aria-invalid={Boolean(errorFor("slug")) || undefined}
                  onChange={(event) => {
                    clearFieldErrors(["slug"]);
                    setSlug(event.target.value);
                  }}
                  placeholder="小写字母/数字/连字符"
                  disabled={!isCreateForm}
                />
                <FieldError message={errorFor("slug")} />
              </label>
            )}
            <label>
              显示名
              <input
                value={displayName}
                aria-invalid={Boolean(errorFor("display_name")) || undefined}
                onChange={(event) => {
                  clearFieldErrors(["display_name"]);
                  setDisplayName(event.target.value);
                }}
                placeholder={creating ? "存储后端名称" : backend!.slug}
              />
              <FieldError message={errorFor("display_name")} />
            </label>
            {isLocal ? (
              <>
                <label>
                  公开 URL
                  <input
                    value={localPublicUrl}
                    aria-invalid={Boolean(errorFor("public_base_url")) || undefined}
                    onChange={(event) => {
                      clearFieldErrors(["public_base_url"]);
                      setLocalPublicUrl(event.target.value);
                    }}
                    placeholder="https://images.example.com"
                  />
                  <FieldError message={errorFor("public_base_url")} />
                </label>
                <p className="hint">
                  完整图与缩略图共用，可包含路径前缀；留空使用主站地址。独立 Host
                  的图片请求由本机读取本地存储。
                </p>
              </>
            ) : (
              <>
                {locationLocked && (
                  <p className="notice-line" role="note">
                    此后端仍有 {locationUsage}。Bucket / 根目录已锁定； 如需改变请先
                    {locationUnlockGuidance}。Endpoint 仍可修改，
                    保存时服务端会证明新旧地址指向同一命名空间；验证失败会保留原配置。
                  </p>
                )}
                <S3Fields
                  value={s3}
                  errorFor={errorFor}
                  onChange={updateS3}
                  configured={
                    backend?.type === "s3" ? backend.s3.secret_access_key_configured : undefined
                  }
                  locationLocked={locationLocked}
                />
              </>
            )}
          </div>
          <OverlayScrollbar targetRef={bodyRef} />
          <footer>
            <div className="storage-modal-left">
              <AsyncActionButton
                type="button"
                className="storage-test-button"
                status={connectionTest.status}
                presentation={storageTestPresentation}
                disabled={formBusy}
                onClick={() => void runConnectionTest()}
              />
            </div>
            <div className="modal-footer-actions">
              <button type="button" disabled={formBusy} onClick={() => requestClose()}>
                取消
              </button>
              <AsyncActionButton
                className="button"
                type="submit"
                status={saveStatus.status}
                presentation={savePresentation}
                disabled={formBusy || (isCreateForm && !slug)}
              />
            </div>
          </footer>
        </form>
      )}
    </DialogFrame>
  );
}

function S3Fields({
  value,
  errorFor,
  onChange,
  configured,
  locationLocked
}: {
  value: S3Settings;
  errorFor: FieldErrorLookup;
  onChange: (next: S3Settings) => void;
  configured?: boolean;
  locationLocked: boolean;
}) {
  const patch = (next: Partial<S3Settings>) => onChange({ ...value, ...next });
  const s3ErrorFor: FieldErrorLookup = (key) => errorFor(`s3.${key}`);
  const invalid = (key: keyof S3Settings) => Boolean(s3ErrorFor(key)) || undefined;
  return (
    <>
      <label>
        Endpoint
        <input
          value={value.endpoint}
          aria-invalid={invalid("endpoint")}
          onChange={(event) => patch({ endpoint: event.target.value })}
          placeholder="（https://）s3.example.com"
        />
        <FieldError message={s3ErrorFor("endpoint")} />
      </label>
      <label>
        Region
        <input
          value={value.region}
          aria-invalid={invalid("region")}
          onChange={(event) => patch({ region: event.target.value })}
        />
        <FieldError message={s3ErrorFor("region")} />
      </label>
      <label>
        Bucket
        <input
          value={value.bucket}
          aria-invalid={invalid("bucket")}
          onChange={(event) => patch({ bucket: event.target.value })}
          disabled={locationLocked}
        />
        <FieldError message={s3ErrorFor("bucket")} />
      </label>
      <label>
        Access Key
        <input
          value={value.access_key_id}
          aria-invalid={invalid("access_key_id")}
          onChange={(event) => patch({ access_key_id: event.target.value })}
        />
        <FieldError message={s3ErrorFor("access_key_id")} />
      </label>
      <label>
        Secret Key
        <input
          type="password"
          placeholder={configured ? "已配置" : ""}
          value={value.secret_access_key ?? ""}
          aria-invalid={invalid("secret_access_key")}
          onChange={(event) => patch({ secret_access_key: event.target.value })}
        />
        <FieldError message={s3ErrorFor("secret_access_key")} />
      </label>
      <StorageLocationFields
        rootPath={value.root_path}
        publicBaseUrl={value.public_base_url}
        locationLocked={locationLocked}
        errorFor={s3ErrorFor}
        onChange={patch}
      />
      <label>
        <input
          type="checkbox"
          checked={value.force_path_style}
          onChange={(event) => patch({ force_path_style: event.target.checked })}
        />
        Path-style
        <FieldError message={s3ErrorFor("force_path_style")} />
      </label>
      <StorageRequestTimeoutFields
        value={value}
        errorFor={s3ErrorFor}
        onChange={patch}
        connectLabel="连接超时（秒）"
      />
    </>
  );
}

function StorageRequestTimeoutFields({
  value,
  errorFor,
  onChange,
  connectLabel
}: {
  value: Pick<
    S3Settings,
    "connect_timeout_seconds" | "idle_timeout_seconds" | "task_timeout_seconds"
  >;
  onChange: (
    patch: Partial<
      Pick<S3Settings, "connect_timeout_seconds" | "idle_timeout_seconds" | "task_timeout_seconds">
    >
  ) => void;
  errorFor: FieldErrorLookup;
  connectLabel: string;
}) {
  return (
    <>
      <label>
        {connectLabel}
        <NumberInput
          min={1}
          max={120}
          value={value.connect_timeout_seconds}
          ariaInvalid={Boolean(errorFor("connect_timeout_seconds"))}
          onChange={(connect_timeout_seconds) =>
            onChange({
              connect_timeout_seconds
            })
          }
        />
        <FieldError message={errorFor("connect_timeout_seconds")} />
      </label>
      <label>
        流读取空闲超时（秒）
        <NumberInput
          min={1}
          max={300}
          value={value.idle_timeout_seconds}
          ariaInvalid={Boolean(errorFor("idle_timeout_seconds"))}
          onChange={(idle_timeout_seconds) =>
            onChange({
              idle_timeout_seconds
            })
          }
        />
        <FieldError message={errorFor("idle_timeout_seconds")} />
      </label>
      <label>
        单次任务总超时（秒）
        <NumberInput
          min={15}
          max={3600}
          value={value.task_timeout_seconds}
          ariaInvalid={Boolean(errorFor("task_timeout_seconds"))}
          onChange={(task_timeout_seconds) =>
            onChange({
              task_timeout_seconds
            })
          }
        />
        <FieldError message={errorFor("task_timeout_seconds")} />
      </label>
    </>
  );
}

function StorageLocationFields({
  rootPath,
  publicBaseUrl,
  locationLocked,
  errorFor,
  onChange
}: {
  rootPath: string;
  publicBaseUrl: string;
  locationLocked: boolean;
  errorFor: FieldErrorLookup;
  onChange: (patch: { root_path?: string; public_base_url?: string }) => void;
}) {
  return (
    <>
      <label>
        根目录
        <input
          value={rootPath}
          aria-invalid={Boolean(errorFor("root_path")) || undefined}
          onChange={(event) => onChange({ root_path: event.target.value })}
          placeholder="/ 或 /imageshow"
          disabled={locationLocked}
        />
        <FieldError message={errorFor("root_path")} />
      </label>
      <label>
        Public Base URL
        <input
          value={publicBaseUrl}
          aria-invalid={Boolean(errorFor("public_base_url")) || undefined}
          onChange={(event) =>
            onChange({
              public_base_url: event.target.value
            })
          }
          placeholder="https://cdn.example.com"
        />
        <FieldError message={errorFor("public_base_url")} />
      </label>
    </>
  );
}
