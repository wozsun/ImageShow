import { useRef, useState } from "react";
import { Icon } from "../../components/icon/Icon.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { useAnimatedClose } from "../../hooks/useAnimatedClose.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { storageBackendDisplay, storageTypeLabel } from "../../lib/ui/select-options.js";
import type { S3Settings, StorageBackendAdmin, StorageType, WebdavSettings } from "../../lib/types.js";
import { ActionFeedback, type ActionFeedbackState } from "../../components/feedback/ActionFeedback.js";

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

export function StorageBackendModal({ target, busy, feedback, onClose, onSave, onSetDefault, onTest }: {
  target: StorageBackendAdmin | "new";
  busy: string;
  feedback: ActionFeedbackState | null;
  onClose: () => void;
  onSave: (slug: string, payload: Record<string, unknown>, isCreate: boolean) => Promise<boolean>;
  onSetDefault: (slug: string) => Promise<boolean>;
  onTest: (body: unknown) => void;
}) {
  const creating = target === "new";
  const backend = creating ? null : target;
  const isLocal = backend?.type === "local";
  const [slug, setSlug] = useState(backend?.slug ?? "");
  const [displayName, setDisplayName] = useState(backend?.display_name ?? "");
  const [type, setType] = useState<StorageType>(backend?.type ?? "s3");
  const [s3, setS3] = useState<S3Settings>({ ...emptyS3, ...(backend?.s3 ?? {}), secret_access_key: "" });
  const [webdav, setWebdav] = useState<WebdavSettings>({ ...emptyWebdav, ...(backend?.webdav ?? {}), password: "" });

  const effectiveType: StorageType = creating ? type : backend!.type;
  const isWebdav = effectiveType === "webdav";
  const exit = useAnimatedClose(onClose);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const [lastAction, setLastAction] = useState<"save" | "default" | "test" | null>(null);
  const [isDefaultNow, setIsDefaultNow] = useState(backend?.is_default ?? false);

  const [createdSlug, setCreatedSlug] = useState<string | null>(null);
  const savedOk = lastAction === "save" && feedback?.status === "success";
  // 保存进行中也展示在 header pill（与「保存成功」同处），不再落到卡片下方的 body。
  const saving = lastAction === "save" && feedback?.status === "pending";

  const isCreateForm = creating && createdSlug === null;
  const configPayload = () => (isWebdav ? { webdav } : { s3 });
  const submit = async () => {
    setLastAction("save");
    if (isCreateForm) {
      const ok = await onSave(slug, { slug, display_name: displayName, type: effectiveType, ...configPayload() }, true);
      if (ok) setCreatedSlug(slug);
      return;
    }

    const editSlug = createdSlug ?? backend!.slug;
    await onSave(editSlug, { display_name: displayName, ...(isLocal ? {} : configPayload()) }, false);
  };
  const testBody = () => (creating ? { type: effectiveType, ...configPayload() } : { slug: backend!.slug });
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
          <div className="storage-modal-header-right">
            {saving && <span className="storage-saved-pill is-pending"><Icon name="refresh-line" />正在保存…</span>}
            {savedOk && <span className="storage-saved-pill"><Icon name="check-line" />保存成功</span>}
            <button
              className="icon close pressable"
              type="button"
              title="关闭"
              disabled={Boolean(busy)}
              onClick={() => exit.requestClose()}
            >
              <Icon name="close-line" />
            </button>
          </div>
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
              {isWebdav
                ? <WebdavFields value={webdav} onChange={setWebdav} configured={backend?.webdav.password_configured} />
                : <S3Fields value={s3} onChange={setS3} configured={backend?.s3.secret_access_key_configured} />}
            </>
          )}
          {/* 保存中 / 保存成功 都改由 header pill 展示；body 这里只保留连接测试结果与各类错误（含保存失败）。 */}
          {feedback
            && !(lastAction === "save" && feedback.status !== "error")
            && !(lastAction === "default" && feedback.status === "success")
            && <ActionFeedback feedback={feedback} />}
        </div>
        <OverlayScrollbar targetRef={bodyRef} />
        <footer>
          <div className="storage-modal-left">
            <button
              type="button"
              className="storage-test-button"
              disabled={Boolean(busy)}
              onClick={() => { setLastAction("test"); onTest(testBody()); }}
            >
              <Icon name="flask-line" />连接测试
            </button>
            {!creating && backend!.enabled && (
              <button
                type="button"
                disabled={Boolean(busy) || isDefaultNow}
                onClick={() => { setLastAction("default"); void onSetDefault(backend!.slug).then((ok) => { if (ok) setIsDefaultNow(true); }); }}
              >
                {isDefaultNow ? "已是默认" : "设为默认"}
              </button>
            )}
          </div>
          <div className="modal-footer-actions">
            <button type="button" disabled={Boolean(busy)} onClick={() => exit.requestClose()}>取消</button>
            <button className="button" type="submit" disabled={Boolean(busy) || (isCreateForm && !slug)}>
              <Icon name="save-3-line" />{isCreateForm ? "新建" : "保存"}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function S3Fields({ value, onChange, configured }: { value: S3Settings; onChange: (next: S3Settings) => void; configured?: boolean }) {
  const patch = (next: Partial<S3Settings>) => onChange({ ...value, ...next });
  return (
    <>
      <p className="hint">Secret Key 保存后只显示“已配置”；上传统一经服务器转发到 S3（不使用浏览器直传），无需为存储桶配置 CORS。</p>
      <label>
        Endpoint
        <input value={value.endpoint} onChange={(event) => patch({ endpoint: event.target.value })} placeholder="（https://）s3.example.com" />
      </label>
      <label>
        Region
        <input value={value.region} onChange={(event) => patch({ region: event.target.value })} />
      </label>
      <label>
        Bucket
        <input value={value.bucket} onChange={(event) => patch({ bucket: event.target.value })} />
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
        <input value={value.root_path} onChange={(event) => patch({ root_path: event.target.value })} placeholder="/ 或 /imageshow" />
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

function WebdavFields({ value, onChange, configured }: { value: WebdavSettings; onChange: (next: WebdavSettings) => void; configured?: boolean }) {
  const patch = (next: Partial<WebdavSettings>) => onChange({ ...value, ...next });
  return (
    <>
      <p className="hint">密码保存后只显示“已配置”；上传统一经服务器中转写入 WebDAV。用户名/密码留空则匿名访问。</p>
      <label>
        Base URL
        <input value={value.base_url} onChange={(event) => patch({ base_url: event.target.value })} placeholder="https://dav.example.com/dav" />
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
        <input value={value.root_path} onChange={(event) => patch({ root_path: event.target.value })} placeholder="/ 或 /imageshow" />
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
