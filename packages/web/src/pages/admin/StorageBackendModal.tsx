import { useRef, useState } from "react";
import { Icon } from "../../components/icon/Icon.js";
import { AsyncActionButton } from "../../components/actions/AsyncActionButton.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { storageBackendDisplay, storageTypeLabel } from "../../lib/ui/select-options.js";
import type { S3Settings, StorageBackendAdmin, StorageType, WebdavSettings } from "../../lib/types.js";
import {
  useAsyncActionStatus,
  type AsyncActionStatus
} from "../../hooks/useAsyncActionStatus.js";

const emptyS3: S3Settings = {
  endpoint: "", region: "auto", bucket: "", access_key_id: "",
  force_path_style: true, root_path: "/", public_base_url: "", secret_access_key: ""
};

const emptyWebdav: WebdavSettings = {
  base_url: "", username: "", root_path: "/", public_base_url: "", password: "", list_depth_infinity: false,
  connect_timeout_seconds: 15, idle_timeout_seconds: 15, task_timeout_seconds: 300
};

const storageTypeOptions = [
  { value: "s3", label: "对象存储 (S3)" },
  { value: "webdav", label: "WebDAV" }
];

const storageTestPresentation = {
  idle: { icon: "flask-line", label: "连接测试" },
  pending: { icon: "flask-line", label: "测试中" },
  success: { icon: "check-line", label: "连接成功" },
  error: { icon: "close-line", label: "连接失败" }
} as const;

const setDefaultPresentation = {
  idle: { icon: "star-line", label: "设为默认" },
  pending: { icon: "star-line", label: "设置中" },
  success: { icon: "check-line", label: "已是默认" },
  error: { icon: "close-line", label: "设置失败" }
} as const;

type StorageSaveOperation = "create" | "save";

export function StorageBackendModal({ target, busy, defaultStatus, defaultActionPending, onClose, onSave, onSetDefault, onTest }: {
  target: StorageBackendAdmin | "new";
  busy: string;
  defaultStatus: AsyncActionStatus;
  defaultActionPending: boolean;
  onClose: () => void;
  onSave: (slug: string, payload: Record<string, unknown>, isCreate: boolean) => Promise<boolean>;
  onSetDefault: (slug: string) => Promise<boolean>;
  onTest: (body: unknown) => Promise<boolean>;
}) {
  const creating = target === "new";
  const backend = creating ? null : target;
  const isLocal = backend?.type === "local";
  const locationLocked = Boolean(
    backend?.image_count
      || backend?.import_session_count
      || backend?.cleanup_job_count
  );
  const locationUsage = backend
    ? [
        backend.image_count ? `${backend.image_count} 张图片` : "",
        backend.import_session_count
          ? `${backend.import_session_count} 个未清理导入会话`
          : "",
        backend.cleanup_job_count
          ? `${backend.cleanup_job_count} 个待处理清理任务`
          : ""
      ].filter(Boolean).join("、")
    : "";
  const locationUnlockGuidance = backend
    ? [
        backend.image_count ? "通过图片存储迁移搬空后端" : "",
        backend.import_session_count ? "等待导入会话完成清理" : "",
        backend.cleanup_job_count ? "等待对象清理任务解决" : ""
      ].filter(Boolean).join("，并")
    : "";
  const [slug, setSlug] = useState(backend?.slug ?? "");
  const [displayName, setDisplayName] = useState(backend?.display_name ?? "");
  const [type, setType] = useState<StorageType>(backend?.type ?? "s3");
  const [s3, setS3] = useState<S3Settings>({
    ...emptyS3,
    ...(backend?.type === "s3" ? backend.s3 : {}),
    secret_access_key: ""
  });
  const [webdav, setWebdav] = useState<WebdavSettings>({
    ...emptyWebdav,
    ...(backend?.type === "webdav" ? backend.webdav : {}),
    password: ""
  });

  const effectiveType: StorageType = creating ? type : backend!.type;
  const isWebdav = effectiveType === "webdav";
  const exit = useAnimatedClose(onClose);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const [saveOperation, setSaveOperation] = useState<StorageSaveOperation>(
    creating ? "create" : "save"
  );
  const connectionTest = useAsyncActionStatus();
  const saveStatus = useAsyncActionStatus();

  const isCreateForm = creating && createdSlug === null;
  const formBusy = Boolean(busy)
    || connectionTest.pending
    || saveStatus.pending
    || defaultActionPending;
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
  const configPayload = () => isLocal ? {} : isWebdav ? { webdav } : { s3 };
  const submit = async () => {
    const creatingNow = isCreateForm;
    setSaveOperation(creatingNow ? "create" : "save");
    const targetSlug = creatingNow ? slug : createdSlug ?? backend!.slug;
    const payload = creatingNow
      ? { slug, display_name: displayName, type: effectiveType, ...configPayload() }
      : { display_name: displayName, ...(isLocal ? {} : configPayload()) };
    const succeeded = await saveStatus.run(() => onSave(targetSlug, payload, creatingNow));
    if (succeeded && creatingNow) setCreatedSlug(slug);
  };
  const testBody = () => ({
    ...(createdSlug || backend?.slug ? { slug: createdSlug ?? backend!.slug } : {}),
    type: effectiveType,
    ...configPayload()
  });
  const runConnectionTest = async () => {
    await connectionTest.run(() => onTest(testBody()));
  };
  const setAsDefault = async () => {
    await onSetDefault(backend!.slug);
  };
  const currentDefaultPresentation = {
    ...setDefaultPresentation,
    idle: backend?.is_default
      ? { icon: "star-fill" as const, label: "默认" }
      : setDefaultPresentation.idle
  } as const;

  return (
    <div
      className={`modal edit-modal ${exit.closing ? "is-closing" : ""}`}
      onAnimationEnd={exit.onAnimationEnd}
    >
      <form
        className="operation-modal storage-edit-modal"
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <header>
          <div>
            <h2>{isCreateForm ? "新增存储后端" : `编辑：${storageBackendDisplay(backend ?? { slug: createdSlug!, display_name: displayName })}`}</h2>
            {!isCreateForm && <p>{createdSlug ?? backend!.slug} · {storageTypeLabel(effectiveType)}</p>}
          </div>
          <button
            className="icon close pressable"
            type="button"
            title="关闭"
            disabled={formBusy}
            onClick={() => exit.requestClose()}
          >
            <Icon name="close-line" />
          </button>
        </header>
        <div className="operation-body" ref={bodyRef}>
          {creating && (
            <label>
              标识 slug
              <input
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="小写字母/数字/连字符"
                disabled={!isCreateForm}
              />
            </label>
          )}
          <label>
            显示名
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={creating ? "存储后端名称" : backend!.slug}
            />
          </label>
          {isCreateForm && (
            <label>
              存储类型
              <SelectMenu
                value={type}
                onChange={(value) => setType(value as StorageType)}
                options={storageTypeOptions}
                ariaLabel="存储类型"
              />
            </label>
          )}
          {isLocal ? (
            <p className="hint">本地存储无需额外配置，图片保存在容器的存储目录。</p>
          ) : (
            <>
              {locationLocked && (
                <p className="notice-line" role="note">
                  此后端仍有 {locationUsage}。Endpoint / Bucket /
                  Base URL / 根目录等物理位置字段已锁定；请先{locationUnlockGuidance}。
                  凭据及访问参数仍可轮换，保存前服务端会验证读写能力。
                </p>
              )}
              {isWebdav
                ? <WebdavFields value={webdav} onChange={setWebdav} configured={backend?.type === "webdav" ? backend.webdav.password_configured : undefined} locationLocked={locationLocked} />
                : <S3Fields value={s3} onChange={setS3} configured={backend?.type === "s3" ? backend.s3.secret_access_key_configured : undefined} locationLocked={locationLocked} />}
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
            {!creating && backend!.enabled && (
              <AsyncActionButton
                type="button"
                status={defaultStatus}
                presentation={currentDefaultPresentation}
                disabled={formBusy || backend!.is_default}
                onClick={() => void setAsDefault()}
              />
            )}
          </div>
          <div className="modal-footer-actions">
            <button type="button" disabled={formBusy} onClick={() => exit.requestClose()}>取消</button>
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
    </div>
  );
}

function S3Fields({ value, onChange, configured, locationLocked }: { value: S3Settings; onChange: (next: S3Settings) => void; configured?: boolean; locationLocked: boolean }) {
  const patch = (next: Partial<S3Settings>) => onChange({ ...value, ...next });
  return (
    <>
      <label>
        Endpoint
        <input value={value.endpoint} onChange={(event) => patch({ endpoint: event.target.value })} placeholder="（https://）s3.example.com" disabled={locationLocked} />
      </label>
      <label>
        Region
        <input
          value={value.region}
          onChange={(event) => patch({ region: event.target.value })}
        />
      </label>
      <label>
        Bucket
        <input value={value.bucket} onChange={(event) => patch({ bucket: event.target.value })} disabled={locationLocked} />
      </label>
      <label>
        Access Key
        <input value={value.access_key_id} onChange={(event) => patch({ access_key_id: event.target.value })} />
      </label>
      <label>
        Secret Key
        <input
          type="password"
          placeholder={configured ? "已配置" : ""}
          value={value.secret_access_key ?? ""}
          onChange={(event) => patch({ secret_access_key: event.target.value })}
        />
      </label>
      <label>
        根目录
        <input value={value.root_path} onChange={(event) => patch({ root_path: event.target.value })} placeholder="/ 或 /imageshow" disabled={locationLocked} />
      </label>
      <label>
        Public Base URL
        <input value={value.public_base_url} onChange={(event) => patch({ public_base_url: event.target.value })} placeholder="https://cdn.example.com" />
      </label>
      <label>
        <input type="checkbox" checked={value.force_path_style} onChange={(event) => patch({ force_path_style: event.target.checked })} />
        Path-style
      </label>
    </>
  );
}

function WebdavFields({ value, onChange, configured, locationLocked }: { value: WebdavSettings; onChange: (next: WebdavSettings) => void; configured?: boolean; locationLocked: boolean }) {
  const patch = (next: Partial<WebdavSettings>) => onChange({ ...value, ...next });
  return (
    <>
      <p className="hint">密码保存后只显示“已配置”；上传统一经服务器中转写入 WebDAV。用户名/密码留空则匿名访问。</p>
      <label>
        Base URL
        <input value={value.base_url} onChange={(event) => patch({ base_url: event.target.value })} placeholder="https://dav.example.com/dav" disabled={locationLocked} />
      </label>
      <label>
        用户名
        <input value={value.username} onChange={(event) => patch({ username: event.target.value })} />
      </label>
      <label>
        密码
        <input
          type="password"
          placeholder={configured ? "已配置" : ""}
          value={value.password ?? ""}
          onChange={(event) => patch({ password: event.target.value })}
        />
      </label>
      <label>
        根目录
        <input value={value.root_path} onChange={(event) => patch({ root_path: event.target.value })} placeholder="/ 或 /imageshow" disabled={locationLocked} />
      </label>
      <label>
        Public Base URL
        <input value={value.public_base_url} onChange={(event) => patch({ public_base_url: event.target.value })} placeholder="https://cdn.example.com" />
      </label>
      <label>
        连接 / 首字节超时（秒）
        <input type="number" min="1" max="120" value={value.connect_timeout_seconds} onChange={(event) => patch({ connect_timeout_seconds: Number(event.target.value) })} />
      </label>
      <label>
        流读取空闲超时（秒）
        <input type="number" min="1" max="300" value={value.idle_timeout_seconds} onChange={(event) => patch({ idle_timeout_seconds: Number(event.target.value) })} />
      </label>
      <label>
        单次任务总超时（秒）
        <input type="number" min="15" max="3600" value={value.task_timeout_seconds} onChange={(event) => patch({ task_timeout_seconds: Number(event.target.value) })} />
      </label>
      <label>
        <input type="checkbox" checked={value.list_depth_infinity} onChange={(event) => patch({ list_depth_infinity: event.target.checked })} />
        Depth: infinity 列举（更快；部分 WebDAV 服务器不支持，默认关闭）
      </label>
    </>
  );
}
